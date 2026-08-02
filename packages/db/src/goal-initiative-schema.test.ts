import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { goals } from "./schema/goals.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const journal = JSON.parse(
  readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

const columns = () => getTableConfig(goals).columns;
const column = (name: string) => columns().find((candidate) => candidate.name === name);

describe("goals initiative columns", () => {
  it.each([
    ["closure", "text"],
    ["closure_reason", "text"],
    ["budget", "text"],
    ["stop_condition", "text"],
    ["hypothesis", "text"],
    ["assumptions", "jsonb"],
  ])("adds %s as a nullable %s column with no default", (name, sqlType) => {
    const col = column(name);
    expect(col, `${name} column missing`).toBeDefined();
    expect(col?.getSQLType()).toBe(sqlType);
    // Nullable with no default: every existing goal predates the initiative
    // level, and a default would declare something nobody checked.
    expect(col?.notNull).toBe(false);
    expect(col?.hasDefault).toBe(false);
  });

  it("keeps status as its own column — closure is added beside it, never instead of it", () => {
    const names = columns().map((col) => col.name);
    expect(names).toContain("status");
    expect(names).toContain("closure");
    expect(column("status")?.notNull).toBe(true);
  });

  it("ships as an additive migration registered in the journal", () => {
    const entry = journal.entries.find((candidate) => candidate.tag === "0161_goal_initiative");
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(161);

    const sql = readFileSync(join(migrationsDir, "0161_goal_initiative.sql"), "utf8");
    for (const name of [
      "closure",
      "closure_reason",
      "assumptions",
      "budget",
      "stop_condition",
      "hypothesis",
    ]) {
      expect(sql).toContain(`ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "${name}"`);
    }
    // Additive only: nothing dropped, nothing backfilled, no existing row touched.
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/UPDATE\s+"?goals"?/i);
    expect(sql).not.toMatch(/NOT NULL/i);
  });

  it("registers the migration exactly once, directly after the previous head", () => {
    // Asserted RELATIVE to 0160, not as the journal's last entry: pinning the
    // tail made this test fail on every later migration (0162 already broke
    // it), which teaches people to edit the assertion instead of reading it.
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags.filter((tag) => tag === "0161_goal_initiative")).toHaveLength(1);
    expect(tags[tags.indexOf("0161_goal_initiative") - 1]).toBe("0160_agent_roster_kind");
  });
});

describe("goals validation-criteria columns", () => {
  it.each([
    ["validation_criteria", "jsonb"],
    ["provenance", "jsonb"],
  ])("adds %s as a nullable %s column with no default", (name, sqlType) => {
    const col = column(name);
    expect(col, `${name} column missing`).toBeDefined();
    expect(col?.getSQLType()).toBe(sqlType);
    // A default here would declare that something was registered when nobody
    // registered it — the fabrication the onboarding doctrine prevents.
    expect(col?.notNull).toBe(false);
    expect(col?.hasDefault).toBe(false);
  });

  it("adds criteria BESIDE stop_condition, never instead of it", () => {
    // Prose stays as the summary; the criteria are the part that can carry a
    // reader and a date and be marked hit or missed.
    const names = columns().map((col) => col.name);
    expect(names).toContain("stop_condition");
    expect(names).toContain("validation_criteria");
  });

  it("ships as an additive migration registered in the journal", () => {
    const entry = journal.entries.find(
      (candidate) => candidate.tag === "0163_goal_validation_criteria",
    );
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(163);

    const sql = readFileSync(join(migrationsDir, "0163_goal_validation_criteria.sql"), "utf8");
    for (const name of ["validation_criteria", "provenance"]) {
      expect(sql).toContain(`ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "${name}"`);
    }
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/UPDATE\s+"?goals"?/i);
    expect(sql).not.toMatch(/NOT NULL/i);
  });
});
