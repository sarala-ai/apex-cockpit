-- APEX-127 phase 8: jwks table for the better-auth `jwt` plugin.
--
-- Cockpit issues APEX principal JWTs (signed with keys stored here; private_key
-- is encrypted at rest by better-auth) and publishes the public keys at
-- /api/auth/jwks so the gateway can verify tokens locally. Additive; idempotent.

create table if not exists "jwks" (
	"id" text primary key,
	"public_key" text not null,
	"private_key" text not null,
	"created_at" timestamp with time zone not null,
	"expires_at" timestamp with time zone
);
