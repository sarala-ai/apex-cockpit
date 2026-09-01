-- APEX-127 phase 3: identity-projection columns on "user" (additive, nullable).
--
-- idp_issuer  → OIDC issuer / SAML entityID / "local"
-- idp_subject → the IdP's stable subject ("sub")
--
-- Both nullable during rollout (a later phase backfills "local" for existing
-- accounts and, once total, may enforce NOT NULL). The unique index is PARTIAL
-- — it applies only when both columns are non-null — so it never collides on the
-- current all-null rows and never blocks better-auth's own inserts. Idempotent.

alter table "user" add column if not exists "idp_issuer" text;
--> statement-breakpoint
alter table "user" add column if not exists "idp_subject" text;
--> statement-breakpoint
create unique index if not exists "user_idp_issuer_subject_unique_idx"
  on "user" ("idp_issuer", "idp_subject")
  where "idp_issuer" is not null and "idp_subject" is not null;
