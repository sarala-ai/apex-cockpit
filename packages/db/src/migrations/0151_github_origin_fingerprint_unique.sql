CREATE UNIQUE INDEX IF NOT EXISTS "issues_github_origin_fingerprint_uq" ON "issues" USING btree ("company_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'plugin:github';
