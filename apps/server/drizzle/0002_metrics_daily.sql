CREATE TABLE "metrics_daily" (
	"deployment_id" integer NOT NULL,
	"label" text NOT NULL,
	"day" date NOT NULL,
	"downloaded" integer DEFAULT 0 NOT NULL,
	"installed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metrics_daily_deployment_id_label_day_pk" PRIMARY KEY("deployment_id","label","day")
);
--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;