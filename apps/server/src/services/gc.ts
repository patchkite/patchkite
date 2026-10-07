import type { Db } from "../db/index.js";
import { binaryBundles, packageDiffs, packages } from "../db/schema.js";
import type { Storage } from "../storage.js";

/** Blob prefixes managed by Patchkite. Blobs outside these prefixes are never touched. */
const PREFIXES = ["packages/", "manifests/", "diffs/", "binaries/"];

export interface GcResult {
  scanned: number;
  /** Orphaned blobs deleted (or that would be deleted in a dry run). */
  orphans: string[];
  dryRun: boolean;
}

/**
 * Delete package, manifest, and diff blobs that are no longer referenced by the database
 * (left behind after an app, deployment, or history is deleted).
 *
 * Blobs are collected first, then references are read, and only blobs older than
 * `graceMs` are deleted. This way in-flight uploads (blob already written, database
 * row not yet) are not deleted.
 */
export async function collectGarbage(db: Db, storage: Storage, opts: { graceMs: number; dryRun?: boolean }): Promise<GcResult> {
  const cutoff = Date.now() - opts.graceMs;
  const candidates: string[] = [];
  let scanned = 0;
  for (const prefix of PREFIXES) {
    for await (const blob of storage.list(prefix)) {
      scanned++;
      if (blob.lastModified.getTime() < cutoff) candidates.push(blob.key);
    }
  }

  const referenced = new Set<string>();
  for (const p of await db.select({ blob: packages.blobKey, manifest: packages.manifestBlobKey }).from(packages)) {
    referenced.add(p.blob);
    if (p.manifest) referenced.add(p.manifest);
  }
  for (const d of await db.select({ blob: packageDiffs.blobKey }).from(packageDiffs)) referenced.add(d.blob);
  for (const b of await db.select({ blob: binaryBundles.blobKey }).from(binaryBundles)) referenced.add(b.blob);

  const orphans = candidates.filter((k) => !referenced.has(k));
  if (!opts.dryRun) for (const key of orphans) await storage.delete(key);
  return { scanned, orphans, dryRun: !!opts.dryRun };
}

/** Run GC periodically. Returns a function that stops it. */
export function scheduleGarbageCollection(
  db: Db,
  storage: Storage,
  opts: { intervalMs: number; graceMs: number; log: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void } },
) {
  if (opts.intervalMs <= 0) return () => {};
  const run = () =>
    collectGarbage(db, storage, { graceMs: opts.graceMs }).then(
      (r) => r.orphans.length && opts.log.info({ deleted: r.orphans.length, scanned: r.scanned }, "GC: orphaned blobs deleted"),
      (err) => opts.log.error({ err }, "GC failed"),
    );
  const timer = setInterval(run, opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
