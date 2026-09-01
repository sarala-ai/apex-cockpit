CREATE TABLE IF NOT EXISTS "company_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "current_version_id" uuid,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_prompt_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "content" text NOT NULL,
  "variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "commit_message" text,
  "author_user_id" text,
  "author_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_prompt_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "name" text NOT NULL,
  "version_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "protected" boolean DEFAULT false NOT NULL,
  "updated_by_user_id" text,
  "updated_by_agent_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompts" ADD CONSTRAINT "company_prompts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompts" ADD CONSTRAINT "company_prompts_current_version_id_company_prompt_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."company_prompt_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompts" ADD CONSTRAINT "company_prompts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_versions" ADD CONSTRAINT "company_prompt_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_versions" ADD CONSTRAINT "company_prompt_versions_prompt_id_company_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."company_prompts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_versions" ADD CONSTRAINT "company_prompt_versions_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_labels" ADD CONSTRAINT "company_prompt_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_labels" ADD CONSTRAINT "company_prompt_labels_prompt_id_company_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."company_prompts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_labels" ADD CONSTRAINT "company_prompt_labels_version_id_company_prompt_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."company_prompt_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_prompt_labels" ADD CONSTRAINT "company_prompt_labels_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_prompts_company_slug_idx" ON "company_prompts" USING btree ("company_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_prompts_company_created_idx" ON "company_prompts" USING btree ("company_id","created_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_prompt_versions_prompt_revision_idx" ON "company_prompt_versions" USING btree ("prompt_id","revision_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_prompt_versions_company_prompt_created_idx" ON "company_prompt_versions" USING btree ("company_id","prompt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_prompt_labels_prompt_name_idx" ON "company_prompt_labels" USING btree ("prompt_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_prompt_labels_company_prompt_idx" ON "company_prompt_labels" USING btree ("company_id","prompt_id");
