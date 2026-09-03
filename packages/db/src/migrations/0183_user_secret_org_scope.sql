-- Operator credentials (e.g. the Claude subscription token) belong to the
-- operator within an ORG, not to a company: definitions and their per-user
-- values gain an org home. A definition is scoped to exactly one of
-- company/org; a user value lives in the same home as its definition and is
-- unique per (definition, owner) regardless of company.
ALTER TABLE "user_secret_definitions" ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'company';
--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD COLUMN IF NOT EXISTS "org_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ALTER COLUMN "company_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "org_id" uuid;
--> statement-breakpoint
ALTER TABLE "company_secrets" ALTER COLUMN "company_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Backfill: every org keeps ONE CLAUDE_CODE_OAUTH_TOKEN definition at org scope.
-- The oldest company definition in the org is promoted; the others are retired
-- with their declarations and values re-pointed (an owner keeps the value on
-- the promoted definition when they had one there, else their newest other).
DO $$
DECLARE
	promoted RECORD;
	dup RECORD;
BEGIN
	FOR promoted IN
		SELECT DISTINCT ON (c.org_id) d.id, c.org_id
		FROM user_secret_definitions d
		JOIN companies c ON c.id = d.company_id
		WHERE d.key = 'CLAUDE_CODE_OAUTH_TOKEN' AND d.scope = 'company'
		  AND d.deleted_at IS NULL AND d.status <> 'deleted' AND c.org_id IS NOT NULL
		ORDER BY c.org_id, d.created_at
	LOOP
		FOR dup IN
			SELECT d.id
			FROM user_secret_definitions d
			JOIN companies c ON c.id = d.company_id
			WHERE d.key = 'CLAUDE_CODE_OAUTH_TOKEN' AND d.scope = 'company'
			  AND d.deleted_at IS NULL AND d.status <> 'deleted'
			  AND c.org_id = promoted.org_id AND d.id <> promoted.id
		LOOP
			UPDATE user_secret_declarations SET user_secret_definition_id = promoted.id
			WHERE user_secret_definition_id = dup.id;
			UPDATE company_secrets s SET status = 'deleted', deleted_at = now(), updated_at = now()
			WHERE s.user_secret_definition_id = dup.id AND s.scope = 'user' AND s.deleted_at IS NULL
			  AND EXISTS (
			    SELECT 1 FROM company_secrets k
			    WHERE k.user_secret_definition_id = promoted.id AND k.owner_user_id = s.owner_user_id
			      AND k.scope = 'user' AND k.deleted_at IS NULL
			  );
			UPDATE company_secrets SET user_secret_definition_id = promoted.id, updated_at = now()
			WHERE user_secret_definition_id = dup.id AND scope = 'user' AND deleted_at IS NULL;
			UPDATE user_secret_definitions SET status = 'deleted', deleted_at = now(), updated_at = now()
			WHERE id = dup.id;
		END LOOP;
		UPDATE user_secret_definitions SET scope = 'org', org_id = promoted.org_id, company_id = NULL, updated_at = now()
		WHERE id = promoted.id;
		UPDATE company_secrets SET org_id = promoted.org_id, company_id = NULL, updated_at = now()
		WHERE user_secret_definition_id = promoted.id AND scope = 'user';
	END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "user_secret_definitions" DROP CONSTRAINT IF EXISTS "user_secret_definitions_scope_shape_check";
--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_scope_shape_check" CHECK (
	("scope" = 'company' AND "company_id" IS NOT NULL AND "org_id" IS NULL)
	OR ("scope" = 'org' AND "org_id" IS NOT NULL AND "company_id" IS NULL)
);
--> statement-breakpoint
DROP INDEX IF EXISTS "user_secret_definitions_company_key_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_definitions_company_key_uq" ON "user_secret_definitions" USING btree ("company_id","key") WHERE "scope" = 'company' AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_definitions_org_key_uq" ON "user_secret_definitions" USING btree ("org_id","key") WHERE "scope" = 'org' AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_org_status_idx" ON "user_secret_definitions" USING btree ("org_id","status");
--> statement-breakpoint
ALTER TABLE "company_secrets" DROP CONSTRAINT IF EXISTS "company_secrets_scope_shape_check";
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK (
	(
		"scope" = 'company' AND "company_id" IS NOT NULL AND "org_id" IS NULL
		AND "owner_user_id" IS NULL AND "user_secret_definition_id" IS NULL
	) OR (
		"scope" = 'user' AND "owner_user_id" IS NOT NULL AND "user_secret_definition_id" IS NOT NULL
		AND (("company_id" IS NOT NULL AND "org_id" IS NULL) OR ("company_id" IS NULL AND "org_id" IS NOT NULL))
	)
);
--> statement-breakpoint
DROP INDEX IF EXISTS "company_secrets_user_definition_owner_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_uq" ON "company_secrets" USING btree ("user_secret_definition_id","owner_user_id") WHERE "scope" = 'user' AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_org_owner_idx" ON "company_secrets" USING btree ("org_id","owner_user_id");
