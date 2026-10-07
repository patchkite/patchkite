import { reportDeploySchema, reportDownloadSchema, type UpdateCheckResponse } from "@patchkite/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deployments, metrics, metricsDaily, packageDiffs, packages } from "../db/schema.js";
import { notFound } from "../errors.js";
import { decideUpdate } from "../services/acquisition.js";
import type { ManagementService } from "../services/management.js";

const updateCheckQuery = z.object({
  deployment_key: z.string().min(1).max(128),
  app_version: z.string().min(1).max(64),
  package_hash: z.string().max(128).optional(),
  label: z.string().max(64).optional(),
  client_unique_id: z.string().max(128).optional(),
  is_companion: z.stringbool().optional(),
  /** Hash of the binary's built-in bundle (device with no update installed yet), for patches from the binary. */
  binary_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Comma-separated SDK features. "bsdiff" = can apply binary patches. */
  client_features: z.string().max(200).optional(),
  /** Flutter only: engine revision of the installed binary. */
  engine_revision: z.string().max(128).optional(),
});

/**
 * Public endpoints for the SDKs (`/v1/public/...`).
 */
export async function acquisitionRoutes(app: FastifyInstance, svc: ManagementService) {
  const db = svc.db;
  const base = "/v1/public";

  const bumpMetric = async (deploymentId: number, label: string, field: "active" | "downloaded" | "installed" | "failed", delta = 1) => {
    await db
      .insert(metrics)
      .values({ deploymentId, label, [field]: Math.max(delta, 0) })
      .onConflictDoUpdate({
        target: [metrics.deploymentId, metrics.label],
        set: { [field]: sql`greatest(${metrics[field]} + ${delta}, 0)` },
      });
    // Events (not the "active" gauge) are also recorded per day for dashboard charts.
    if (field !== "active" && delta > 0) {
      await db
        .insert(metricsDaily)
        .values({ deploymentId, label, day: sql`(now() at time zone 'utc')::date`, [field]: delta })
        .onConflictDoUpdate({
          target: [metricsDaily.deploymentId, metricsDaily.label, metricsDaily.day],
          set: { [field]: sql`${metricsDaily[field]} + ${delta}` },
        });
    }
  };

  const depByKey = async (key: string) => {
    const [dep] = await db.select().from(deployments).where(eq(deployments.key, key));
    if (!dep) throw notFound("Deployment key");
    return dep;
  };

  app.get(`${base}/update_check`, async (req) => {
    const q = updateCheckQuery.parse(req.query);
    const dep = await depByKey(q.deployment_key);
    const history = await db.select().from(packages).where(eq(packages.deploymentId, dep.id)).orderBy(asc(packages.seq));
    const decision = decideUpdate(history, {
      appVersion: q.app_version,
      packageHash: q.package_hash,
      label: q.label,
      clientUniqueId: q.client_unique_id,
      isCompanion: q.is_companion,
      engineRevision: q.engine_revision,
    });

    if (decision.kind === "none") {
      return {
        update_info: {
          is_available: false,
          is_mandatory: false,
          should_run_binary_version: decision.shouldRunBinaryVersion,
          update_app_version: decision.updateAppVersion,
          target_binary_range: decision.targetBinaryRange,
          app_version: q.app_version,
        },
      } satisfies UpdateCheckResponse;
    }

    const pkg = decision.package;
    let downloadKey = pkg.blobKey;
    let size = pkg.size;
    let isDiff = false;
    const supportsPatch = q.client_features?.split(",").includes("bsdiff") ?? false;
    // Devices on the binary can only use binary-based diffs (always bsdiff format).
    const fromHash = q.package_hash ?? (q.binary_hash && supportsPatch ? `binary:${q.binary_hash}` : undefined);
    if (fromHash) {
      const formats: ("files" | "bsdiff")[] = supportsPatch ? ["files", "bsdiff"] : ["files"];
      const diffs = await db
        .select()
        .from(packageDiffs)
        .where(and(eq(packageDiffs.packageId, pkg.id), eq(packageDiffs.fromHash, fromHash), inArray(packageDiffs.format, formats)));
      // Pick the smallest diff this SDK can apply.
      const diff = diffs.sort((a, b) => a.size - b.size)[0];
      if (diff) {
        downloadKey = diff.blobKey;
        size = diff.size;
        isDiff = true;
      }
    }
    return {
      update_info: {
        is_available: true,
        is_mandatory: decision.isMandatory,
        should_run_binary_version: false,
        update_app_version: false,
        target_binary_range: pkg.appVersion,
        app_version: q.app_version,
        download_url: svc.downloadUrl(downloadKey),
        package_hash: pkg.packageHash,
        label: pkg.label,
        package_size: size,
        description: pkg.description,
        is_diff: isDiff,
      },
    } satisfies UpdateCheckResponse;
  });

  app.get<{ Params: { "*": string } }>(`${base}/download/*`, async (req, reply) => {
    const key = req.params["*"];
    if (!/^(packages|diffs)\/[\w/.-]+\.zip$/.test(key) || key.includes("..")) throw notFound("Blob");
    const presigned = svc.env.BLOB_DOWNLOAD_MODE === "redirect" ? await svc.storage.presignedUrl(key) : null;
    if (presigned) return reply.redirect(presigned);
    reply.header("content-type", "application/zip");
    return reply.send(await svc.storage.stream(key));
  });

  // Metrics are only recorded for labels that actually exist, so holders of a deployment key
  // (embedded in the app, hence public) can't flood the metrics table with fake labels.
  const labelExists = async (deploymentId: number, label: string) => {
    const [row] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.deploymentId, deploymentId), eq(packages.label, label)));
    return !!row;
  };

  app.post(`${base}/report_status/deploy`, async (req) => {
    const body = reportDeploySchema.parse(req.body);
    const dep = await depByKey(body.deployment_key);
    if (body.label && !(await labelExists(dep.id, body.label))) return { ok: true };
    if (!body.label) {
      // Stock binary running for the first time (or back on the binary after a rollback).
      await bumpMetric(dep.id, body.app_version, "active");
    } else if (body.status === "DeploymentFailed") {
      await bumpMetric(dep.id, body.label, "failed");
    } else {
      await bumpMetric(dep.id, body.label, "installed");
      await bumpMetric(dep.id, body.label, "active");
    }
    if (body.previous_label_or_app_version && body.status !== "DeploymentFailed") {
      const prevKey = body.previous_deployment_key ?? body.deployment_key;
      const [prevDep] = await db.select().from(deployments).where(eq(deployments.key, prevKey));
      if (prevDep) await bumpMetric(prevDep.id, body.previous_label_or_app_version, "active", -1);
    }
    return { ok: true };
  });

  app.post(`${base}/report_status/download`, async (req) => {
    const body = reportDownloadSchema.parse(req.body);
    const dep = await depByKey(body.deployment_key);
    if (await labelExists(dep.id, body.label)) await bumpMetric(dep.id, body.label, "downloaded");
    return { ok: true };
  });
}
