import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** Server admin: manage users, reset passwords, run GC. The first user is automatically an admin. */
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const accessKeys = pgTable("access_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Public identifier (not a secret). */
  name: text("name").notNull().unique(),
  friendlyName: text("friendly_name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdBy: text("created_by").notNull(),
  isSession: boolean("is_session").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const apps = pgTable("apps", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  os: text("os").notNull(),
  platform: text("platform").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const collaborators = pgTable(
  "collaborators",
  {
    appId: integer("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull().$type<"Owner" | "Collaborator">(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.userId] })],
);

export const deployments = pgTable(
  "deployments",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("deployments_app_name").on(t.appId, t.name)],
);

export const packages = pgTable(
  "packages",
  {
    id: serial("id").primaryKey(),
    deploymentId: integer("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade" }),
    /** Position in the deployment history (1, 2, 3 ...) → label "v{seq}". */
    seq: integer("seq").notNull(),
    label: text("label").notNull(),
    appVersion: text("app_version").notNull(),
    description: text("description").notNull().default(""),
    isDisabled: boolean("is_disabled").notNull().default(false),
    isMandatory: boolean("is_mandatory").notNull().default(false),
    rollout: integer("rollout"),
    packageHash: text("package_hash").notNull(),
    blobKey: text("blob_key").notNull(),
    manifestBlobKey: text("manifest_blob_key"),
    size: bigint("size", { mode: "number" }).notNull(),
    releaseMethod: text("release_method").notNull().$type<"Upload" | "Promote" | "Rollback">(),
    releasedBy: text("released_by").notNull(),
    originalLabel: text("original_label"),
    originalDeployment: text("original_deployment"),
    engineRevision: text("engine_revision"),
    uploadTime: timestamp("upload_time").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("packages_deployment_label").on(t.deploymentId, t.label)],
);

export const packageDiffs = pgTable(
  "package_diffs",
  {
    packageId: integer("package_id").notNull().references(() => packages.id, { onDelete: "cascade" }),
    fromHash: text("from_hash").notNull(),
    /** "files" = changed files sent whole; "bsdiff" = large files sent as binary patches. */
    format: text("format").notNull().default("files").$type<"files" | "bsdiff">(),
    blobKey: text("blob_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.fromHash, t.format] })],
);

export const metrics = pgTable(
  "metrics",
  {
    deploymentId: integer("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade" }),
    /** Release label, or app version for the stock binary. */
    label: text("label").notNull(),
    active: integer("active").notNull().default(0),
    downloaded: integer("downloaded").notNull().default(0),
    installed: integer("installed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.label] })],
);

/**
 * JS bundle shipped in the store binary (React Native), registered from CI with `patchkite binary add`.
 * Used as the base for binary patches for the first update on devices still running the binary.
 */
export const binaryBundles = pgTable(
  "binary_bundles",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    /** Bundle file name in the binary, e.g. index.android.bundle or main.jsbundle. */
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    appVersion: text("app_version"),
    blobKey: text("blob_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("binary_bundles_app_hash").on(t.appId, t.fileHash)],
);

/** Event counts per day (UTC) for metrics charts; `metrics` stores the totals. */
export const metricsDaily = pgTable(
  "metrics_daily",
  {
    deploymentId: integer("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    downloaded: integer("downloaded").notNull().default(0),
    installed: integer("installed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.label, t.day] })],
);

export const appsRelations = relations(apps, ({ many }) => ({
  deployments: many(deployments),
  collaborators: many(collaborators),
}));

export const deploymentsRelations = relations(deployments, ({ one, many }) => ({
  app: one(apps, { fields: [deployments.appId], references: [apps.id] }),
  packages: many(packages),
}));

export const collaboratorsRelations = relations(collaborators, ({ one }) => ({
  app: one(apps, { fields: [collaborators.appId], references: [apps.id] }),
  user: one(users, { fields: [collaborators.userId], references: [users.id] }),
}));

export const packagesRelations = relations(packages, ({ one, many }) => ({
  deployment: one(deployments, { fields: [packages.deploymentId], references: [deployments.id] }),
  diffs: many(packageDiffs),
}));

export const packageDiffsRelations = relations(packageDiffs, ({ one }) => ({
  package: one(packages, { fields: [packageDiffs.packageId], references: [packages.id] }),
}));

export type DbPackage = typeof packages.$inferSelect;
export type DbDeployment = typeof deployments.$inferSelect;
export type DbApp = typeof apps.$inferSelect;
export type DbUser = typeof users.$inferSelect;
export type DbBinaryBundle = typeof binaryBundles.$inferSelect;

