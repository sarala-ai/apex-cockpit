import { pgTable, uuid, text, boolean, timestamp, primaryKey, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgs } from "./orgs.js";

/** Who/what set a surface flag (the Veil). Matches
 *  packages/shared/src/validators/surfaces.ts's `surfaceFlagSourceSchema`. */
export const SURFACE_FLAG_SOURCES = ["chat", "api", "user", "default", "rule"] as const;
export type SurfaceFlagSource = (typeof SURFACE_FLAG_SOURCES)[number];

/**
 * Current unveil state of one surface for one org — the Veil. A new org
 * starts with almost every surface veiled; `surface-flags.ts`
 * (server/src/services) reconciles this table against `OrgFacts` due()
 * rules, and an operator or the chat agent can unveil (or re-veil) a surface
 * explicitly. One row per (org, surface); the append-only history of every
 * change lives in `org_surface_flag_events` below.
 *
 * `source: "rule"` never overwrites a flag an operator/chat set explicitly —
 * see surface-flags.ts's reconcile() invariant test.
 */
export const orgSurfaceFlags = pgTable(
  "org_surface_flags",
  {
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    surfaceKey: text("surface_key").notNull(),
    unveiled: boolean("unveiled").notNull().default(false),
    source: text("source").$type<SurfaceFlagSource>().notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.surfaceKey] }),
    orgIdx: index("org_surface_flags_org_idx").on(table.orgId),
    sourceCheck: check(
      "org_surface_flags_source_check",
      sql`${table.source} in ('chat', 'api', 'user', 'default', 'rule')`,
    ),
  }),
);

/** Append-only audit trail for every write to `org_surface_flags` — same
 *  columns plus `id`/`createdAt`, never updated or deleted. */
export const orgSurfaceFlagEvents = pgTable(
  "org_surface_flag_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    surfaceKey: text("surface_key").notNull(),
    unveiled: boolean("unveiled").notNull(),
    source: text("source").$type<SurfaceFlagSource>().notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgSurfaceIdx: index("org_surface_flag_events_org_surface_idx").on(
      table.orgId,
      table.surfaceKey,
      table.createdAt,
    ),
    sourceCheck: check(
      "org_surface_flag_events_source_check",
      sql`${table.source} in ('chat', 'api', 'user', 'default', 'rule')`,
    ),
  }),
);
