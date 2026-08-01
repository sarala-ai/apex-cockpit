-- One-time backfill: slug is write-once (see companyService.update — any change to a
-- non-null slug is rejected as a classified conflict). This backfill IS the one-time
-- set for companies created before the slug column existed.
UPDATE "companies"
SET "slug" = lower("issue_prefix")
WHERE "slug" IS NULL;
