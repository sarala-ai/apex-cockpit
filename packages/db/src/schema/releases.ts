import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * A release is the MEASUREMENT BOUNDARY.
 *
 * The intent tree (idea → initiative → project → task → ticket) is a
 * decomposition. A release is the opposite motion: an aggregation ACROSS that
 * tree — several initiatives ship together, so a release is nobody's child.
 * Without this object an evaluator cannot answer "what else changed at the same
 * time", and it reports another initiative's regression as this one's failure.
 *
 * Scoped to `companies`, which at this level holds PRODUCTS (a naming
 * inheritance from the fork; the label is user-visible, the table is not
 * renamed). A release belongs to a product, not a repository: a git tag is a
 * repository artifact and many tags are never product releases at all. The tags
 * live in `release_artifacts` — the tag is the evidence, the release is the
 * object you measure against, promote and roll back.
 *
 * `status` and `closure` are SEPARATE columns, matching the treatment goals
 * received. status is where the release is in its lifecycle
 * (planned → building → released → observing); closure is how it ended
 * (stable / rolled_back / superseded / partially_reverted). A release that is
 * honestly rolled back is a working method and a failed change, and one column
 * cannot say both. closure_reason is the evidence slot.
 *
 * `environment` is TEXT, not a foreign key to `environments`. That table is
 * global and describes agent execution drivers (local / ssh / sandbox), not
 * deployment targets; a release promotes through named deployment environments
 * ("dev", "staging", "production") that differ per product. A promotion is a
 * NEW ROW with `promoted_from_release_id` pointing at its predecessor, so the
 * chain is queryable and each environment keeps its own observation window.
 */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    version: text("version").notNull(),
    name: text("name"),
    status: text("status").notNull().default("planned"),
    closure: text("closure"),
    closureReason: text("closure_reason"),
    environment: text("environment").notNull(),
    promotedFromReleaseId: uuid("promoted_from_release_id")
      .references((): AnyPgColumn => releases.id, { onDelete: "set null" }),
    // When the change actually reached the world. NULL until status='released'
    // — a planned release changed nothing and must never confound a window.
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // The far edge of the measurement window. NULL means "no window declared";
    // the window then degenerates to the instant of release.
    observationWindowEndsAt: timestamp("observation_window_ends_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("releases_company_idx").on(table.companyId),
    companyStatusIdx: index("releases_company_status_idx").on(table.companyId, table.status),
    // The confound query is "which releases of this product overlap this
    // window" — company + released_at is the access path.
    companyReleasedAtIdx: index("releases_company_released_at_idx").on(
      table.companyId,
      table.releasedAt,
    ),
    promotedFromIdx: index("releases_promoted_from_idx").on(table.promotedFromReleaseId),
    // One version per environment per product. The same version promoted to
    // staging and to production is two rows, and that is the point.
    companyVersionEnvIdx: uniqueIndex("releases_company_version_environment_uq").on(
      table.companyId,
      table.version,
      table.environment,
    ),
  }),
);
