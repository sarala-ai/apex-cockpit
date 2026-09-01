ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "slug" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_slug_idx" ON "companies" USING btree ("slug") WHERE "slug" IS NOT NULL;
