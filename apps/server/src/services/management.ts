import {
  DIFF_MANIFEST_FILE_NAME,
  diffManifests,
  generateDeploymentKey,
  isValidVersionRange,
  packageHashFromManifest,
  sha256,
  sha256File,
  type Manifest,
  type OS,
  type Package,
  type PatchMetadata,
  type Platform,
  type ReleaseMetadata,
} from "@patchkite/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  accessKeys,
  apps,
  binaryBundles,
  collaborators,
  deployments,
  metrics,
  metricsDaily,
  packageDiffs,
  packages,
  users,
  type DbApp,
  type DbBinaryBundle,
  type DbDeployment,
  type DbPackage,
  type DbUser,
} from "../db/schema.js";
import type { Env } from "../env.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors.js";
import type { Storage } from "../storage.js";
import type { PatchBuilder } from "./patches.js";
import { isZipFile, scanZipFile, withTempDir, writeZipSubset, ZipLimitError } from "../zip.js";
import { stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DEPLOYMENTS = ["Staging", "Production"];

export class ManagementService {
  /** Background binary patch builder (optional; set by buildApp). */
  patches?: PatchBuilder;

  constructor(
    readonly db: Db,
    readonly storage: Storage,
    readonly env: Env,
  ) {}

  // ---------- Serialization ----------

  downloadUrl(blobKey: string) {
    return `${this.env.PUBLIC_URL.replace(/\/$/, "")}/v1/public/download/${blobKey}`;
  }

  async toPackage(p: DbPackage): Promise<Package> {
    const diffs = await this.db.select().from(packageDiffs).where(eq(packageDiffs.packageId, p.id));
    return {
      label: p.label,
      appVersion: p.appVersion,
      description: p.description,
      isDisabled: p.isDisabled,
      isMandatory: p.isMandatory,
      rollout: p.rollout,
      packageHash: p.packageHash,
      blobUrl: this.downloadUrl(p.blobKey),
      size: p.size,
      uploadTime: p.uploadTime.getTime(),
      releaseMethod: p.releaseMethod,
      releasedBy: p.releasedBy,
      originalLabel: p.originalLabel,
      originalDeployment: p.originalDeployment,
      engineRevision: p.engineRevision,
      diffPackageMap: Object.fromEntries(
        diffs.filter((d) => d.format === "files").map((d) => [d.fromHash, { size: d.size, url: this.downloadUrl(d.blobKey) }]),
      ),
    };
  }

  // ---------- Apps ----------

  async listApps(user: DbUser) {
    const rows = await this.db
      .select({ app: apps })
      .from(collaborators)
      .innerJoin(apps, eq(apps.id, collaborators.appId))
      .where(eq(collaborators.userId, user.id))
      .orderBy(asc(apps.name));
    return Promise.all(rows.map((r) => this.serializeApp(r.app)));
  }

  async serializeApp(app: DbApp) {
    const collabs = await this.db
      .select({ email: users.email, permission: collaborators.permission })
      .from(collaborators)
      .innerJoin(users, eq(users.id, collaborators.userId))
      .where(eq(collaborators.appId, app.id));
    const deps = await this.db
      .select({ name: deployments.name })
      .from(deployments)
      .where(eq(deployments.appId, app.id))
      .orderBy(asc(deployments.id));
    return {
      name: app.name,
      os: app.os as OS,
      platform: app.platform as Platform,
      collaborators: Object.fromEntries(collabs.map((c) => [c.email, { permission: c.permission }])),
      deployments: deps.map((d) => d.name),
    };
  }

  async getApp(user: DbUser, name: string, requireOwner = false): Promise<DbApp> {
    const [row] = await this.db
      .select({ app: apps, permission: collaborators.permission })
      .from(collaborators)
      .innerJoin(apps, eq(apps.id, collaborators.appId))
      .where(and(eq(collaborators.userId, user.id), eq(apps.name, name)));
    if (!row) throw notFound(`App "${name}"`);
    if (requireOwner && row.permission !== "Owner") throw forbidden("Only the app owner can perform this action");
    return row.app;
  }

  async createApp(user: DbUser, input: { name: string; os: OS; platform: Platform; manuallyProvisionDeployments?: boolean }) {
    const existing = await this.db
      .select({ id: apps.id })
      .from(collaborators)
      .innerJoin(apps, eq(apps.id, collaborators.appId))
      .where(and(eq(collaborators.userId, user.id), eq(apps.name, input.name)));
    if (existing.length) throw conflict(`App "${input.name}" already exists`);
    const [app] = await this.db.insert(apps).values({ name: input.name, os: input.os, platform: input.platform }).returning();
    await this.db.insert(collaborators).values({ appId: app!.id, userId: user.id, permission: "Owner" });
    if (!input.manuallyProvisionDeployments) {
      for (const name of DEFAULT_DEPLOYMENTS) await this.createDeployment(user, app!.name, name);
    }
    return this.serializeApp(app!);
  }

  async renameApp(user: DbUser, name: string, newName: string) {
    const app = await this.getApp(user, name, true);
    const clash = await this.listApps(user);
    if (clash.some((a) => a.name === newName)) throw conflict(`App "${newName}" already exists`);
    await this.db.update(apps).set({ name: newName }).where(eq(apps.id, app.id));
  }

  async removeApp(user: DbUser, name: string) {
    const app = await this.getApp(user, name, true);
    await this.db.delete(apps).where(eq(apps.id, app.id));
  }

  async transferApp(user: DbUser, name: string, email: string) {
    const app = await this.getApp(user, name, true);
    const target = await this.userByEmail(email);
    await this.db
      .insert(collaborators)
      .values({ appId: app.id, userId: target.id, permission: "Owner" })
      .onConflictDoUpdate({ target: [collaborators.appId, collaborators.userId], set: { permission: "Owner" } });
    await this.db
      .update(collaborators)
      .set({ permission: "Collaborator" })
      .where(and(eq(collaborators.appId, app.id), eq(collaborators.userId, user.id)));
  }

  // ---------- Collaborators ----------

  async userByEmail(email: string) {
    const [u] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!u) throw notFound(`User "${email}"`);
    return u;
  }

  async addCollaborator(user: DbUser, appName: string, email: string) {
    const app = await this.getApp(user, appName, true);
    const target = await this.userByEmail(email);
    await this.db
      .insert(collaborators)
      .values({ appId: app.id, userId: target.id, permission: "Collaborator" })
      .onConflictDoNothing();
  }

  async removeCollaborator(user: DbUser, appName: string, email: string) {
    const app = await this.getApp(user, appName);
    const target = await this.userByEmail(email);
    // Collaborators may remove themselves; otherwise the caller must be the owner.
    if (target.id !== user.id) await this.getApp(user, appName, true);
    const [row] = await this.db
      .select()
      .from(collaborators)
      .where(and(eq(collaborators.appId, app.id), eq(collaborators.userId, target.id)));
    if (row?.permission === "Owner") throw badRequest("The owner cannot be removed. Use `app transfer`.");
    await this.db.delete(collaborators).where(and(eq(collaborators.appId, app.id), eq(collaborators.userId, target.id)));
  }

  // ---------- Deployments ----------

  async getDeployment(user: DbUser, appName: string, name: string) {
    const app = await this.getApp(user, appName);
    const [dep] = await this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.appId, app.id), eq(deployments.name, name)));
    if (!dep) throw notFound(`Deployment "${name}"`);
    return { app, dep };
  }

  async history(depId: number) {
    return this.db.select().from(packages).where(eq(packages.deploymentId, depId)).orderBy(asc(packages.seq));
  }

  async latestPackage(depId: number) {
    const [p] = await this.db
      .select()
      .from(packages)
      .where(eq(packages.deploymentId, depId))
      .orderBy(desc(packages.seq))
      .limit(1);
    return p;
  }

  async serializeDeployment(dep: DbDeployment) {
    const latest = await this.latestPackage(dep.id);
    return { name: dep.name, key: dep.key, package: latest ? await this.toPackage(latest) : null };
  }

  async listDeployments(user: DbUser, appName: string) {
    const app = await this.getApp(user, appName);
    const deps = await this.db.select().from(deployments).where(eq(deployments.appId, app.id)).orderBy(asc(deployments.id));
    return Promise.all(deps.map((d) => this.serializeDeployment(d)));
  }

  async createDeployment(user: DbUser, appName: string, name: string, key?: string) {
    const app = await this.getApp(user, appName, true);
    const [clash] = await this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.appId, app.id), eq(deployments.name, name)));
    if (clash) throw conflict(`Deployment "${name}" already exists`);
    if (key) {
      const [taken] = await this.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.key, key));
      if (taken) throw conflict("Deployment key is already in use");
    }
    const [dep] = await this.db
      .insert(deployments)
      .values({ appId: app.id, name, key: key ?? generateDeploymentKey() })
      .returning();
    return this.serializeDeployment(dep!);
  }

  async renameDeployment(user: DbUser, appName: string, name: string, newName: string) {
    const { app, dep } = await this.getDeployment(user, appName, name);
    await this.getApp(user, appName, true);
    const [clash] = await this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.appId, app.id), eq(deployments.name, newName)));
    if (clash) throw conflict(`Deployment "${newName}" already exists`);
    await this.db.update(deployments).set({ name: newName }).where(eq(deployments.id, dep.id));
  }

  async removeDeployment(user: DbUser, appName: string, name: string) {
    const { dep } = await this.getDeployment(user, appName, name);
    await this.getApp(user, appName, true);
    await this.db.delete(deployments).where(eq(deployments.id, dep.id));
  }

  async clearHistory(user: DbUser, appName: string, name: string) {
    const { dep } = await this.getDeployment(user, appName, name);
    await this.getApp(user, appName, true);
    await this.db.delete(packages).where(eq(packages.deploymentId, dep.id));
    await this.db.delete(metrics).where(eq(metrics.deploymentId, dep.id));
    await this.db.delete(metricsDaily).where(eq(metricsDaily.deploymentId, dep.id));
  }

  // ---------- Release ----------

  private async ensureCanRelease(dep: DbDeployment, packageHash: string) {
    const latest = await this.latestPackage(dep.id);
    if (latest && latest.packageHash === packageHash && !latest.isDisabled) {
      throw conflict(
        "Package not released because its contents are identical to the latest release in this deployment.",
      );
    }
    if (latest && latest.rollout != null && latest.rollout < 100 && !latest.isDisabled) {
      throw conflict("A release with an unfinished rollout exists. Patch its rollout to 100% or disable the previous release first.");
    }
    return latest;
  }

  private async nextSeq(depId: number) {
    const [row] = await this.db
      .select({ max: sql<number>`coalesce(max(${packages.seq}), 0)` })
      .from(packages)
      .where(eq(packages.deploymentId, depId));
    return Number(row?.max ?? 0) + 1;
  }

  async release(user: DbUser, appName: string, depName: string, uploadFile: string, meta: ReleaseMetadata) {
    const { dep } = await this.getDeployment(user, appName, depName);
    if (!isValidVersionRange(meta.appVersion)) throw badRequest(`Target binary version "${meta.appVersion}" is not a valid semver range`);
    if (!(await isZipFile(uploadFile))) throw badRequest("Package must be a zip file");

    const { manifest } = await this.scanPackage(uploadFile);
    if (Object.keys(manifest).length === 0) throw badRequest("Package is empty");
    const packageHash = packageHashFromManifest(manifest);

    await this.ensureCanRelease(dep, packageHash);

    const blobKey = `packages/${packageHash}.zip`;
    const manifestBlobKey = `manifests/${packageHash}.json`;
    await this.storage.putFile(blobKey, uploadFile, "application/zip");
    await this.storage.put(manifestBlobKey, Buffer.from(JSON.stringify(manifest)), "application/json");

    const seq = await this.nextSeq(dep.id);
    const [pkg] = await this.db
      .insert(packages)
      .values({
        deploymentId: dep.id,
        seq,
        label: `v${seq}`,
        appVersion: meta.appVersion,
        description: meta.description ?? "",
        isDisabled: meta.isDisabled ?? false,
        isMandatory: meta.isMandatory ?? false,
        rollout: meta.rollout ?? null,
        packageHash,
        blobKey,
        manifestBlobKey,
        size: (await stat(uploadFile)).size,
        releaseMethod: "Upload",
        releasedBy: user.email,
        engineRevision: meta.engineRevision ?? null,
      })
      .returning();
    await this.generateDiffs(pkg!, uploadFile, manifest);
    this.patches?.schedule(pkg!);
    return this.toPackage(pkg!);
  }

  private async scanPackage(file: string) {
    try {
      return await scanZipFile(file, { maxUncompressedSize: this.env.MAX_UNCOMPRESSED_SIZE_MB * 1024 * 1024 });
    } catch (e) {
      if (e instanceof ZipLimitError) throw new HttpError(413, e.message);
      throw badRequest(`Invalid package zip: ${(e as Error).message}`);
    }
  }

  /**
   * Build package diffs from the previous N releases in the same deployment to the new release.
   * Diff = changed files + `patchkite-diff.json` listing deleted files.
   * Zips are read and written via temp files so large packages aren't loaded into memory.
   */
  async generateDiffs(pkg: DbPackage, zipFile?: string, manifest?: Manifest) {
    if (this.env.DIFF_HISTORY_DEPTH <= 0) return;
    const previous = await this.db
      .select()
      .from(packages)
      .where(and(eq(packages.deploymentId, pkg.deploymentId), sql`${packages.seq} < ${pkg.seq}`))
      .orderBy(desc(packages.seq))
      .limit(this.env.DIFF_HISTORY_DEPTH * 2);
    if (!previous.some((p) => p.packageHash !== pkg.packageHash && p.manifestBlobKey)) return;

    await withTempDir(async (dir) => {
      if (!zipFile) {
        zipFile = path.join(dir, "package.zip");
        await this.storage.download(pkg.blobKey, zipFile);
      }
      manifest ??= (await scanZipFile(zipFile)).manifest;
      const signatures = Object.keys(manifest).filter((p) => p.split("/").pop() === ".patchkiterelease");

      const seen = new Set<string>([pkg.packageHash]);
      let created = 0;
      for (const prev of previous) {
        if (created >= this.env.DIFF_HISTORY_DEPTH) break;
        if (seen.has(prev.packageHash) || !prev.manifestBlobKey) continue;
        seen.add(prev.packageHash);
        const prevManifest = JSON.parse((await this.storage.get(prev.manifestBlobKey)).toString()) as Manifest;
        const { changed, deleted } = diffManifests(prevManifest, manifest);
        const names = [...new Set([...changed, ...signatures])];
        const out = path.join(dir, `diff-${prev.packageHash}.zip`);
        await writeZipSubset(zipFile, names, new Map([[DIFF_MANIFEST_FILE_NAME, Buffer.from(JSON.stringify({ deletedFiles: deleted }))]]), out);
        const { size } = await stat(out);
        // A diff is useless if it isn't smaller than the full package.
        if (size >= pkg.size) continue;
        const blobKey = `diffs/${pkg.packageHash}/${prev.packageHash}.zip`;
        await this.storage.putFile(blobKey, out, "application/zip");
        await this.db
          .insert(packageDiffs)
          .values({ packageId: pkg.id, fromHash: prev.packageHash, blobKey, size })
          .onConflictDoNothing();
        created++;
      }
    });
  }

  async findPackage(depId: number, label?: string) {
    if (!label) {
      const latest = await this.latestPackage(depId);
      if (!latest) throw notFound("Release");
      return latest;
    }
    const [p] = await this.db.select().from(packages).where(and(eq(packages.deploymentId, depId), eq(packages.label, label)));
    if (!p) throw notFound(`Release "${label}"`);
    return p;
  }

  async patchRelease(user: DbUser, appName: string, depName: string, patch: PatchMetadata) {
    const { dep } = await this.getDeployment(user, appName, depName);
    const pkg = await this.findPackage(dep.id, patch.label);
    if (patch.appVersion !== undefined && !isValidVersionRange(patch.appVersion)) {
      throw badRequest(`Target binary version "${patch.appVersion}" is not a valid semver range`);
    }
    if (patch.rollout != null) {
      if (pkg.rollout == null || pkg.rollout >= 100) throw badRequest("Rollout can only be changed on a release whose rollout is not finished");
      if (patch.rollout < pkg.rollout) throw badRequest(`Rollout cannot be decreased (currently ${pkg.rollout}%)`);
    }
    const set: Partial<DbPackage> = {};
    if (patch.appVersion !== undefined) set.appVersion = patch.appVersion;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.isMandatory !== undefined) set.isMandatory = patch.isMandatory;
    if (patch.isDisabled !== undefined) set.isDisabled = patch.isDisabled;
    if (patch.rollout !== undefined) set.rollout = patch.rollout === 100 ? null : patch.rollout;
    if (Object.keys(set).length === 0) throw badRequest("No changes provided");
    const [updated] = await this.db.update(packages).set(set).where(eq(packages.id, pkg.id)).returning();
    return this.toPackage(updated!);
  }

  async promote(user: DbUser, appName: string, srcName: string, destName: string, patch: PatchMetadata = {}) {
    const { dep: src } = await this.getDeployment(user, appName, srcName);
    const { dep: dest } = await this.getDeployment(user, appName, destName);
    const source = await this.findPackage(src.id, patch.label);
    await this.ensureCanRelease(dest, source.packageHash);
    const appVersion = patch.appVersion ?? source.appVersion;
    if (!isValidVersionRange(appVersion)) throw badRequest(`Target binary version "${appVersion}" is invalid`);

    const seq = await this.nextSeq(dest.id);
    const [pkg] = await this.db
      .insert(packages)
      .values({
        deploymentId: dest.id,
        seq,
        label: `v${seq}`,
        appVersion,
        description: patch.description ?? source.description,
        isDisabled: patch.isDisabled ?? source.isDisabled,
        isMandatory: patch.isMandatory ?? source.isMandatory,
        rollout: patch.rollout === 100 ? null : (patch.rollout ?? null),
        packageHash: source.packageHash,
        blobKey: source.blobKey,
        manifestBlobKey: source.manifestBlobKey,
        size: source.size,
        releaseMethod: "Promote",
        releasedBy: user.email,
        originalLabel: source.label,
        originalDeployment: src.name,
        engineRevision: source.engineRevision,
      })
      .returning();
    await this.generateDiffs(pkg!);
    this.patches?.schedule(pkg!);
    return this.toPackage(pkg!);
  }

  async rollback(user: DbUser, appName: string, depName: string, targetLabel?: string) {
    const { dep } = await this.getDeployment(user, appName, depName);
    const history = await this.history(dep.id);
    const latest = history.at(-1);
    if (!latest) throw notFound("Release");
    let target: DbPackage | undefined;
    if (targetLabel) {
      target = history.find((p) => p.label === targetLabel);
      if (!target) throw notFound(`Release "${targetLabel}"`);
      if (target.packageHash === latest.packageHash) throw conflict("Target release is the same as the latest release");
    } else {
      target = [...history].reverse().find((p) => p.seq < latest.seq && p.packageHash !== latest.packageHash);
      if (!target) throw conflict("No previous release to roll back to");
    }
    if (target.appVersion !== latest.appVersion) {
      throw conflict(`Can only roll back to a release with the same target binary version (${latest.appVersion})`);
    }
    const seq = latest.seq + 1;
    const [pkg] = await this.db
      .insert(packages)
      .values({
        deploymentId: dep.id,
        seq,
        label: `v${seq}`,
        appVersion: target.appVersion,
        description: target.description,
        isDisabled: false,
        isMandatory: target.isMandatory,
        rollout: null,
        packageHash: target.packageHash,
        blobKey: target.blobKey,
        manifestBlobKey: target.manifestBlobKey,
        size: target.size,
        releaseMethod: "Rollback",
        releasedBy: user.email,
        originalLabel: target.label,
        engineRevision: target.engineRevision,
      })
      .returning();
    await this.generateDiffs(pkg!);
    this.patches?.schedule(pkg!);
    return this.toPackage(pkg!);
  }

  async getMetrics(user: DbUser, appName: string, depName: string) {
    const { dep } = await this.getDeployment(user, appName, depName);
    const rows = await this.db.select().from(metrics).where(eq(metrics.deploymentId, dep.id));
    return Object.fromEntries(
      rows.map((r) => [r.label, { active: r.active, downloaded: r.downloaded, installed: r.installed, failed: r.failed }]),
    );
  }

  /** Events per day (UTC) over the last `days` days, including days without events (value 0). */
  async getDailyMetrics(user: DbUser, appName: string, depName: string, days: number, label?: string) {
    const { dep } = await this.getDeployment(user, appName, depName);
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const conds = [eq(metricsDaily.deploymentId, dep.id), sql`${metricsDaily.day} >= ${since}`];
    if (label) conds.push(eq(metricsDaily.label, label));
    const rows = await this.db
      .select({
        day: metricsDaily.day,
        downloaded: sql<number>`sum(${metricsDaily.downloaded})::int`,
        installed: sql<number>`sum(${metricsDaily.installed})::int`,
        failed: sql<number>`sum(${metricsDaily.failed})::int`,
      })
      .from(metricsDaily)
      .where(and(...conds))
      .groupBy(metricsDaily.day);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    return Array.from({ length: days }, (_, i) => {
      const day = new Date(Date.parse(since) + i * 86_400_000).toISOString().slice(0, 10);
      const r = byDay.get(day);
      return { day, downloaded: r?.downloaded ?? 0, installed: r?.installed ?? 0, failed: r?.failed ?? 0 };
    });
  }

  // ---------- Binary bundles (patch base for the first update) ----------

  async addBinary(user: DbUser, appName: string, file: string, meta: { fileName: string; appVersion?: string }) {
    const app = await this.getApp(user, appName);
    if (app.platform !== "react-native") throw badRequest("Binary bundles are only for React Native apps");
    const fileHash = await sha256File(file);
    const [exists] = await this.db
      .select()
      .from(binaryBundles)
      .where(and(eq(binaryBundles.appId, app.id), eq(binaryBundles.fileHash, fileHash)));
    if (exists) return { binary: this.serializeBinary(exists), created: false };
    const blobKey = `binaries/${fileHash}`;
    await this.storage.putFile(blobKey, file, "application/octet-stream");
    const [row] = await this.db
      .insert(binaryBundles)
      .values({
        appId: app.id,
        fileName: meta.fileName,
        fileHash,
        appVersion: meta.appVersion ?? null,
        blobKey,
        size: (await stat(file)).size,
        createdBy: user.email,
      })
      .returning();
    this.patches?.scheduleBinary(row!);
    return { binary: this.serializeBinary(row!), created: true };
  }

  async listBinaries(user: DbUser, appName: string) {
    const app = await this.getApp(user, appName);
    const rows = await this.db.select().from(binaryBundles).where(eq(binaryBundles.appId, app.id)).orderBy(desc(binaryBundles.createdAt));
    return rows.map((r) => this.serializeBinary(r));
  }

  async removeBinary(user: DbUser, appName: string, hashPrefix: string) {
    const app = await this.getApp(user, appName, true);
    const rows = await this.db.select().from(binaryBundles).where(eq(binaryBundles.appId, app.id));
    const matches = rows.filter((r) => r.fileHash.startsWith(hashPrefix.toLowerCase()));
    if (matches.length !== 1) throw matches.length ? badRequest("Ambiguous hash, use a longer prefix") : notFound(`Binary bundle "${hashPrefix}"`);
    await this.db.delete(binaryBundles).where(eq(binaryBundles.id, matches[0]!.id));
    // Diffs based on this binary are no longer useful; their blobs are cleaned up by GC.
    await this.db.delete(packageDiffs).where(eq(packageDiffs.fromHash, `binary:${matches[0]!.fileHash}`));
  }

  private serializeBinary(r: DbBinaryBundle) {
    return {
      fileName: r.fileName,
      fileHash: r.fileHash,
      appVersion: r.appVersion,
      size: r.size,
      createdBy: r.createdBy,
      createdTime: r.createdAt.getTime(),
    };
  }

  // ---------- Access keys ----------

  async listAccessKeys(user: DbUser) {
    const rows = await this.db.select().from(accessKeys).where(eq(accessKeys.userId, user.id)).orderBy(asc(accessKeys.id));
    return rows.map((k) => ({
      name: k.name,
      friendlyName: k.friendlyName,
      createdBy: k.createdBy,
      createdTime: k.createdAt.getTime(),
      expires: k.expiresAt.getTime(),
      isSession: k.isSession,
    }));
  }

  async findAccessKey(user: DbUser, nameOrFriendly: string) {
    const rows = await this.db.select().from(accessKeys).where(eq(accessKeys.userId, user.id));
    const key = rows.find((k) => k.name === nameOrFriendly) ?? rows.find((k) => k.friendlyName === nameOrFriendly);
    if (!key) throw notFound(`Access key "${nameOrFriendly}"`);
    return key;
  }

  async removeAccessKey(user: DbUser, nameOrFriendly: string) {
    const key = await this.findAccessKey(user, nameOrFriendly);
    await this.db.delete(accessKeys).where(eq(accessKeys.id, key.id));
  }

  async patchAccessKey(user: DbUser, nameOrFriendly: string, patch: { friendlyName?: string; ttl?: number }) {
    const key = await this.findAccessKey(user, nameOrFriendly);
    await this.db
      .update(accessKeys)
      .set({
        ...(patch.friendlyName ? { friendlyName: patch.friendlyName } : {}),
        ...(patch.ttl ? { expiresAt: new Date(Date.now() + patch.ttl) } : {}),
      })
      .where(eq(accessKeys.id, key.id));
  }

  async removeSessions(user: DbUser, createdBy?: string) {
    const conds = [eq(accessKeys.userId, user.id), eq(accessKeys.isSession, true)];
    if (createdBy) conds.push(eq(accessKeys.createdBy, createdBy));
    await this.db.delete(accessKeys).where(and(...conds));
  }
}

