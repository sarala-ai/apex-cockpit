-- companies.org_id is already nullable (added as bare `uuid` in migration 0145) —
-- no ALTER COLUMN needed, ON DELETE SET NULL just requires nullability which
-- already holds.
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_org_id_orgs_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "companies" ADD CONSTRAINT "companies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "org_memberships" DROP CONSTRAINT IF EXISTS "org_memberships_org_id_orgs_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
