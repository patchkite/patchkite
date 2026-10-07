import { DIFF_MANIFEST_FILE_NAME, diffManifests, isIgnoredPath, SIGNATURE_FILE_NAME, type Manifest } from "@patchkite/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Db } from "../db/index.js";
import { binaryBundles, deployments, packageDiffs, packages, type DbBinaryBundle, type DbPackage } from "../db/schema.js";
import type { Env } from "../env.js";
import type { Storage } from "../storage.js";
import { extractZipEntry, scanZipFile, withTempDir, writeZipSubset } from "../zip.js";

/** Folder in the diff zip where patches are stored: `.patchkite-patches/<file path>`. */
export const PATCH_DIR = ".patchkite-patches";

type WorkerResult = { ok: true; patchSize: number; patchDeflated: number; newDeflated: number } | { ok: false; error: string };

/**
 * Builds "bsdiff"-format diffs in the background: large changed files are sent as a
 * binary patch against the same file in a previous release. Only served to SDKs
 * that support it (`client_features=bsdiff`); other SDKs keep using "files" diffs.
 */
export class PatchBuilder {
  private chain: Promise<void> = Promise.resolve();
  private worker?: Worker;

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly env: Env,
    private readonly log: { error: (o: object, msg: string) => void; info: (o: object, msg: string) => void },
  ) {}

  /** Schedule patch generation for a new release (sequentially, one at a time). */
  schedule(pkg: DbPackage) {
    if (!this.env.BSDIFF_ENABLED || this.env.DIFF_HISTORY_DEPTH <= 0) return;
    this.chain = this.chain.then(() =>
      this.build(pkg).catch((err) => this.log.error({ err, label: pkg.label }, "Failed to build bsdiff patch")),
    );
  }

  /** A new binary bundle was registered: build patches for the latest release of each of the app's deployments. */
  scheduleBinary(binary: DbBinaryBundle) {
    if (!this.env.BSDIFF_ENABLED) return;
    this.chain = this.chain.then(async () => {
      try {
        const deps = await this.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.appId, binary.appId));
        for (const dep of deps) {
          const [latest] = await this.db.select().from(packages).where(eq(packages.deploymentId, dep.id)).orderBy(desc(packages.seq)).limit(1);
          if (latest) await this.withPackage(latest, (ctx) => this.binaryPatches(latest, ctx, [binary]));
        }
      } catch (err) {
        this.log.error({ err, binary: binary.fileHash }, "Failed to build bsdiff patch from binary");
      }
    });
  }

  /** Resolves once all scheduled patches are built (used by tests). */
  idle() {
    return this.chain;
  }

  async close() {
    await this.chain;
    await this.worker?.terminate();
    this.worker = undefined;
  }

  private runWorker(job: { oldFile: string; newFile: string; patchFile: string }): Promise<WorkerResult> {
    if (!this.worker) {
      const file = createRequire(import.meta.url).resolve("@patchkite/shared/bsdiff-worker");
      this.worker = new Worker(file);
      this.worker.unref();
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.worker = undefined;
        reject(err);
      };
      worker.once("error", onError);
      worker.once("message", (r: WorkerResult) => {
        worker.off("error", onError);
        resolve(r);
      });
      worker.postMessage(job);
    });
  }

  private async build(pkg: DbPackage) {
    const previous = await this.db
      .select()
      .from(packages)
      .where(and(eq(packages.deploymentId, pkg.deploymentId), sql`${packages.seq} < ${pkg.seq}`))
      .orderBy(desc(packages.seq))
      .limit(this.env.DIFF_HISTORY_DEPTH * 2);
    const minSize = this.env.BSDIFF_MIN_FILE_KB * 1024;
    const maxSize = this.env.BSDIFF_MAX_FILE_MB * 1024 * 1024;

    await this.withPackage(pkg, async (ctx) => {
      const { dir, newZip, newManifest, sizes, signatures } = ctx;
      const seen = new Set([pkg.packageHash]);
      let done = 0;
      for (const prev of previous) {
        if (done >= this.env.DIFF_HISTORY_DEPTH) break;
        if (seen.has(prev.packageHash) || !prev.manifestBlobKey) continue;
        seen.add(prev.packageHash);
        done++;

        const [exists] = await this.db
          .select({ id: packageDiffs.packageId })
          .from(packageDiffs)
          .where(and(eq(packageDiffs.packageId, pkg.id), eq(packageDiffs.fromHash, prev.packageHash), eq(packageDiffs.format, "bsdiff")));
        if (exists) continue;

        const prevManifest = JSON.parse((await this.storage.get(prev.manifestBlobKey)).toString()) as Manifest;
        const { changed, deleted } = diffManifests(prevManifest, newManifest);
        const candidates = changed.filter(
          (p) => prevManifest[p] && !signatures.includes(p) && sizes[p]! >= minSize && sizes[p]! <= maxSize,
        );
        if (!candidates.length) continue;

        const prevZip = path.join(dir, `prev-${prev.packageHash}.zip`);
        await this.storage.download(prev.blobKey, prevZip);
        const patched: string[] = [];
        const extra = new Map<string, Buffer | { file: string }>();
        for (const [i, p] of candidates.entries()) {
          const oldFile = path.join(dir, `old-${i}`);
          const newFile = path.join(dir, `new-${i}`);
          const patchFile = path.join(dir, `patch-${prev.packageHash}-${i}`);
          await extractZipEntry(prevZip, p, oldFile);
          await extractZipEntry(newZip, p, newFile);
          const r = await this.runWorker({ oldFile, newFile, patchFile });
          if (!r.ok) throw new Error(r.error);
          // Only use the patch if it is clearly smaller than the whole file after compression.
          if (r.patchDeflated < r.newDeflated * 0.7) {
            patched.push(p);
            extra.set(`${PATCH_DIR}/${p}`, { file: patchFile });
          }
        }
        if (!patched.length) continue;

        const names = [...new Set([...changed.filter((p) => !patched.includes(p)), ...signatures])];
        extra.set(DIFF_MANIFEST_FILE_NAME, Buffer.from(JSON.stringify({ deletedFiles: deleted, patchedFiles: patched })));
        const out = path.join(dir, `diff-${prev.packageHash}.zip`);
        await writeZipSubset(newZip, names, extra, out);
        const { size } = await stat(out);

        const [files] = await this.db
          .select({ size: packageDiffs.size })
          .from(packageDiffs)
          .where(and(eq(packageDiffs.packageId, pkg.id), eq(packageDiffs.fromHash, prev.packageHash), eq(packageDiffs.format, "files")));
        if (size >= (files?.size ?? pkg.size)) continue;

        const blobKey = `diffs/${pkg.packageHash}/${prev.packageHash}.bsdiff.zip`;
        await this.storage.putFile(blobKey, out, "application/zip");
        await this.db
          .insert(packageDiffs)
          .values({ packageId: pkg.id, fromHash: prev.packageHash, format: "bsdiff", blobKey, size })
          .onConflictDoNothing();
        this.log.info(
          { label: pkg.label, from: prev.label, size, filesDiffSize: files?.size ?? null, patched },
          "bsdiff patch built",
        );
      }
      await this.binaryPatches(pkg, ctx);
    });
  }

  /** Download the package to a temp folder and prepare its manifest. */
  private withPackage(pkg: DbPackage, fn: (ctx: PackageContext) => Promise<void>) {
    return withTempDir(async (dir) => {
      const newZip = path.join(dir, "new.zip");
      await this.storage.download(pkg.blobKey, newZip);
      const { manifest: newManifest, sizes } = await scanZipFile(newZip);
      const signatures = Object.keys(newManifest).filter((p) => p.split("/").pop() === SIGNATURE_FILE_NAME);
      await fn({ dir, newZip, newManifest, sizes, signatures });
    });
  }

  /**
   * Patches for devices still running the store binary: the binary's bundled JS (registered from CI)
   * is the base for patching the package's bundle; other files are sent whole. Diff key: `binary:<bundle hash>`.
   */
  private async binaryPatches(pkg: DbPackage, ctx: PackageContext, only?: DbBinaryBundle[]) {
    const [dep] = await this.db.select({ appId: deployments.appId }).from(deployments).where(eq(deployments.id, pkg.deploymentId));
    if (!dep) return;
    const bins =
      only ??
      (await this.db
        .select()
        .from(binaryBundles)
        .where(eq(binaryBundles.appId, dep.appId))
        .orderBy(desc(binaryBundles.createdAt))
        .limit(this.env.DIFF_HISTORY_DEPTH));
    const { dir, newZip, newManifest, sizes, signatures } = ctx;

    for (const bin of bins) {
      const fromHash = `binary:${bin.fileHash}`;
      const target = Object.keys(newManifest).find((p) => !isIgnoredPath(p) && p.split("/").pop() === bin.fileName);
      if (!target || sizes[target]! > this.env.BSDIFF_MAX_FILE_MB * 1024 * 1024) continue;
      const [exists] = await this.db
        .select({ id: packageDiffs.packageId })
        .from(packageDiffs)
        .where(and(eq(packageDiffs.packageId, pkg.id), eq(packageDiffs.fromHash, fromHash), eq(packageDiffs.format, "bsdiff")));
      if (exists) continue;

      const extra = new Map<string, Buffer | { file: string }>();
      const patched: string[] = [];
      // Bundle identical to the binary's: the device just copies its built-in bundle.
      if (newManifest[target] !== bin.fileHash) {
        const oldFile = path.join(dir, `bin-${bin.fileHash}`);
        const newFile = path.join(dir, `bin-new-${bin.fileHash}`);
        const patchFile = path.join(dir, `bin-patch-${bin.fileHash}`);
        await this.storage.download(bin.blobKey, oldFile);
        await extractZipEntry(newZip, target, newFile);
        const r = await this.runWorker({ oldFile, newFile, patchFile });
        if (!r.ok) throw new Error(r.error);
        if (r.patchDeflated >= r.newDeflated * 0.7) continue;
        patched.push(target);
        extra.set(`${PATCH_DIR}/${target}`, { file: patchFile });
      }
      const names = Object.keys(newManifest).filter((p) => p !== target || signatures.includes(p));
      extra.set(DIFF_MANIFEST_FILE_NAME, Buffer.from(JSON.stringify({ deletedFiles: [], patchedFiles: patched, binaryBase: target })));
      const out = path.join(dir, `diff-binary-${bin.fileHash}.zip`);
      await writeZipSubset(newZip, names, extra, out);
      const { size } = await stat(out);
      if (size >= pkg.size * 0.9) continue;

      const blobKey = `diffs/${pkg.packageHash}/binary-${bin.fileHash}.bsdiff.zip`;
      await this.storage.putFile(blobKey, out, "application/zip");
      await this.db.insert(packageDiffs).values({ packageId: pkg.id, fromHash, format: "bsdiff", blobKey, size }).onConflictDoNothing();
      this.log.info({ label: pkg.label, binary: bin.fileHash.slice(0, 12), size, packageSize: pkg.size }, "bsdiff patch from binary built");
    }
  }
}

interface PackageContext {
  dir: string;
  newZip: string;
  newManifest: Manifest;
  sizes: Record<string, number>;
  signatures: string[];
}
