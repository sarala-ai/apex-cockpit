import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issues } from "./schema/issues.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const journal = JSON.parse(
  readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

describe("issues.agent_brief", () => {
  it("is a nullable text column — the split never rewrites an existing ticket", () => {
    const column = getTableConfig(issues).columns.find((candidate) => candidate.name === "agent_brief");
    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe("text");
    expect(column?.notNull).toBe(false);
    expect(column?.hasDefault).toBe(false);
  });

  it("keeps description as its own column — the brief is added beside it, never instead of it", () => {
    const names = getTableConfig(issues).columns.map((column) => column.name);
    expect(names).toContain("description");
    expect(names).toContain("agent_brief");
  });

  it("ships as an additive migration registered in the journal", () => {
    const entry = journal.entries.find((candidate) => candidate.tag === "0158_issue_agent_brief");
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(158);
    expect(Math.max(...journal.entries.map((candidate) => candidate.idx))).toBe(158);

    const sql = readFileSync(join(migrationsDir, "0158_issue_agent_brief.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "agent_brief" text;/);
    // Additive only: nothing is dropped, backfilled, or moved out of description.
    expect(sql).not.toMatch(/DROP|UPDATE\s+"?issues"?/i);
  });
});
