ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing servers: the oldest user becomes the first admin.
UPDATE "users" SET "is_admin" = true WHERE "id" = (SELECT min("id") FROM "users");
