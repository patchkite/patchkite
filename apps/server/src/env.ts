import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://patchkite:patchkite@localhost:5432/patchkite"),
  STORAGE_DRIVER: z.enum(["s3", "fs"]).default("s3"),
  S3_ENDPOINT: z.string().optional(),
  /** S3 endpoint reachable by devices for presigned URLs (default = S3_ENDPOINT). */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("patchkite"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
  /** redirect = devices download directly from S3 (presigned URL); proxy = streamed through the server. */
  BLOB_DOWNLOAD_MODE: z.enum(["redirect", "proxy"]).default("redirect"),
  FS_STORAGE_DIR: z.string().default("./data/blobs"),
  DIFF_HISTORY_DEPTH: z.coerce.number().int().min(0).default(5),
  /** Binary patches (bsdiff) for large changed files, generated in the background. */
  BSDIFF_ENABLED: z.stringbool().default(true),
  /** Files smaller than this are sent whole. */
  BSDIFF_MIN_FILE_KB: z.coerce.number().min(0).default(32),
  /** Files larger than this are sent whole (bsdiff needs ~10× the file size in memory). */
  BSDIFF_MAX_FILE_MB: z.coerce.number().min(1).default(64),
  /** Interval of the orphaned blob cleanup job (0 = disabled). */
  GC_INTERVAL_MINUTES: z.coerce.number().min(0).default(60),
  /** Blobs younger than this are not deleted by GC (protects in-flight uploads). */
  GC_GRACE_MINUTES: z.coerce.number().min(0).default(60),
  DASHBOARD_DIR: z.string().optional(),
  /** false = only admins can create accounts (the first account can still register). */
  ALLOW_REGISTRATION: z.stringbool().default(true),
  /** Requests per minute per IP to SDK endpoints (update_check, report_status, download). 0 = unlimited. */
  RATE_LIMIT_PUBLIC_PER_MINUTE: z.coerce.number().int().min(0).default(300),
  /** Login/registration attempts per minute per IP. 0 = unlimited. */
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(0).default(10),
  /** true when the server is behind a reverse proxy (client IP is read from X-Forwarded-For). */
  TRUST_PROXY: z.stringbool().default(false),
  MAX_PACKAGE_SIZE_MB: z.coerce.number().default(200),
  /** Max total package size after extraction (zip bomb protection). */
  MAX_UNCOMPRESSED_SIZE_MB: z.coerce.number().default(1024),
});

export type Env = z.infer<typeof envSchema>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => envSchema.parse(source);
