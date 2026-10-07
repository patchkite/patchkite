import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";

/** Read all files in a zip into memory (OTA packages are usually small). */
export function readZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Invalid zip"));
      const files = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => resolve(files));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

export function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

export function createZip(files: Map<string, Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      zip.addBuffer(data, name, { mtime: new Date(0) });
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/** Set of zip entries on disk, read per stream without loading the whole zip into memory. */
export interface ZipOnDisk {
  /** path → sha256 of file contents. */
  manifest: Record<string, string>;
  /** path → file size after extraction. */
  sizes: Record<string, number>;
  /** Total size after extraction. */
  uncompressedSize: number;
}

function openEntries(file: string): Promise<{ zip: yauzl.ZipFile; entries: yauzl.Entry[] }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Invalid zip"));
      const entries: yauzl.Entry[] = [];
      zip.on("entry", (e: yauzl.Entry) => {
        if (!e.fileName.endsWith("/")) entries.push(e);
        zip.readEntry();
      });
      zip.on("end", () => resolve({ zip, entries }));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err ?? new Error("Unable to read entry")) : resolve(stream))),
  );
}

/**
 * Compute the manifest (sha256 per file) of a zip on disk by streaming.
 * File names are validated by yauzl (absolute paths or `..` are rejected).
 */
export async function scanZipFile(file: string, opts: { maxUncompressedSize?: number } = {}): Promise<ZipOnDisk> {
  const { zip, entries } = await openEntries(file);
  try {
    const declared = entries.reduce((n, e) => n + e.uncompressedSize, 0);
    if (opts.maxUncompressedSize && declared > opts.maxUncompressedSize) {
      throw new ZipLimitError(`Extracted package size (${declared} bytes) exceeds the limit of ${opts.maxUncompressedSize} bytes`);
    }
    const manifest: Record<string, string> = {};
    const sizes: Record<string, number> = {};
    for (const e of entries) {
      sizes[e.fileName] = e.uncompressedSize;
      const h = createHash("sha256");
      for await (const chunk of await entryStream(zip, e)) h.update(chunk as Buffer);
      manifest[e.fileName] = h.digest("hex");
    }
    return { manifest, sizes, uncompressedSize: declared };
  } finally {
    zip.close();
  }
}

export class ZipLimitError extends Error {}

/** Read a single small entry into memory (e.g. `.patchkiterelease`). */
export async function readZipEntry(file: string, name: string): Promise<Buffer | undefined> {
  const { zip, entries } = await openEntries(file);
  try {
    const e = entries.find((x) => x.fileName === name);
    if (!e) return undefined;
    const chunks: Buffer[] = [];
    for await (const c of await entryStream(zip, e)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  } finally {
    zip.close();
  }
}

/** Stream a single zip entry out to a file on disk. */
export async function extractZipEntry(file: string, name: string, out: string) {
  const { zip, entries } = await openEntries(file);
  try {
    const e = entries.find((x) => x.fileName === name);
    if (!e) throw new Error(`Entry ${name} not found in zip`);
    await pipeline(await entryStream(zip, e), createWriteStream(out));
  } finally {
    zip.close();
  }
}

/**
 * Write a new zip to `out` containing a subset of entries from the source zip + extra files
 * (buffers, or `{ file }` read from disk), without loading entry contents into memory.
 */
export async function writeZipSubset(src: string, names: string[], extra: Map<string, Buffer | { file: string }>, out: string) {
  const { zip: source, entries } = await openEntries(src);
  try {
    const byName = new Map(entries.map((e) => [e.fileName, e]));
    const zip = new yazl.ZipFile();
    const all = [...names.map((n) => [n, "entry"] as const), ...[...extra.keys()].map((n) => [n, "extra"] as const)].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [name, kind] of all) {
      if (kind === "extra") {
        const value = extra.get(name)!;
        if (Buffer.isBuffer(value)) zip.addBuffer(value, name, { mtime: new Date(0) });
        else zip.addFile(value.file, name, { mtime: new Date(0) });
      }
      else {
        const e = byName.get(name);
        if (!e) throw new Error(`Entry ${name} not found in source zip`);
        zip.addReadStreamLazy(name, { mtime: new Date(0), size: e.uncompressedSize }, (cb) => {
          entryStream(source, e).then(
            (s) => cb(null, s),
            (err: unknown) => cb(err, undefined as never),
          );
        });
      }
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(out));
  } finally {
    source.close();
  }
}

/** Check the zip magic bytes of a file on disk. */
export async function isZipFile(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.readUInt32LE(0) === 0x04034b50;
  } finally {
    await fh.close();
  }
}

/** Run `fn` with a temporary directory that is always removed afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "patchkite-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
