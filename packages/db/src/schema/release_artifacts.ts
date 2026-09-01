import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { releases } from "./releases.js";

/**
 * The evidence under a product release: the repository TAGS it aggregates.
 *
 * A product release covers every repository the product spans — a FinPilot
 * release covers the backend and the mobile client together — so this is a
 * one-to-many, and the tag rather than the release is what a build system can
 * verify. `commit_sha` is what makes the claim checkable after the fact; it is
 * nullable because a tag can be recorded before it is resolved.
 *
 * This joins the existing attribution fabric rather than duplicating it:
 * resources are already stamped with the workflow/repo/env that created them,
 * and (repo, commit_sha) is the key that lets a release be lined up against
 * those stamps.
 */
export const releaseArtifacts = pgTable(
  "release_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // "owner/repo" as GitHub names it.
    repo: text("repo").notNull(),
    tag: text("tag").notNull(),
    commitSha: text("commit_sha"),
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    releaseIdx: index("release_artifacts_release_idx").on(table.releaseId),
    companyIdx: index("release_artifacts_company_idx").on(table.companyId),
    releaseRepoTagIdx: uniqueIndex("release_artifacts_release_repo_tag_uq").on(
      table.releaseId,
      table.repo,
      table.tag,
    ),
  }),
);
