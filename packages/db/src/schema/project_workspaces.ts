import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const projectWorkspaces = pgTable(
  "project_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull().default("local_path"),
    cwd: text("cwd"),
    repoUrl: text("repo_url"),
    repoRef: text("repo_ref"),
    defaultRef: text("default_ref"),
    visibility: text("visibility").notNull().default("default"),
    setupCommand: text("setup_command"),
    cleanupCommand: text("cleanup_command"),
    // How THIS project's work is verified and shipped — read at dispatch time
    // by lifecycle `contract` run targets (checks_pass / deployed), so a
    // seeded lifecycle can name the contract without hardcoding a tool
    // (pytest, cloud_run_deploy) that is wrong for every other stack.
    checkCommand: text("check_command"),
    deployWorkflow: text("deploy_workflow"),
    // WHERE THIS PROJECT'S DESIGN LIVES — read at dispatch time so the design
    // lifecycle can name the coordinate without hardcoding one company's
    // repository. `designRepo` null means design lives in this project's own
    // repo (the monorepo case), derived from `repoUrl`; `designPath` is the
    // folder within whichever repo won, null meaning the root.
    designRepo: text("design_repo"),
    designPath: text("design_path"),
    remoteProvider: text("remote_provider"),
    remoteWorkspaceRef: text("remote_workspace_ref"),
    sharedWorkspaceKey: text("shared_workspace_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_workspaces_company_project_idx").on(table.companyId, table.projectId),
    projectPrimaryIdx: index("project_workspaces_project_primary_idx").on(table.projectId, table.isPrimary),
    projectSourceTypeIdx: index("project_workspaces_project_source_type_idx").on(table.projectId, table.sourceType),
    companySharedKeyIdx: index("project_workspaces_company_shared_key_idx").on(table.companyId, table.sharedWorkspaceKey),
    projectRemoteRefIdx: uniqueIndex("project_workspaces_project_remote_ref_idx")
      .on(table.projectId, table.remoteProvider, table.remoteWorkspaceRef),
  }),
);
