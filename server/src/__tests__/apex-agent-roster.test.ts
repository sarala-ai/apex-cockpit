/**
 * THE ROSTER, AND ITS WIRING TO THE LIFECYCLES.
 *
 * Two claims are asserted here, and they are the two that would rot silently:
 *
 * 1. Each roster agent has ONE permission surface, declared once, and the
 *    surfaces are actually different from each other — otherwise the roster is
 *    four job titles sharing a blast radius, which is the thing it exists not
 *    to be.
 * 2. Every lifecycle agent step names a roster agent, and the profile the step
 *    declares is the profile the roster declares. Those live in two files; a
 *    drift between them is a step commissioning an agent under the wrong blast
 *    radius, which nothing at runtime would complain about.
 *
 * No database: this is all static definition data, and a test that needs
 * Postgres to check a constant is a test that gets skipped on the host where it
 * mattered.
 */
import { describe, expect, it } from "vitest";
import {
  APEX_AGENT_KEYS,
  APEX_AGENT_ROSTER,
  apexAgentPermissionProfile,
} from "../services/apex-agent-roster.ts";
import { validateBuiltInAgentDefinitions } from "../services/built-in-agents.ts";
import { LIFECYCLE_DEFINITIONS } from "../apex/pipeline/lifecycles.ts";
import {
  PERMISSION_PROFILES,
  derivePermissionPolicy,
  nativeToolsForProfile,
} from "../apex/steps/run-policy.ts";

/** Every agent step across every seeded lifecycle, with its stage key. */
function agentSteps() {
  return LIFECYCLE_DEFINITIONS.flatMap((lifecycle) =>
    lifecycle.stages
      .map((stage) => ({
        lifecycle: lifecycle.key,
        stage: stage.key,
        onEnter: stage.config.onEnter as
          | { type?: string; agentKey?: string; permissions?: { profile?: string } }
          | undefined,
      }))
      .filter((entry) => entry.onEnter?.type === "agent"),
  );
}

describe("the APEX agent roster", () => {
  it("declares four agents, each with a permission profile run-policy understands", () => {
    expect(APEX_AGENT_ROSTER.map((definition) => definition.key)).toEqual([
      "implementer",
      "specifier",
      "design-engineer",
      "product-assistant",
    ]);
    for (const definition of APEX_AGENT_ROSTER) {
      expect(definition.defaultPermissionProfile, `${definition.key} declares no profile`).toBeDefined();
      expect(PERMISSION_PROFILES).toContain(definition.defaultPermissionProfile!);
    }
  });

  /**
   * The roster's whole justification. If every agent had the same profile,
   * these would be four names for one permission surface.
   */
  it("cuts the roster by blast radius — the profiles are genuinely different", () => {
    const profiles = new Set(APEX_AGENT_ROSTER.map((d) => d.defaultPermissionProfile));
    expect(profiles.size).toBeGreaterThan(1);
    expect(apexAgentPermissionProfile(APEX_AGENT_KEYS.implementer)).toBe("bounded");
    expect(apexAgentPermissionProfile(APEX_AGENT_KEYS.designEngineer)).toBe("bounded");
    expect(apexAgentPermissionProfile(APEX_AGENT_KEYS.specifier)).toBe("read-only-broad");
    expect(apexAgentPermissionProfile(APEX_AGENT_KEYS.productAssistant)).toBe("read-repos");
  });

  /**
   * Asserted through the POLICY, not the profile string, because the profile
   * name is a label and the tool grant is the actual boundary. The Specifier
   * must not be able to author a spec and then make the diff true; the Product
   * Assistant must not be able to edit the history it reports on.
   */
  it("gives the Specifier and the Product Assistant no write tools at all", () => {
    for (const key of [APEX_AGENT_KEYS.specifier, APEX_AGENT_KEYS.productAssistant]) {
      const policy = derivePermissionPolicy({ profile: apexAgentPermissionProfile(key) });
      const tools = policy.nativeTools.split(/\s+/);
      // Bare `Bash` is the assertion. The Product Assistant DOES hold Bash
      // scoped to read-only VCS verbs (`Bash(git log:*)`, which is a different
      // token); an unscoped grant is what would let it edit the history it
      // reports on.
      for (const writeTool of ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch"]) {
        expect(tools, `${key} must not be granted ${writeTool}`).not.toContain(writeTool);
      }
      expect(tools).toContain("Read");
      expect(policy.permissionMode).toBe("governed");
    }
  });

  /**
   * The profile alone is a claim about FLOW-commissioned runs only —
   * `derivePermissionPolicy` has exactly two callers and the routine scheduler
   * is neither of them. The Product Assistant's headline job is a routine, so
   * without a grant on its own record its reconstruction run would inherit the
   * adapter's full bypass: an agent shipped as "reads history, writes
   * proposals" that could rewrite the history it was reporting on.
   */
  it("carries the read-repos grant on the Product Assistant's own adapter config, so routine runs are governed too", () => {
    const definition = APEX_AGENT_ROSTER.find((d) => d.key === APEX_AGENT_KEYS.productAssistant);
    const config = definition?.defaultAdapterConfig ?? {};

    expect(config.dangerouslySkipPermissions).toBe(false);
    // Same constant the flow path derives, so the two cannot drift.
    expect(config.allowedTools).toBe(
      derivePermissionPolicy({ profile: "read-repos" }).nativeTools,
    );
    expect(String(config.allowedTools)).toContain("Bash(git log:*)");
    expect(String(config.allowedTools).split(" ")).not.toContain("Bash");

    // A definition in git never carries a credential VALUE — `gh` auth is a
    // reference to a slot an operator fills, and a non-required one so an
    // already-authenticated machine is not blocked.
    expect(definition?.defaultAdapterConfig).not.toHaveProperty("env");
    expect(definition?.defaultAdapterEnv?.GH_TOKEN).toEqual({
      type: "user_secret_ref",
      key: "GH_TOKEN",
      required: false,
    });
  });

  it("gives the Implementer the bounded workspace grant, including write and test execution", () => {
    const policy = derivePermissionPolicy({
      profile: apexAgentPermissionProfile(APEX_AGENT_KEYS.implementer),
    });
    const tools = policy.nativeTools.split(/\s+/);
    expect(tools).toContain("Edit");
    expect(tools).toContain("Bash");
    expect(policy.permissionMode).toBe("governed");
  });

  it("throws on an unknown roster key rather than defaulting to a profile", () => {
    expect(() => apexAgentPermissionProfile("nobody")).toThrow(/Unknown APEX roster agent key/);
  });

  // ─── credentials ──────────────────────────────────────────────────────────

  /**
   * A prior Design Engineer record carried a plaintext PENPOT_PASSWORD and
   * APEX_GATEWAY_TOKEN in `adapterConfig.env` — a real exposure, because an
   * agent record is read back by the API, mirrored into config revisions and
   * carried into portability exports. A definition in git must be incapable of
   * repeating it.
   */
  it("declares credentials as references and never as values", () => {
    for (const definition of APEX_AGENT_ROSTER) {
      for (const [key, binding] of Object.entries(definition.defaultAdapterEnv ?? {})) {
        expect(typeof binding, `${definition.key}.${key} is a bare string`).not.toBe("string");
        expect(["secret_ref", "user_secret_ref"]).toContain(
          (binding as { type: string }).type,
        );
        // A reference carries a key or an id, never a `value`.
        expect(binding).not.toHaveProperty("value");
      }
    }
  });

  /**
   * The Design Engineer holds exactly ONE credential, and it is a Penpot
   * access token rather than the account password: apex-core's Penpot provider
   * prefers `Authorization: Token <token>`, and a token revokes and rotates
   * without touching the account.
   *
   * APEX_GATEWAY_TOKEN is asserted absent on purpose. It is the cockpit
   * server's own credential for calling apex-gateway and nothing in apex/core
   * — the CLI this agent shells — reads it. Binding it here handed an agent a
   * credential it had no call for, and because an unbound declaration is a
   * hard dispatch precondition, it also blocked every Design Engineer run.
   */
  it("gives the Design Engineer only its Penpot access token, by reference", () => {
    const designEngineer = APEX_AGENT_ROSTER.find((d) => d.key === APEX_AGENT_KEYS.designEngineer)!;
    expect(Object.keys(designEngineer.defaultAdapterEnv ?? {}).sort()).toEqual([
      "PENPOT_ACCESS_TOKEN",
    ]);
    expect(designEngineer.defaultAdapterEnv).not.toHaveProperty("APEX_GATEWAY_TOKEN");
    expect(designEngineer.defaultAdapterEnv).not.toHaveProperty("PENPOT_PASSWORD");
    for (const binding of Object.values(designEngineer.defaultAdapterEnv ?? {})) {
      expect(binding).toMatchObject({ type: "user_secret_ref", required: true });
    }
  });

  it("refuses a definition that inlines a credential value", () => {
    expect(() =>
      validateBuiltInAgentDefinitions([
        {
          key: "leaky",
          displayName: "Leaky Agent",
          featureKeys: ["leaky"],
          shortPurpose: "One",
          defaultInstructions: "Do work",
          defaultRole: "general",
          defaultAdapterEnv: { PENPOT_PASSWORD: "hunter2" },
        },
      ]),
    ).toThrow(/must be a secret REFERENCE/);
    expect(() =>
      validateBuiltInAgentDefinitions([
        {
          key: "leaky",
          displayName: "Leaky Agent",
          featureKeys: ["leaky"],
          shortPurpose: "One",
          defaultInstructions: "Do work",
          defaultRole: "general",
          defaultAdapterEnv: { PENPOT_PASSWORD: { type: "plain", value: "hunter2" } },
        },
      ]),
    ).toThrow(/must be a secret REFERENCE/);
  });

  it("refuses a definition whose permission profile run-policy would not recognise", () => {
    expect(() =>
      validateBuiltInAgentDefinitions([
        {
          key: "vague",
          displayName: "Vague Agent",
          featureKeys: ["vague"],
          shortPurpose: "One",
          defaultInstructions: "Do work",
          defaultRole: "general",
          defaultPermissionProfile: "whatever" as never,
        },
      ]),
    ).toThrow(/defaultPermissionProfile must be one of/);
  });

  // ─── the instructions are the product ─────────────────────────────────────

  it("writes real instructions — a job, a boundary, and what to never do", () => {
    for (const definition of APEX_AGENT_ROSTER) {
      const text = definition.defaultInstructions;
      expect(text.length, `${definition.key} has placeholder instructions`).toBeGreaterThan(800);
      expect(text, `${definition.key} still says it belongs to the fork`).not.toMatch(
        /Paperclip's built-in/i,
      );
      expect(text, `${definition.key} states no boundary`).toMatch(/## Boundary/);
      expect(text, `${definition.key} states no prohibition`).toMatch(/## Never/);
      expect(text.startsWith("You are ")).toBe(true);
    }
  });
});

describe("lifecycle agent steps resolve to roster agents", () => {
  it("names a roster agent on every agent step", () => {
    const steps = agentSteps();
    expect(steps.length).toBe(4);
    const rosterKeys = new Set(APEX_AGENT_ROSTER.map((d) => d.key));
    for (const step of steps) {
      expect(step.onEnter?.agentKey, `${step.lifecycle}/${step.stage} names no agent`).toBeDefined();
      expect(rosterKeys, `${step.lifecycle}/${step.stage}`).toContain(step.onEnter!.agentKey!);
    }
  });

  /**
   * The drift that has no runtime symptom: a step declaring `bounded` while
   * the agent it names is the read-only Specifier would commission a run with
   * repo write and nothing would report it.
   */
  it("declares the same permission profile the named agent declares", () => {
    for (const step of agentSteps()) {
      expect(
        step.onEnter?.permissions?.profile,
        `${step.lifecycle}/${step.stage} declares no profile`,
      ).toBe(apexAgentPermissionProfile(step.onEnter!.agentKey!));
    }
  });

  it("wires each lifecycle step to the agent whose hands its job needs", () => {
    const byStep = Object.fromEntries(
      agentSteps().map((step) => [`${step.lifecycle}/${step.stage}`, step.onEnter!.agentKey!]),
    );
    expect(byStep).toEqual({
      "bug/repro_fix": "implementer",
      "design-change/board_diff": "design-engineer",
      "feature/spec": "specifier",
      "feature/tasks": "implementer",
    });
  });

  /** Agent reuse across lifecycles is the norm, not the exception. */
  it("reuses one agent across two lifecycles", () => {
    const implementerSteps = agentSteps().filter((step) => step.onEnter?.agentKey === "implementer");
    expect(implementerSteps.map((step) => step.lifecycle).sort()).toEqual(["bug", "feature"]);
  });

  /**
   * The feature lifecycle is the one that would break under a sticky-first
   * executor order: the Specifier drafts, the Implementer executes, and the
   * case's sticky executor is per-case rather than per-stage.
   */
  it("changes agent mid-lifecycle on the feature process", () => {
    const featureSteps = agentSteps().filter((step) => step.lifecycle === "feature");
    expect(featureSteps.map((step) => step.onEnter!.agentKey)).toEqual(["specifier", "implementer"]);
  });
});

/*
 * The profile is a claim; the adapter config is the control.
 *
 * `derivePermissionPolicy` runs at flow-commission and pipeline-agent-port time
 * only. A ROUTINE-triggered run reaches neither and inherits the claude-local
 * adapter's `dangerouslySkipPermissions: true` default — so an agent declared
 * read-only could write files on the very path its headline job uses. These
 * pin the fix for the whole roster, because the first version of it reached
 * exactly one agent and nobody would have noticed the other three.
 */
describe("every roster agent is governed on every run, not just commissioned ones", () => {
  it("carries an explicit non-bypass adapter config", () => {
    for (const definition of APEX_AGENT_ROSTER) {
      expect(
        definition.defaultAdapterConfig,
        `${definition.key} has no defaultAdapterConfig — a routine run would bypass its profile`,
      ).toBeTruthy();
      expect(
        definition.defaultAdapterConfig?.dangerouslySkipPermissions,
        `${definition.key} would run with permissions skipped`,
      ).toBe(false);
    }
  });

  it("grants exactly what its declared profile means, from one source", () => {
    for (const definition of APEX_AGENT_ROSTER) {
      const profile = definition.defaultPermissionProfile;
      if (!profile) continue;
      expect(
        definition.defaultAdapterConfig?.allowedTools,
        `${definition.key} grants something other than its ${profile} profile`,
      ).toBe(nativeToolsForProfile(profile));
    }
  });

  it("never grants a write tool to an agent declared read-only", () => {
    // The separation the roster exists to enforce: an agent that can edit the
    // spec can make its own diff true, so the Specifier must not reach Edit,
    // Write or an unscoped Bash on ANY path.
    for (const definition of APEX_AGENT_ROSTER) {
      const profile = definition.defaultPermissionProfile;
      if (profile !== "read-only-broad" && profile !== "read-repos") continue;
      const grant = definition.defaultAdapterConfig?.allowedTools ?? "";
      expect(grant, `${definition.key} can Edit`).not.toMatch(/\bEdit\b/);
      expect(grant, `${definition.key} can Write`).not.toMatch(/\bWrite\b/);
      // Scoped `Bash(git log:*)` is fine; a bare `Bash` grant is not.
      expect(grant.split(/\s+/), `${definition.key} has unscoped Bash`).not.toContain("Bash");
    }
  });
});
