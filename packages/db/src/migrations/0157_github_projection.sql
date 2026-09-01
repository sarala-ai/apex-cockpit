-- GitHub projection (work-loop doctrine): the GitHub issue is the canonical
-- CONVERSATION and audit surface; the cockpit board stays the canonical
-- EXECUTION store. Projection is live-only and per-company opt-in — disabled
-- by default, zero behavior change while off.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "github_projection_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- "github_projection_repo" ("owner/name") is a FALLBACK ONLY: mirror targeting
-- is primarily an ordered cascade off the ticket's project workspace repo, and
-- this column is used only for tickets with no repo-bearing project binding
-- (see server/src/apex/flow/projection-repo-resolver.ts).
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "github_projection_repo" text;--> statement-breakpoint
-- Mirror ref ("owner/repo#123") of the GitHub issue the projection CREATED for
-- a board-origin ticket. Typed column by doctrine (never jsonb). Stays NULL for
-- github-origin issues (their own origin issue is the mirror target — never
-- duplicated, never closed by us) and while projection is off.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "github_mirror_ref" text;
