CREATE TABLE IF NOT EXISTS "resource_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"resource_uri" text NOT NULL,
	"asset_type" text NOT NULL,
	"source" text NOT NULL,
	"workflow" text,
	"repo" text,
	"env" text,
	"confidence" text,
	"evidence" jsonb,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_attributions_source_check" CHECK ("resource_attributions"."source" in ('auto_mapped', 'manual')),
	CONSTRAINT "resource_attributions_confidence_check" CHECK ("resource_attributions"."confidence" is null or "resource_attributions"."confidence" in ('exact', 'pattern'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resource_attributions" ADD CONSTRAINT "resource_attributions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_attributions_project_resource_uri_unique" ON "resource_attributions" USING btree ("project_id","resource_uri");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_attributions_company_idx" ON "resource_attributions" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_attributions_company_project_idx" ON "resource_attributions" USING btree ("company_id","project_id");
