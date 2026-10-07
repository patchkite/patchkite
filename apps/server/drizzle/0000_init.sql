CREATE TABLE "access_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"friendly_name" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"is_session" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "access_keys_name_unique" UNIQUE("name"),
	CONSTRAINT "access_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaborators" (
	"app_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "collaborators_app_id_user_id_pk" PRIMARY KEY("app_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"deployment_id" integer NOT NULL,
	"label" text NOT NULL,
	"active" integer DEFAULT 0 NOT NULL,
	"downloaded" integer DEFAULT 0 NOT NULL,
	"installed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metrics_deployment_id_label_pk" PRIMARY KEY("deployment_id","label")
);
--> statement-breakpoint
CREATE TABLE "package_diffs" (
	"package_id" integer NOT NULL,
	"from_hash" text NOT NULL,
	"blob_key" text NOT NULL,
	"size" bigint NOT NULL,
	CONSTRAINT "package_diffs_package_id_from_hash_pk" PRIMARY KEY("package_id","from_hash")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"deployment_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"label" text NOT NULL,
	"app_version" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"rollout" integer,
	"package_hash" text NOT NULL,
	"blob_key" text NOT NULL,
	"manifest_blob_key" text,
	"size" bigint NOT NULL,
	"release_method" text NOT NULL,
	"released_by" text NOT NULL,
	"original_label" text,
	"original_deployment" text,
	"engine_revision" text,
	"upload_time" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "access_keys" ADD CONSTRAINT "access_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaborators" ADD CONSTRAINT "collaborators_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaborators" ADD CONSTRAINT "collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_diffs" ADD CONSTRAINT "package_diffs_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_app_name" ON "deployments" USING btree ("app_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_deployment_label" ON "packages" USING btree ("deployment_id","label");