ALTER TABLE "package_diffs" ADD COLUMN "format" text DEFAULT 'files' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_diffs" DROP CONSTRAINT "package_diffs_package_id_from_hash_pk";--> statement-breakpoint
ALTER TABLE "package_diffs" ADD CONSTRAINT "package_diffs_package_id_from_hash_format_pk" PRIMARY KEY("package_id","from_hash","format");
