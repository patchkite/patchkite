import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Env } from "./env.js";

export interface BlobInfo {
  key: string;
  lastModified: Date;
}

export interface Storage {
  init?(): Promise<void>;
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** Upload from a local file without loading its whole contents into memory. */
  putFile(key: string, file: string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Stream a blob down to a local file. */
  download(key: string, file: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** All blobs with the given prefix (used by the cleanup job). */
  list(prefix: string): AsyncIterable<BlobInfo>;
  /** Presigned URL for direct download, or null if it must be streamed through the server. */
  presignedUrl(key: string): Promise<string | null>;
  stream(key: string): Promise<Readable>;
}

export class FsStorage implements Storage {
  constructor(private readonly root: string) {}
  private file(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid blob key");
    return full;
  }
  async put(key: string, data: Buffer) {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await writeFile(this.file(key), data);
  }
  async putFile(key: string, file: string) {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await copyFile(file, this.file(key));
  }
  get(key: string) {
    return readFile(this.file(key));
  }
  async download(key: string, file: string) {
    await copyFile(this.file(key), file);
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
  async *list(prefix: string): AsyncIterable<BlobInfo> {
    const root = path.resolve(this.root);
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const key = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/");
      if (key.startsWith(prefix)) yield { key, lastModified: (await stat(path.join(e.parentPath, e.name))).mtime };
    }
  }
  async presignedUrl() {
    return null;
  }
  async stream(key: string) {
    return createReadStream(this.file(key));
  }
}

export class S3Storage implements Storage {
  private clientPromise;
  /** Separate client for presigning when the public endpoint differs from the internal one. */
  private presignClientPromise;
  constructor(private readonly env: Env) {
    const make = (endpoint?: string) =>
      import("@aws-sdk/client-s3").then(
        (m) =>
          new m.S3Client({
            endpoint,
            region: env.S3_REGION,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
            credentials:
              env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
                ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
                : undefined,
          }),
      );
    this.clientPromise = make(env.S3_ENDPOINT);
    this.presignClientPromise =
      env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT ? make(env.S3_PUBLIC_ENDPOINT) : this.clientPromise;
  }
  /** Create the bucket if it doesn't exist (useful for self-hosted RustFS/MinIO). */
  async init() {
    const { HeadBucketCommand, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    try {
      await client.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: this.env.S3_BUCKET }));
    }
  }

  async put(key: string, data: Buffer, contentType = "application/octet-stream") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(
      new PutObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, Body: data, ContentType: contentType }),
    );
  }
  async putFile(key: string, file: string, contentType = "application/octet-stream") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { size } = await stat(file);
    await (await this.clientPromise).send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async download(key: string, file: string) {
    await pipeline(await this.stream(key), createWriteStream(file));
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
  }
  async *list(prefix: string): AsyncIterable<BlobInfo> {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: this.env.S3_BUCKET, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) yield { key: o.Key, lastModified: o.LastModified ?? new Date(0) };
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }
  async presignedUrl(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(await this.presignClientPromise, new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }), {
      expiresIn: 3600,
    });
  }
  async stream(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
    return res.Body as Readable;
  }
}

export function createStorage(env: Env): Storage {
  return env.STORAGE_DRIVER === "fs" ? new FsStorage(env.FS_STORAGE_DIR) : new S3Storage(env);
}
