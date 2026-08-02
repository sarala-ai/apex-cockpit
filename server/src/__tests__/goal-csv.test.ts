import { describe, expect, it } from "vitest";
import {
  CLEAR_TOKEN,
  UTF8_BOM,
  buildGoalCsv,
  buildProposalCsv,
  csvEscape,
  parseCsv,
  parseGoalCsv,
  planRow,
  readCell,
  type ExistingInitiative,
  type ExportGoal,
} from "../services/goal-csv.js";

function goal(overrides: Partial<ExportGoal> = {}): ExportGoal {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Run FinPilot and Bloom through APEX",
    description: null,
    level: "initiative",
    status: "planned",
    parentId: null,
    ownerAgentId: null,
    derivedStatus: "active",
    closure: null,
    closureReason: null,
    assumptions: null,
    budget: null,
    stopCondition: null,
    hypothesis: null,
    validationCriteria: null,
    provenance: { kind: "inferred", source: "47 commits, March–May" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ExportGoal;
}

function parsedRow(cells: Record<string, string>, row = 2) {
  return { row, cells: new Map(Object.entries(cells)) };
}

function existing(overrides: Partial<ExistingInitiative> = {}): ExistingInitiative {
  return {
    id: "goal-1",
    title: "Run FinPilot and Bloom through APEX",
    description: "The migration",
    closure: null,
    closureReason: null,
    hypothesis: "Teams adopt it once one product ships on it",
    budget: "8 weeks",
    stopCondition: null,
    provenance: { kind: "inferred", source: "47 commits" },
    derivedStatus: "active",
    assumptions: [{ id: "a1", statement: "x", type: "technical", status: "untested" }],
    validationCriteria: null,
    ...overrides,
  } as ExistingInitiative;
}

describe("CSV encoding", () => {
  it("quotes delimiters, quotes and newlines, and doubles embedded quotes", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line one\nline two")).toBe('"line one\nline two"');
  });

  it("round-trips a field containing a comma, a quote and a newline", () => {
    const value = 'Ship it, then "measure"\nby May';
    const grid = parseCsv(`a,b\n${csvEscape(value)},z\n`);
    expect(grid[1][0]).toBe(value);
    expect(grid[1][1]).toBe("z");
  });

  it("normalises CRLF inside a quoted field so a Windows sheet round-trips", () => {
    const grid = parseCsv('a\r\n"one\r\ntwo"\r\n');
    expect(grid[1][0]).toBe("one\ntwo");
  });

  it("strips a BOM so the first header is not silently unmatched", () => {
    const grid = parseCsv(`${UTF8_BOM}id,title\nx,y\n`);
    expect(grid[0][0]).toBe("id");
  });
});

describe("export", () => {
  it("starts with a BOM so Excel reads UTF-8 correctly", () => {
    expect(buildGoalCsv([goal()], new Map()).startsWith(UTF8_BOM)).toBe(true);
  });

  it("marks computed columns read-only in the header", () => {
    const csv = buildGoalCsv([], new Map());
    expect(csv).toContain("derived_status (read-only");
    expect(csv).toContain("projects (read-only");
  });

  it("documents the blank-vs-clear convention in the header row", () => {
    // Quoted, so the token's own quotes are doubled — read it back through the
    // parser rather than asserting on the raw bytes.
    const [header] = parseCsv(buildGoalCsv([], new Map()));
    expect(header[0]).toContain('blank cell = unchanged; "--" clears');
  });

  it("summarises projects as name:status pairs", () => {
    const csv = buildGoalCsv(
      [goal()],
      new Map([
        [
          "goal-1",
          [
            { id: "p1", name: "Cloud Run provider", status: "completed", createdAt: new Date(1) },
            { id: "p2", name: "Secrets", status: "in_progress", createdAt: new Date(2) },
          ],
        ],
      ]),
    );
    expect(csv).toContain("Cloud Run provider:completed; Secrets:in_progress");
  });

  it("keeps counts and provenance in separate columns", () => {
    const csv = buildGoalCsv(
      [
        goal({
          assumptions: [
            { id: "a1", statement: "s", type: "technical", status: "untested" },
          ] as never,
          validationCriteria: [] as never,
        }),
      ],
      new Map(),
    );
    const dataLine = csv.trim().split("\r\n")[1];
    expect(dataLine).toContain("inferred");
    expect(dataLine).toContain("47 commits, March–May");
    expect(dataLine.endsWith(",1,0,")).toBe(true);
  });
});

describe("parseGoalCsv", () => {
  it("matches headers with their read-only annotations stripped", () => {
    const csv = buildGoalCsv([goal()], new Map());
    const { rows } = parseGoalCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.get("id")).toBe("goal-1");
    expect(rows[0].cells.get("derived_status")).toBe("active");
  });

  it("reports unrecognised columns as a note rather than failing", () => {
    const { notes } = parseGoalCsv("id,title,owner_email\nx,y,z\n");
    expect(notes.join(" ")).toContain("owner_email");
  });

  it("drops the trailing empty line Excel adds, without calling it malformed", () => {
    const { rows } = parseGoalCsv("id,title\n,First\n\n");
    expect(rows).toHaveLength(1);
  });

  it("numbers rows by their file line, header included, so a human can find them", () => {
    const { rows } = parseGoalCsv("id,title\n,A\n,B\n");
    expect(rows.map((row) => row.row)).toEqual([2, 3]);
  });
});

describe("readCell — the blank-vs-clear contract", () => {
  it("treats a blank cell as unchanged", () => {
    expect(readCell(new Map([["budget", "   "]]), "budget")).toBeUndefined();
  });

  it("treats a missing column as unchanged", () => {
    expect(readCell(new Map(), "budget")).toBeUndefined();
  });

  it("treats the clear token as an explicit null", () => {
    expect(readCell(new Map([["budget", CLEAR_TOKEN]]), "budget")).toBeNull();
  });

  it("passes any other value through trimmed", () => {
    expect(readCell(new Map([["budget", " 8 weeks "]]), "budget")).toBe("8 weeks");
  });
});

describe("planRow", () => {
  it("reports no change when every editable cell is blank", () => {
    const { result, patch } = planRow(parsedRow({ id: "goal-1", title: "" }), existing(), null);
    expect(result.action).toBe("unchanged");
    expect(patch).toBeUndefined();
  });

  it("leaves untouched fields alone when one cell is edited", () => {
    const { result, patch } = planRow(
      parsedRow({ id: "goal-1", budget: "12 weeks" }),
      existing(),
      null,
    );
    expect(result.action).toBe("update");
    expect(patch).toEqual({ budget: "12 weeks" });
    expect(result.changes).toEqual([{ field: "budget", from: "8 weeks", to: "12 weeks" }]);
  });

  it("clears a field on the explicit token", () => {
    const { patch } = planRow(
      parsedRow({ id: "goal-1", hypothesis: CLEAR_TOKEN }),
      existing(),
      null,
    );
    expect(patch).toEqual({ hypothesis: null });
  });

  it("creates when the id cell is blank", () => {
    const { result, patch } = planRow(parsedRow({ id: "", title: "New initiative" }), null, null);
    expect(result.action).toBe("create");
    expect(patch?.title).toBe("New initiative");
  });

  it("refuses to create a row with no title, without throwing", () => {
    const { result } = planRow(parsedRow({ id: "", budget: "2 weeks" }), null, null);
    expect(result.action).toBe("error");
    expect(result.error).toContain("title is required");
  });

  it("refuses to clear a title", () => {
    const { result } = planRow(parsedRow({ id: "goal-1", title: CLEAR_TOKEN }), existing(), null);
    expect(result.action).toBe("error");
  });

  it("ignores derived_status and reports it as a notice, not an error", () => {
    const { result } = planRow(
      parsedRow({ id: "goal-1", derived_status: "delivered" }),
      existing(),
      null,
    );
    expect(result.action).toBe("unchanged");
    expect(result.notices.join(" ")).toContain("derived_status is computed");
  });

  it("reports an edited projects column as ignored rather than dropping it silently", () => {
    const { result } = planRow(
      parsedRow({ id: "goal-1", projects: "Something else:completed" }),
      existing(),
      "Cloud Run:completed",
    );
    expect(result.notices.join(" ")).toContain("projects is computed");
  });

  it("rejects an unknown closure with a row error", () => {
    const { result } = planRow(parsedRow({ id: "goal-1", closure: "shipped" }), existing(), null);
    expect(result.action).toBe("error");
    expect(result.error).toContain("closure must be one of");
  });

  it("keeps the stored provenance kind when only the source is edited", () => {
    const { patch } = planRow(
      parsedRow({ id: "goal-1", provenance_source: "design doc" }),
      existing(),
      null,
    );
    expect(patch?.provenance).toEqual({ kind: "inferred", source: "design doc" });
  });

  it("refuses a provenance source with no kind anywhere", () => {
    const { result } = planRow(
      parsedRow({ id: "", title: "New", provenance_source: "a doc" }),
      null,
      null,
    );
    expect(result.action).toBe("error");
    expect(result.error).toContain("provenance_kind is required");
  });

  it("clears provenance entirely when the kind is cleared", () => {
    const { patch } = planRow(
      parsedRow({ id: "goal-1", provenance_kind: CLEAR_TOKEN }),
      existing(),
      null,
    );
    expect(patch?.provenance).toBeNull();
  });

  it("never invents a stop condition", () => {
    const { patch } = planRow(parsedRow({ id: "goal-1", budget: "9 weeks" }), existing(), null);
    expect(patch).not.toHaveProperty("stopCondition");
  });

  it("errors on an id that does not exist in this company", () => {
    const { result } = planRow(parsedRow({ id: "other-company-goal" }), null, null);
    expect(result.action).toBe("error");
    expect(result.error).toContain("No initiative with id");
  });
});

describe("THE ROUND-TRIP INVARIANT", () => {
  it("export → import reports zero changes when nothing was edited", () => {
    const goals = [
      goal({
        id: "goal-1",
        description: "Multi-line\ndescription, with a comma",
        hypothesis: 'They will say "yes"',
        budget: "8 weeks",
      }),
      goal({ id: "goal-2", title: "State that survives the run", closure: "validated" as never }),
    ];
    const projectsByGoal = new Map([
      ["goal-1", [{ id: "p1", name: "Cloud Run", status: "completed", createdAt: new Date(1) }]],
    ]);
    const csv = buildGoalCsv(goals, projectsByGoal);

    const { rows } = parseGoalCsv(csv);
    const results = rows.map((row) => {
      const found = goals.find((candidate) => candidate.id === row.cells.get("id"))!;
      const projectsCell = (projectsByGoal.get(found.id) ?? [])
        .map((project) => `${project.name}:${project.status}`)
        .join("; ");
      return planRow(row, found as unknown as ExistingInitiative, projectsCell).result;
    });

    expect(results.map((result) => result.action)).toEqual(["unchanged", "unchanged"]);
    expect(results.flatMap((result) => result.changes)).toEqual([]);
    expect(results.flatMap((result) => result.notices)).toEqual([]);
  });
});

describe("buildProposalCsv", () => {
  it("renders the kind's columns and marks the identity columns read-only", () => {
    const csv = buildProposalCsv(
      [
        {
          ref: "r1",
          targetId: "goal-1",
          provenance: { kind: "inferred", source: "47 commits" },
          fields: { title: "Run FinPilot through APEX", budget: "8 weeks" },
          note: "This one is really two",
        },
        {
          ref: "r2",
          provenance: { kind: "confirmed", source: "design doc" },
          fields: { title: "New one" },
          excluded: true,
        },
      ],
      [
        { key: "title", label: "Title" },
        { key: "budget", label: "Budget" },
      ],
    );
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const [header, first, second] = csv.trim().split("\r\n");
    expect(header).toContain("action (create|update — read-only)");
    expect(first).toContain("update");
    expect(first).toContain("This one is really two");
    expect(second).toContain("create");
    expect(second).toContain("yes");
  });
});
