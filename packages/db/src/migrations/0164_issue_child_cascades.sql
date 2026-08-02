-- Every other child of `issues` already declares ON DELETE CASCADE (attachments,
-- documents, labels, relations, approvals, work products, execution decisions,
-- reference mentions, tree holds, …). These four were the omission, so any issue
-- that ever received a comment — including the *system* comments the board writes
-- on almost every issue — could never be deleted: DELETE /api/issues/:id blew up
-- with a raw 23503 foreign-key violation.
--
-- The deliberate non-cascading references to `issues` are left alone on purpose:
-- `cost_events`, `finance_events` and `feedback_votes` (ledger rows that must
-- outlive the issue) and `company_skills`.`skill_test_runs` (ON DELETE RESTRICT).
-- Those remain genuine blockers and are now reported as a classified 409.
ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_issue_id_issues_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" DROP CONSTRAINT IF EXISTS "issue_inbox_archives_issue_id_issues_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_issue_id_issues_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" DROP CONSTRAINT IF EXISTS "issue_thread_interactions_issue_id_issues_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
