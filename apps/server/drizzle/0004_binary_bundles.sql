CREATE TABLE "binary_bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"app_version" text,
	"blob_key" text NOT NULL,
	"size" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "binary_bundles" ADD CONSTRAINT "binary_bundles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "binary_bundles_app_hash" ON "binary_bundles" USING btree ("app_id","file_hash");