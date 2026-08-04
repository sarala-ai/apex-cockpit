import { describe, expect, it } from "vitest";
import {
  buildTicketTypeOptions,
  startTicketLifecycle,
} from "../apex/pipeline/ticket-lifecycle.js";
import { LIFECYCLE_DEFINITIONS } from "../apex/pipeline/lifecycles.js";

/** A `pipelines` row as far as the shaping function cares. */
function pipelineRow(ticketType: string, overrides: Partial<{ id: string; key: string; name: string }> = {}) {
  return {
    id: overrides.id ?? `pipeline-${ticketType}`,
    key: overrides.key ?? ticketType,
    name: overrides.name ?? ticketType,
    ticketType,
  };
}

function agentStage(pipelineId: string, profile: string) {
  return { pipelineId, config: { onEnter: { type: "agent", permissions: { profile } } } };
}

describe("type maps to a process by lookup", () => {
  it("reports every seeded lifecycle against its ticket type", () => {
    // Drives the assertion from the seeder itself rather than a copied list,
    // so a lifecycle added or renamed there cannot silently stop appearing.
    const rows = LIFECYCLE_DEFINITIONS.map((definition) =>
      pipelineRow(definition.ticketType, { id: definition.key, key: definition.key, name: definition.name }),
    );
    const options = buildTicketTypeOptions({ pipelines: rows, stages: [] });

    for (const definition of LIFECYCLE_DEFINITIONS) {
      const option = options.find((entry) => entry.ticketType === definition.ticketType);
      expect(option, `no option for ${definition.ticketType}`).toBeDefined();
      expect(option!.pipelineKey).toBe(definition.key);
      expect(option!.processlessByDesign).toBe(false);
    }
  });

  it("chore is offered, has no pipeline, and says the absence is by design", () => {
    const options = buildTicketTypeOptions({
      pipelines: LIFECYCLE_DEFINITIONS.map((definition) => pipelineRow(definition.ticketType)),
      stages: [],
    });
    const chore = options.find((entry) => entry.ticketType === "chore");
    expect(chore).toBeDefined();
    expect(chore!.pipelineId).toBeNull();
    expect(chore!.processlessByDesign).toBe(true);
  });

  it("distinguishes a missing pipeline from a type that has none by design", () => {
    // Nothing seeded at all: bug has no process HERE, but not by design.
    const options = buildTicketTypeOptions({ pipelines: [], stages: [] });
    const bug = options.find((entry) => entry.ticketType === "bug")!;
    const chore = options.find((entry) => entry.ticketType === "chore")!;
    expect(bug.pipelineId).toBeNull();
    expect(bug.processlessByDesign).toBe(false);
    expect(chore.processlessByDesign).toBe(true);
  });

  it("ignores a pipeline that declares no ticket type", () => {
    const options = buildTicketTypeOptions({
      pipelines: [{ id: "p", key: "support", name: "Support", ticketType: null }],
      stages: [],
    });
    expect(options.every((entry) => entry.pipelineId === null)).toBe(true);
  });
});

describe("which types demand a codebase", () => {
  it("is true when any agent stage runs under the bounded profile", () => {
    const options = buildTicketTypeOptions({
      pipelines: [pipelineRow("bug")],
      stages: [agentStage("pipeline-bug", "bounded")],
    });
    expect(options.find((entry) => entry.ticketType === "bug")!.commissionsRepoWritingAgent).toBe(true);
  });

  it("is false when every agent stage is read-only", () => {
    const options = buildTicketTypeOptions({
      pipelines: [pipelineRow("feature")],
      stages: [
        agentStage("pipeline-feature", "read-only-broad"),
        agentStage("pipeline-feature", "read-repos"),
      ],
    });
    expect(options.find((entry) => entry.ticketType === "feature")!.commissionsRepoWritingAgent).toBe(false);
  });

  it("is true if ONE of several agent stages writes repos", () => {
    // The feature lifecycle's real shape: a read-only Specifier followed by a
    // bounded Implementer. One bounded step is enough to need a checkout.
    const options = buildTicketTypeOptions({
      pipelines: [pipelineRow("feature")],
      stages: [
        agentStage("pipeline-feature", "read-only-broad"),
        agentStage("pipeline-feature", "bounded"),
      ],
    });
    expect(options.find((entry) => entry.ticketType === "feature")!.commissionsRepoWritingAgent).toBe(true);
  });

  it("resolves the profile from the roster when a stage names an agent without one", () => {
    const options = buildTicketTypeOptions({
      pipelines: [pipelineRow("feature")],
      stages: [{ pipelineId: "pipeline-feature", config: { onEnter: { type: "agent", agentKey: "specifier" } } }],
    });
    expect(options.find((entry) => entry.ticketType === "feature")!.commissionsRepoWritingAgent).toBe(false);
  });

  it("assumes the run-policy default for an agent step that names nobody", () => {
    // `derivePermissionPolicy` falls back to `bounded` for an unresolvable
    // step, so the honest answer is "yes, it will want code" — not silence.
    const options = buildTicketTypeOptions({
      pipelines: [pipelineRow("bug")],
      stages: [{ pipelineId: "pipeline-bug", config: { onEnter: { type: "agent" } } }],
    });
    expect(options.find((entry) => entry.ticketType === "bug")!.commissionsRepoWritingAgent).toBe(true);
  });

  it("ignores run and gate stages", () => {
    const options = buildTicketTypeOptions({
      pipelines: [pipelineRow("bug")],
      stages: [
        { pipelineId: "pipeline-bug", config: { onEnter: { type: "run", target: { type: "command" } } } },
        { pipelineId: "pipeline-bug", config: { requireApproval: true } },
      ],
    });
    expect(options.find((entry) => entry.ticketType === "bug")!.commissionsRepoWritingAgent).toBe(false);
  });
});

describe("startTicketLifecycle refuses to guess", () => {
  const neverTouchedDb = new Proxy({} as never, {
    get() {
      throw new Error("startTicketLifecycle must not query for a type it can answer without one");
    },
  });

  it("does nothing for a ticket with no declared type", async () => {
    await expect(
      startTicketLifecycle(neverTouchedDb, {
        companyId: "c1",
        issue: { id: "i1", identifier: "APEX-1", title: "t", description: null, ticketType: null },
        actor: { type: "system" },
      }),
    ).resolves.toEqual({ status: "not_typed" });
  });

  it("does not treat an unrecognised type as a lifecycle", async () => {
    await expect(
      startTicketLifecycle(neverTouchedDb, {
        companyId: "c1",
        issue: { id: "i1", identifier: null, title: "t", description: null, ticketType: "spike" },
        actor: { type: "system" },
      }),
    ).resolves.toEqual({ status: "not_typed" });
  });

  it("short-circuits chore BEFORE touching the database", async () => {
    await expect(
      startTicketLifecycle(neverTouchedDb, {
        companyId: "c1",
        issue: { id: "i1", identifier: "APEX-2", title: "t", description: null, ticketType: "chore" },
        actor: { type: "system" },
      }),
    ).resolves.toEqual({
      status: "no_process",
      ticketType: "chore",
      reason: "type_has_no_process",
    });
  });
});
