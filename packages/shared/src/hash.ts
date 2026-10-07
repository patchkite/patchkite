import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SIGNATURE_FILE_NAME } from "./types.js";

/** Map of relative path ("/" separator) → hex sha256 of the file contents. */
export type Manifest = Record<string, string>;

const IGNORED = new Set([".DS_Store", "__MACOSX", SIGNATURE_FILE_NAME]);

export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split("/").some((seg) => IGNORED.has(seg));
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Package hash = sha256(sorted JSON array of "path:fileHash"), with paths in Unicode NFC form.
 * The same algorithm is implemented in the native SDKs for verification.
 */
export function packageHashFromManifest(manifest: Manifest): string {
  const entries = Object.keys(manifest)
    .filter((p) => !isIgnoredPath(p))
    // Paths are normalized to NFC: iOS writes file names as NFD, so non-ASCII
    // names (e.g. "é") must be unified for the hash to match on every platform.
    .map((p) => [p.normalize("NFC"), manifest[p]] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, h]) => `${p}:${h}`);
  return sha256(JSON.stringify(entries));
}

export async function listFilesRecursive(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

export async function manifestFromDirectory(dir: string): Promise<Manifest> {
  const manifest: Manifest = {};
  for (const rel of await listFilesRecursive(dir)) {
    if (isIgnoredPath(rel)) continue;
    manifest[rel] = await sha256File(path.join(dir, rel));
  }
  return manifest;
}

export async function packageHashFromPath(target: string): Promise<{ hash: string; manifest: Manifest }> {
  const s = await stat(target);
  if (s.isFile()) {
    const manifest = { [path.basename(target)]: await sha256File(target) };
    return { hash: packageHashFromManifest(manifest), manifest };
  }
  const manifest = await manifestFromDirectory(target);
  return { hash: packageHashFromManifest(manifest), manifest };
}

/** Compute changed/new and deleted files between two manifests. */
export function diffManifests(from: Manifest, to: Manifest): { changed: string[]; deleted: string[] } {
  const changed = Object.keys(to).filter((p) => from[p] !== to[p]);
  const deleted = Object.keys(from).filter((p) => !(p in to));
  return { changed, deleted };
}
