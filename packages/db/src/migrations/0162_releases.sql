-- The release object. The intent tree (idea → initiative → project → task →
-- ticket) is a decomposition; a release is the opposite motion, an aggregation
-- ACROSS that tree. Several initiatives ship together, so a release is nobody's
-- child and could not be modelled as another node in the tree.
--
-- The reason this is a soundness fix and not a convenience: every initiative is
-- measured against a stop condition written before the work. If three
-- initiatives shipped in the same window, a metric movement cannot be
-- attributed to any one of them. THE RELEASE IS THE MEASUREMENT BOUNDARY — the
-- answer to "what else changed at the same time". Without it the evaluator
-- reports another initiative's regression as this one's failure, in a system
-- whose entire claim is evidence-based decisions.
--
-- Scoped to `companies`, which at this level holds PRODUCTS. A release belongs
-- to a product, not a repository: `apex-core v0.7.0` is a repository artifact,
-- and many tags are never product releases at all. The tags are recorded in
-- `release_artifacts` — the tag is the EVIDENCE, the release is the object you
-- measure against, promote through environments, and roll back.
--
-- `status` and `closure` are SEPARATE columns, the same treatment goals
-- received in 0161. status is position in the lifecycle
-- (planned → building → released → observing); closure is how it ended
-- (stable / rolled_back / superseded / partially_reverted). A release that is
-- honestly rolled back is a working method and a failed change, and one column
-- cannot say both. closure_reason keeps the evidence for every closure.
--
-- `environment` is text, NOT a foreign key to `environments`. That table is
-- instance-scoped and describes agent execution drivers (local / ssh /
-- sandbox); a release promotes through named DEPLOYMENT environments that
-- differ per product. Promotion creates a NEW ROW pointing back at its
-- predecessor through promoted_from_release_id, so each environment keeps its
-- own observation window and the chain stays queryable.
--
-- released_at is NULL until the change reaches the world: a planned release
-- changed nothing and must never enter a confound window.
CREATE TABLE IF NOT EXISTS "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"version" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"closure" text,
	"closure_reason" text,
	"environment" text NOT NULL,
	"promoted_from_release_id" uuid,
	"released_at" timestamp with time zone,
	"observation_window_ends_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The join where the two axes meet: a change belongs to one initiative path and
-- one release per environment. The initiative is deliberately NOT copied here —
-- it is read through `issues.goal_id`, whose single writer is the issue. A
-- denormalised copy would become a second truth the moment a ticket is
-- re-parented.
CREATE TABLE IF NOT EXISTS "release_changes" (
	"release_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_changes_release_id_issue_id_pk" PRIMARY KEY("release_id","issue_id")
);
--> statement-breakpoint
-- The repository tags a product release aggregates. A FinPilot release covers
-- the backend and the mobile client together, so this is one-to-many.
-- commit_sha is what makes the claim checkable after the fact, and (repo,
-- commit_sha) is the key that lines a release up against the attribution stamps
-- already carried by resources.
CREATE TABLE IF NOT EXISTS "release_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"tag" text NOT NULL,
	"commit_sha" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_promoted_from_release_id_releases_id_fk" FOREIGN KEY ("promoted_from_release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_changes" ADD CONSTRAINT "release_changes_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_changes" ADD CONSTRAINT "release_changes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_changes" ADD CONSTRAINT "release_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_artifacts" ADD CONSTRAINT "release_artifacts_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_artifacts" ADD CONSTRAINT "release_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_company_idx" ON "releases" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_company_status_idx" ON "releases" USING btree ("company_id","status");--> statement-breakpoint
-- The confound query is "which releases of this product overlap this window";
-- company_id + released_at is its access path.
CREATE INDEX IF NOT EXISTS "releases_company_released_at_idx" ON "releases" USING btree ("company_id","released_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_promoted_from_idx" ON "releases" USING btree ("promoted_from_release_id");--> statement-breakpoint
-- One version per environment per product. The same version promoted to staging
-- and to production is two rows, and that is the point.
CREATE UNIQUE INDEX IF NOT EXISTS "releases_company_version_environment_uq" ON "releases" USING btree ("company_id","version","environment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_changes_release_idx" ON "release_changes" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_changes_issue_idx" ON "release_changes" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_changes_company_idx" ON "release_changes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_artifacts_release_idx" ON "release_artifacts" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_artifacts_company_idx" ON "release_artifacts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_artifacts_release_repo_tag_uq" ON "release_artifacts" USING btree ("release_id","repo","tag");
