import { z } from "zod";

export const PLATFORMS = ["react-native", "flutter"] as const;
export const OSES = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type OS = (typeof OSES)[number];

export type ReleaseMethod = "Upload" | "Promote" | "Rollback";

/** Name of the signature file inside a package. */
export const SIGNATURE_FILE_NAME = ".patchkiterelease";
/** Name of the diff metadata file. */
export const DIFF_MANIFEST_FILE_NAME = "patchkite-diff.json";

export interface Package {
  label: string;
  appVersion: string;
  description: string;
  isDisabled: boolean;
  isMandatory: boolean;
  rollout: number | null;
  packageHash: string;
  blobUrl: string;
  size: number;
  uploadTime: number;
  releaseMethod: ReleaseMethod;
  releasedBy: string;
  originalLabel?: string | null;
  originalDeployment?: string | null;
  /** Flutter: engine revision that libapp.so was compiled with. */
  engineRevision?: string | null;
  diffPackageMap?: Record<string, { size: number; url: string }>;
}

export interface Deployment {
  name: string;
  key: string;
  package: Package | null;
}

export interface App {
  name: string;
  os: OS;
  platform: Platform;
  collaborators: Record<string, { permission: "Owner" | "Collaborator" }>;
  deployments: string[];
}

export interface AccessKey {
  name: string;
  friendlyName: string;
  createdBy: string;
  createdTime: number;
  expires: number;
  isSession?: boolean;
}

export interface DeploymentMetrics {
  [label: string]: { active: number; downloaded: number; installed: number; failed: number };
}

/** update_check response. */
export interface UpdateCheckResponse {
  update_info: {
    is_available: boolean;
    is_mandatory: boolean;
    should_run_binary_version: boolean;
    update_app_version: boolean;
    target_binary_range: string;
    app_version: string;
    download_url?: string;
    package_hash?: string;
    label?: string;
    package_size?: number;
    description?: string;
    is_diff?: boolean;
  };
}

export const releaseMetadataSchema = z.object({
  appVersion: z.string().min(1).max(128),
  description: z.string().max(10_000).optional().default(""),
  isMandatory: z.boolean().optional().default(false),
  isDisabled: z.boolean().optional().default(false),
  rollout: z.coerce.number().int().min(1).max(100).nullable().optional(),
  engineRevision: z.string().max(128).nullable().optional(),
});
export type ReleaseMetadata = z.infer<typeof releaseMetadataSchema>;

export const patchMetadataSchema = z.object({
  label: z.string().max(32).optional(),
  appVersion: z.string().min(1).max(128).optional(),
  description: z.string().max(10_000).optional(),
  isMandatory: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  rollout: z.number().int().min(1).max(100).nullable().optional(),
});
export type PatchMetadata = z.infer<typeof patchMetadataSchema>;

/** Release label or binary version reported by a device. Constrained so the metrics table can't be flooded with arbitrary values. */
const reportedVersion = z.string().min(1).max(64).regex(/^[\w.+-]+$/, "invalid version/label format");

export const reportDeploySchema = z.object({
  deployment_key: z.string().max(128),
  app_version: reportedVersion,
  label: reportedVersion.nullish(),
  status: z.enum(["DeploymentSucceeded", "DeploymentFailed"]).nullish(),
  previous_label_or_app_version: reportedVersion.nullish(),
  previous_deployment_key: z.string().max(128).nullish(),
  client_unique_id: z.string().max(128).nullish(),
});

export const reportDownloadSchema = z.object({
  deployment_key: z.string().max(128),
  label: reportedVersion,
  client_unique_id: z.string().max(128).nullish(),
});
