import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  budgetPolicies,
  builtInManagedResources,
  companies,
  companyMemberships,
  companySkillVersions,
  companySkills,
  createDb,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.ts";
import { agentInstructionsService } from "../services/agent-instructions.ts";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import {
  builtInAgentService,
  deriveBuiltInAgentStatus,
  listBuiltInAgentDefinitions,
  reconcileBuiltInAgentsOnStartup,
  validateBuiltInAgentDefinitions,
} from "../services/built-in-agents.ts";
import { readBuiltInAgentMarker, withBuiltInAgentMarker } from "../services/built-in-agent-metadata.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres built-in agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("built-in agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-built-in-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(builtInManagedResources);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(budgetPolicies);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function permissionKeysForAgent(agentId: string) {
    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId));
    return grants.map((grant) => grant.permissionKey).sort();
  }

  async function seedCompany(options: { requireApproval?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: options.requireApproval ?? true,
    });
    return companyId;
  }

  it("validates the static registry and rejects invalid definitions", () => {
    // The catalogue IS the roster — nothing else. The three definitions
    // inherited from the upstream fork (briefs, learning, reflection-coach)
    // were removed; this assertion is the guard against one drifting back in,
    // because an inherited built-in is auto-provisioned into every company and
    // does no job any lifecycle declares.
    expect(listBuiltInAgentDefinitions().map((definition) => definition.key).sort()).toEqual([
      // The APEX roster — the agents this product's own lifecycles commission,
      // cut by permission surface (server/src/services/apex-agent-roster.ts).
      "design-engineer",
      "implementer",
      "product-assistant",
      "specifier",
    ].sort());
    expect(() => validateBuiltInAgentDefinitions([
      {
        key: "sample",
        displayName: "Sample Agent",
        featureKeys: ["sample"],
        shortPurpose: "One",
        defaultInstructions: "Do work",
        defaultRole: "general",
      },
      {
        key: "sample",
        displayName: "Duplicate",
        featureKeys: ["duplicate"],
        shortPurpose: "Two",
        defaultInstructions: "Do work",
        defaultRole: "general",
      },
    ])).toThrow("Duplicate built-in agent key");
    expect(() => validateBuiltInAgentDefinitions([
      {
        key: "Bad Key",
        displayName: "Bad",
        featureKeys: ["bad"],
        shortPurpose: "Bad",
        defaultInstructions: "Bad",
        defaultRole: "general",
      },
    ])).toThrow("Invalid built-in agent key");
  });

  /**
   * The brownfield reconstruction routine. These assertions are the parts a
   * later edit could quietly undo while the routine still "worked": a routine
   * that runs on a schedule spends money nobody asked for, and a routine whose
   * body stops forbidding direct writes is an agent editing the board it is
   * supposed to be describing.
   */
  it("ships the Product Assistant reconstruction routine paused, unscheduled and proposal-only", () => {
    const definition = listBuiltInAgentDefinitions().find((entry) => entry.key === "product-assistant");
    const routine = definition?.bundle?.routine;
    expect(routine?.routineKey).toBe("reconstruct-initiatives");

    // Spends nothing until someone asks for it — on BOTH switches.
    expect(routine?.status).toBe("paused");
    expect(routine?.triggers.every((trigger) => trigger.enabled)).toBe(false);

    // Bounded: a reviewer's reading budget, not an agent's ambition.
    expect(routine?.variables.map((variable) => variable.name).sort()).toEqual([
      "lookbackDays",
      "maxRecords",
      "recordKind",
      "repoPaths",
    ]);
    expect(routine?.concurrencyPolicy).toBe("coalesce_if_active");
    expect(routine?.catchUpPolicy).toBe("skip_missed");

    // No skill: the doctrine lives in one file so two files cannot drift.
    expect(definition?.bundle?.skill).toBeUndefined();

    const body = routine?.description ?? "";
    expect(body).toContain("Reconstruct evidence. Propose structure. Never assert intent.");
    expect(body).toContain("Proposal-only.");
    expect(body).toContain("Never retro-fit a stop condition");
    expect(body).toContain("Absence is reported, never filled in");
    // Its only write path, named — and nothing that writes to the board direct.
    expect(body).toContain("paperclipCreateProposal");
    expect(body).toContain("paperclipSubmitProposal");
  });

  it("lazily provisions one agent per company/key and updates the same row on setup", async () => {
    const companyId = await seedCompany();
    const svc = builtInAgentService(db);

    const created = await svc.ensure(companyId, "specifier");
    expect(created.status).toBe("needs_setup");
    expect(created.agentId).toBeTruthy();
    expect(created.agent).toMatchObject({
      companyId,
      name: "Specifier",
      adapterConfig: {},
      status: "idle",
    });
    expect(readBuiltInAgentMarker(created.agent?.metadata)).toEqual({
      key: "specifier",
      featureKeys: ["lifecycle-feature-spec"],
    });

    const configured = await svc.ensure(companyId, "specifier", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    expect(configured.status).toBe("ready");
    expect(configured.agentId).toBe(created.agentId);
    expect(configured.agent).toMatchObject({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    const reconciled = await svc.ensure(companyId, "specifier");
    expect(reconciled.status).toBe("ready");
    expect(reconciled.agent).toMatchObject({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("routes policy-gated built-in provisioning through a pending hire approval", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);

    const result = await builtIns.provision(companyId, "specifier", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      budgetMonthlyCents: 5000,
    }, { requestedByUserId: "board-user" });

    expect(result.state).toMatchObject({
      status: "pending_approval",
      agent: {
        companyId,
        name: "Specifier",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        budgetMonthlyCents: 5000,
      },
    });
    expect(result.approval).toMatchObject({
      companyId,
      type: "hire_agent",
      status: "pending",
      requestedByUserId: "board-user",
      requestedByAgentId: null,
      payload: {
        name: "Specifier",
        role: "product",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        budgetMonthlyCents: 5000,
        agentId: result.state.agentId,
        sourceBuiltInAgentKey: "specifier",
        featureKeys: ["lifecycle-feature-spec"],
      },
    });

    const rowsBeforeApproval = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rowsBeforeApproval).toHaveLength(1);
    expect(rowsBeforeApproval[0]).toMatchObject({ status: "pending_approval" });

    await expect(builtIns.requireBuiltInAgent(companyId, "specifier")).rejects.toMatchObject({
      status: 412,
      details: { code: "built_in_agent_not_configured", status: "pending_approval" },
    });

    await expect(agentService(db).update(result.state.agentId!, {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-tampered" },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: result.state.agentId,
        fields: ["adapterConfig"],
      },
    });

    await expect(builtIns.provision(companyId, "specifier", {
      budgetMonthlyCents: 7500,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_pending_approval",
        key: "specifier",
        agentId: result.state.agentId,
      },
    });

    await db
      .update(agents)
      .set({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-tampered" },
      })
      .where(eq(agents.id, result.state.agentId!));

    await approvalService(db).approve(result.approval!.id, "board-user", "Approved built-in agent");

    await expect(builtIns.get(companyId, "specifier")).resolves.toMatchObject({
      status: "ready",
      agentId: result.state.agentId,
      agent: { status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, budgetMonthlyCents: 5000 },
    });
  });

  it("blocks policy-gated built-in reconfiguration instead of applying adapter overrides immediately", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);
    const ready = await builtIns.ensure(companyId, "specifier", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    await expect(builtIns.provision(companyId, "specifier", {
      adapterType: "opencode_local",
      adapterConfig: { model: "bypass" },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_reconfiguration_requires_approval",
        key: "specifier",
        agentId: ready.agentId,
      },
    });

    await expect(builtIns.get(companyId, "specifier")).resolves.toMatchObject({
      status: "ready",
      agentId: ready.agentId,
      agent: { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
    });
  });

  it("rejects adapter types outside the built-in definition allowlist", async () => {
    const companyId = await seedCompany();

    await expect(builtInAgentService(db).ensure(companyId, "specifier", {
      adapterType: "http",
      adapterConfig: { url: "https://example.test/webhook" },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "built_in_agent_adapter_not_allowed",
        key: "specifier",
        // ROSTER_ADAPTER_TYPES: every local coding adapter the fork ships, and
        // deliberately NOT `process` — a bare process adapter has no
        // `--allowedTools` grant to receive a roster agent's permission profile.
        allowedAdapterTypes: ["claude_local", "codex_local", "gemini_local", "opencode_local"],
      },
    });
  });

  it("recovers an orphaned marked row instead of creating a duplicate", async () => {
    const companyId = await seedCompany();
    const orphanId = randomUUID();
    await db.insert(agents).values({
      id: orphanId,
      companyId,
      name: "Old Specifier",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({ source: "orphan" }, { key: "specifier", featureKeys: ["lifecycle-feature-spec"] }),
    });

    const state = await builtInAgentService(db).ensure(companyId, "specifier");

    expect(state.status).toBe("ready");
    expect(state.agentId).toBe(orphanId);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("derives not_provisioned, needs_setup, ready, and paused states", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);

    await expect(builtIns.get(companyId, "implementer")).resolves.toMatchObject({ status: "not_provisioned" });

    const needsSetup = await builtIns.ensure(companyId, "implementer");
    expect(needsSetup.status).toBe("needs_setup");
    expect(deriveBuiltInAgentStatus(needsSetup.agent)).toBe("needs_setup");

    const ready = await builtIns.ensure(companyId, "implementer", {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4" },
    });
    expect(ready.status).toBe("ready");

    await agentService(db).pause(ready.agentId!, "manual");
    await expect(builtIns.get(companyId, "implementer")).resolves.toMatchObject({
      status: "paused",
      agentId: ready.agentId,
      pauseReason: "manual",
    });
  });

  it("requires configured built-ins with typed precondition failures and paused warnings", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);

    await expect(builtIns.requireBuiltInAgent(companyId, "specifier")).rejects.toMatchObject({
      status: 412,
      details: {
        code: "built_in_agent_not_configured",
        key: "specifier",
        status: "not_provisioned",
        agentId: null,
      },
    });

    const needsSetup = await builtIns.ensure(companyId, "specifier");
    await expect(builtIns.requireBuiltInAgent(companyId, "specifier")).rejects.toMatchObject({
      status: 412,
      details: {
        code: "built_in_agent_not_configured",
        key: "specifier",
        status: "needs_setup",
        agentId: needsSetup.agentId,
      },
    });

    const ready = await builtIns.ensure(companyId, "specifier", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    await expect(builtIns.requireBuiltInAgent(companyId, "specifier")).resolves.toMatchObject({
      agent: { id: ready.agentId },
      warning: null,
    });

    await agentService(db).pause(ready.agentId!, "maintenance");
    await expect(builtIns.requireBuiltInAgent(companyId, "specifier")).resolves.toMatchObject({
      agent: { id: ready.agentId },
      warning: {
        code: "built_in_agent_paused",
        key: "specifier",
        agentId: ready.agentId,
        pauseReason: "maintenance",
      },
    });
  });

  it("resets marked agents back to registry display defaults without replacing adapter setup", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);
    const ready = await builtIns.ensure(companyId, "specifier", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    await agentService(db).update(ready.agentId!, {
      name: "Custom Specifier",
      role: "engineer",
      title: "Custom",
      capabilities: "Custom purpose",
    });

    const reset = await builtIns.reset(companyId, "specifier");

    expect(reset).toMatchObject({
      status: "ready",
      agentId: ready.agentId,
      agent: {
        name: "Specifier",
        role: "product",
        title: "Specifier",
        capabilities:
          "Drafts the spec a feature gate approves — task breakdown with machine-checkable criteria per task. No repo write.",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
      },
    });
  });

  it("auto-provisions the Product Assistant bundle with a disabled routine", async () => {
    const companyId = await seedCompany({ requireApproval: false });
    const root = await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4", apiKey: "do-not-copy" },
      runtimeConfig: {},
      permissions: {},
    });

    const result = await reconcileBuiltInAgentsOnStartup(db);
    expect(result.autoEnsured).toBeGreaterThanOrEqual(1);
    // Exactly the root CEO's two change grants. BUILT_IN_AGENT_DEFAULT_GRANTS
    // is empty now that reflection-coach — the only definition that carried a
    // standing suggest-changes grant — is gone, so no built-in confers one.
    expect(result.defaultGrantsEnsured).toBe(2);

    const rootGrantKeys = await permissionKeysForAgent(root.id);
    expect(rootGrantKeys).toEqual(expect.arrayContaining(["agents:configure", "skills:create"]));
    expect(rootGrantKeys).not.toContain("agents:suggest-changes");
    expect(rootGrantKeys).not.toContain("skills:suggest-changes");

    const state = await builtInAgentService(db).get(companyId, "product-assistant");
    expect(state).toMatchObject({
      agent: {
        companyId,
        name: "Product Assistant",
        role: "product",
        title: "Product Assistant",
        icon: "search",
        adapterType: "codex_local",
        permissions: {
          canCreateAgents: false,
          canCreateSkills: false,
        },
      },
    });
    expect(state.agent?.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsEntryFile: "AGENTS.md",
    });
    expect(state.agent?.adapterConfig).not.toMatchObject({ model: "gpt-5.4", apiKey: "do-not-copy" });
    // Instructions and routine only — the Product Assistant bundle ships no
    // skill on purpose (one procedure, one routine, one file).
    expect(state.resources.map((resource) => [resource.resourceKind, resource.stockStatus])).toEqual([
      ["instructions", "stock_current"],
      ["routine", "stock_current"],
    ]);
    expect(state.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      resourceId: expect.any(String),
      scheduleEnabled: false,
    });

    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(agentRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "product-assistant")).toHaveLength(1);

    // Scoped by ORIGIN, not "the first routine in the company": every roster
    // agent auto-provisions into the same company.
    const [routine] = await db
      .select()
      .from(routines)
      .where(eq(routines.originId, "product-assistant:reconstruct-initiatives"));
    expect(routine).toMatchObject({
      title: "Reconstruct initiatives and projects from the repositories and the board",
      status: "paused",
      assigneeAgentId: state.agentId,
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
      cronExpression: "0 9 1 * *",
      timezone: "UTC",
    });
    // No roster agent holds a standing grant to propose changes to the
    // company's own agents or skills. That surface left with reflection-coach.
    const assistantGrantKeys = await permissionKeysForAgent(state.agentId!);
    expect(assistantGrantKeys).not.toContain("agents:suggest-changes");
    expect(assistantGrantKeys).not.toContain("skills:suggest-changes");
    expect(assistantGrantKeys).not.toContain("agents:configure");
    expect(assistantGrantKeys).not.toContain("skills:create");
  });

  it("recreates missing managed resource bindings idempotently during concurrent reconcile", async () => {
    const companyId = await seedCompany({ requireApproval: false });
    await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const builtIns = builtInAgentService(db);
    await builtIns.ensure(companyId, "product-assistant");
    await db.delete(builtInManagedResources).where(eq(builtInManagedResources.companyId, companyId));

    const states = await Promise.all([
      builtIns.ensure(companyId, "product-assistant"),
      builtIns.ensure(companyId, "product-assistant"),
    ]);

    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(state.resources.map((resource) => [resource.resourceKind, resource.stockStatus])).toEqual([
        ["instructions", "stock_current"],
        ["routine", "stock_current"],
      ]);
    }
    const bindings = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((binding) =>
      `${binding.bundleKey}:${binding.resourceKind}:${binding.resourceKey}`
    )).size).toBe(2);
  });

  it("preserves new-agent approval gates during automatic roster provisioning", async () => {
    const companyId = await seedCompany({ requireApproval: true });
    const root = await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const result = await reconcileBuiltInAgentsOnStartup(db);

    // Four auto-provisioned definitions — the whole roster, and nothing else.
    // Each lifecycle agent step names one by key and holds if it is missing, so
    // each must exist before the first ticket reaches it; each is gated behind
    // the SAME board approval, which is what this test is actually about. The
    // count moves with the roster (it was five while the inherited
    // reflection-coach was auto-provisioned alongside it).
    expect(result).toMatchObject({
      autoEnsured: 4,
      pendingApprovals: 4,
    });
    const state = await builtInAgentService(db).get(companyId, "product-assistant");
    expect(state).toMatchObject({
      status: "pending_approval",
      agent: {
        companyId,
        name: "Product Assistant",
        status: "pending_approval",
        // No roster entry declares `defaultManager`, so a roster agent is
        // provisioned unmanaged. The inherited reflection-coach set
        // `single_root_agent` and reported to the CEO; nothing in the roster
        // does, and this assertion records that rather than assuming it.
        reportsTo: null,
        budgetMonthlyCents: 0,
        permissions: {
          canCreateAgents: false,
          canCreateSkills: false,
        },
      },
    });
    expect(state.resources.map((resource) => resource.stockStatus)).toEqual(["missing", "missing"]);

    // Selected by key rather than by position: every auto-provisioned
    // definition raises its own hire approval, so "the first row" is whichever
    // one the database happened to return.
    const companyApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const approval = companyApprovals.find(
      (row) => (row.payload as { sourceBuiltInAgentKey?: string } | null)?.sourceBuiltInAgentKey === "product-assistant",
    );
    expect(approval).toMatchObject({
      type: "hire_agent",
      status: "pending",
      payload: {
        agentId: state.agentId,
        sourceBuiltInAgentKey: "product-assistant",
        featureKeys: ["product-assistant"],
        reportsTo: null,
        permissions: expect.objectContaining({
          canCreateAgents: false,
          canCreateSkills: false,
        }),
      },
    });

    const pendingReconcile = await reconcileBuiltInAgentsOnStartup(db);
    expect(pendingReconcile.pendingApprovals).toBe(4);
    const stillPending = await builtInAgentService(db).get(companyId, "product-assistant");
    expect(stillPending).toMatchObject({
      status: "pending_approval",
      agent: {
        adapterConfig: {},
        reportsTo: null,
        status: "pending_approval",
      },
    });
    expect(stillPending.resources.map((resource) => resource.stockStatus)).toEqual([
      "missing",
      "missing",
    ]);

    await approvalService(db).approve(approval.id, "board-user", "Approved Product Assistant");
    const approvedState = await builtInAgentService(db).get(companyId, "product-assistant");
    expect(approvedState).toMatchObject({
      agent: {
        reportsTo: null,
        permissions: {
          canCreateAgents: false,
          canCreateSkills: false,
        },
      },
    });
    expect(approvedState.resources.map((resource) => resource.stockStatus)).toEqual([
      "stock_current",
      "stock_current",
    ]);

    await reconcileBuiltInAgentsOnStartup(db);
    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(agentRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "product-assistant")).toHaveLength(1);
    // The property being asserted is NO DUPLICATE: a second startup reconcile
    // must not raise a second hire approval for a definition that already has
    // one. Counted per definition rather than in total, so it stays about that
    // and does not become an assertion about how many built-ins exist.
    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const perDefinition = new Map<string, number>();
    for (const row of approvalRows) {
      const key = (row.payload as { sourceBuiltInAgentKey?: string } | null)?.sourceBuiltInAgentKey ?? "";
      perDefinition.set(key, (perDefinition.get(key) ?? 0) + 1);
    }
    expect([...perDefinition.values()].filter((count) => count !== 1)).toEqual([]);
    expect(perDefinition.get("product-assistant")).toBe(1);
  });

  it("preserves built-in instruction drift on reconcile and restores it on reset", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);
    const created = await builtIns.ensure(companyId, "product-assistant");
    const instructions = agentInstructionsService();

    await instructions.writeFile(created.agent!, "AGENTS.md", "# Custom Product Assistant\n\nOperator edit.\n");

    const reconciled = await builtIns.ensure(companyId, "product-assistant");
    const drift = reconciled.resources.find((resource) => resource.resourceKind === "instructions");
    expect(drift).toMatchObject({
      stockStatus: "operator_modified",
      updateAvailable: true,
      resetAvailable: true,
      changedFiles: ["AGENTS.md"],
    });
    await expect(instructions.readFile(reconciled.agent!, "AGENTS.md")).resolves.toMatchObject({
      content: "# Custom Product Assistant\n\nOperator edit.\n",
    });

    const reset = await builtIns.reset(companyId, "product-assistant");
    expect(reset.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "stock_current",
      resetAvailable: false,
    });
    const resetFile = await instructions.readFile(reset.agent!, "AGENTS.md");
    expect(resetFile.content).toContain("You are the Product Assistant.");
    expect(resetFile.content).not.toContain("Operator edit.");
  });

  it("blocks deleting a built-in agent", async () => {
    const companyId = await seedCompany();
    const state = await builtInAgentService(db).ensure(companyId, "specifier");

    await expect(agentService(db).remove(state.agentId!)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_undeletable",
        key: "specifier",
      },
    });
  });

  it("prevents direct marker add, remove, or mutation", async () => {
    const companyId = await seedCompany();
    const builtIn = await builtInAgentService(db).ensure(companyId, "specifier");
    const normal = await agentService(db).create(companyId, {
      name: "Normal",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).create(companyId, {
      name: "Spoof",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({}, { key: "specifier", featureKeys: ["lifecycle-feature-spec"] }),
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(normal.id, {
      metadata: withBuiltInAgentMarker({}, { key: "specifier", featureKeys: ["lifecycle-feature-spec"] }),
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(builtIn.agentId!, {
      metadata: { other: "metadata" },
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(builtIn.agentId!, {
      metadata: withBuiltInAgentMarker({}, { key: "implementer", featureKeys: ["lifecycle-bug-fix", "lifecycle-feature-implement"] }),
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(builtIn.agentId!, {
      metadata: withBuiltInAgentMarker({ note: "allowed" }, { key: "specifier", featureKeys: ["lifecycle-feature-spec"] }),
    })).resolves.toMatchObject({
      id: builtIn.agentId,
      metadata: {
        note: "allowed",
        paperclipBuiltInAgent: { key: "specifier", featureKeys: ["lifecycle-feature-spec"] },
      },
    });
  });

  it("repairs display/default drift for marked rows during startup reconciliation", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Old Name",
      role: "engineer",
      title: "Old title",
      capabilities: "Old purpose",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({}, { key: "specifier", featureKeys: ["stale-feature-key"] }),
    });

    const result = await reconcileBuiltInAgentsOnStartup(db);
    expect(result).toMatchObject({ unknown: 0, duplicates: 0 });
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.reconciled).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toMatchObject({
      name: "Specifier",
      role: "product",
      title: "Specifier",
      capabilities:
        "Drafts the spec a feature gate approves — task breakdown with machine-checkable criteria per task. No repo write.",
    });
    expect(readBuiltInAgentMarker(row?.metadata)).toEqual({ key: "specifier", featureKeys: ["lifecycle-feature-spec"] });
  });

  it("repoints a stale-install instructionsFilePath during startup reconciliation while preserving other adapterConfig keys", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const definition = listBuiltInAgentDefinitions().find((entry) => entry.key === "implementer");
    expect(definition?.defaultAdapterConfig?.instructionsFilePath).toBeTruthy();
    const definitionInstructionsFilePath = definition!.defaultAdapterConfig!.instructionsFilePath as string;

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineering",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        dangerouslySkipPermissions: false,
        allowedTools: "Read",
        instructionsFilePath:
          "/Users/someone/.paperclip/checkouts/cockpit/server/src/built-ins/agents/implementer/AGENTS.md",
        model: "keep-me",
      },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({}, { key: "implementer", featureKeys: ["stale-feature-key"] }),
    });

    await reconcileBuiltInAgentsOnStartup(db);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    const adapterConfig = row?.adapterConfig as Record<string, unknown>;
    expect(adapterConfig.instructionsFilePath).toBe(definitionInstructionsFilePath);
    expect(adapterConfig.model).toBe("keep-me");
    expect(adapterConfig.dangerouslySkipPermissions).toBe(false);
    expect(adapterConfig.allowedTools).toBe("Read");
  });

  it("leaves an existing custom instructionsFilePath untouched during startup reconciliation", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-custom-instructions-"));
    const customInstructionsFilePath = path.join(customDir, "CUSTOM.md");
    fs.writeFileSync(customInstructionsFilePath, "Custom operator instructions.\n", "utf8");

    try {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Implementer",
        role: "engineering",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {
          dangerouslySkipPermissions: false,
          allowedTools: "Read",
          instructionsFilePath: customInstructionsFilePath,
          model: "keep-me",
        },
        runtimeConfig: {},
        permissions: {},
        metadata: withBuiltInAgentMarker({}, { key: "implementer", featureKeys: ["stale-feature-key"] }),
      });

      await reconcileBuiltInAgentsOnStartup(db);

      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      const adapterConfig = row?.adapterConfig as Record<string, unknown>;
      expect(adapterConfig.instructionsFilePath).toBe(customInstructionsFilePath);
      expect(adapterConfig.model).toBe("keep-me");
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  /**
   * THE ORPHAN. Deleting a definition does not delete the rows it already
   * provisioned, and on the live board one of them — a paused reflection-coach
   * — outlived its definition. Startup reconciliation must classify it and move
   * on: not throw, not delete it, not re-provision it, and not drown the log by
   * re-reporting it per row. It stays a plain agent record the operator can
   * pause, rename or leave alone.
   */
  it("classifies a marked row whose definition no longer exists instead of failing startup", async () => {
    const companyId = await seedCompany();
    const orphanId = randomUUID();
    await db.insert(agents).values({
      id: orphanId,
      companyId,
      name: "Reflection Coach",
      role: "general",
      status: "paused",
      pausedAt: new Date(),
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({}, { key: "reflection-coach", featureKeys: ["reflection-coach"] }),
    });

    const result = await reconcileBuiltInAgentsOnStartup(db);
    expect(result.unknown).toBe(1);

    // Untouched: still there, still paused, still carrying its marker.
    const [row] = await db.select().from(agents).where(eq(agents.id, orphanId));
    expect(row).toMatchObject({ name: "Reflection Coach", status: "paused" });
    expect(readBuiltInAgentMarker(row?.metadata)?.key).toBe("reflection-coach");

    // Invisible to the built-in surface, which enumerates DEFINITIONS.
    const listed = await builtInAgentService(db).list(companyId);
    expect(listed.map((state) => state.definition.key)).not.toContain("reflection-coach");
    expect(listed.every((state) => state.agentId !== orphanId)).toBe(true);

    // Addressing it by key is a 404, not a crash.
    await expect(builtInAgentService(db).get(companyId, "reflection-coach")).rejects.toMatchObject({
      status: 404,
    });

    // Repeated startups keep classifying it the same way.
    const second = await reconcileBuiltInAgentsOnStartup(db);
    expect(second.unknown).toBe(1);
  });

  it("reports duplicate active instances for a company/key", async () => {
    const companyId = await seedCompany();
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Specifier One",
        role: "general",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
        metadata: withBuiltInAgentMarker({}, { key: "specifier", featureKeys: ["lifecycle-feature-spec"] }),
      },
      {
        id: randomUUID(),
        companyId,
        name: "Specifier Two",
        role: "general",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
        metadata: withBuiltInAgentMarker({}, { key: "specifier", featureKeys: ["lifecycle-feature-spec"] }),
      },
    ]);

    await expect(builtInAgentService(db).ensure(companyId, "specifier")).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_duplicate_instance",
        key: "specifier",
      },
    } satisfies Partial<HttpError>);
  });

  it("automatically materializes the Product Assistant bundle without enabling background work", async () => {
    const companyId = await seedCompany();
    const root = await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });

    const state = await builtInAgentService(db).ensure(companyId, "product-assistant");

    expect(state.agent).toMatchObject({
      companyId,
      name: "Product Assistant",
      title: "Product Assistant",
      icon: "search",
      // Unmanaged: no roster entry declares `defaultManager`.
      reportsTo: null,
      adapterType: "codex_local",
      budgetMonthlyCents: 0,
    });
    expect(readBuiltInAgentMarker(state.agent?.metadata)).toEqual({
      key: "product-assistant",
      featureKeys: ["product-assistant"],
    });
    expect(state.resources.map((resource) => [resource.resourceKind, resource.stockStatus])).toEqual([
      ["instructions", "stock_current"],
      ["routine", "stock_current"],
    ]);
    const reported = await builtInAgentService(db).get(companyId, "product-assistant");
    const reportedRoutine = reported.resources.find((resource) => resource.resourceKind === "routine");
    expect(reportedRoutine).toMatchObject({
      stockStatus: "stock_current",
      updateAvailable: false,
      resetAvailable: false,
    });
    expect(reportedRoutine?.currentHash).toBe(reportedRoutine?.stockHash);

    // The bundle ships no skill, so materializing it must not create a company
    // skill or a skill-sync preference out of nowhere.
    const skillRows = await db.select().from(companySkills).where(eq(companySkills.companyId, companyId));
    expect(skillRows).toHaveLength(0);
    expect(readPaperclipSkillSyncPreference(state.agent!.adapterConfig).desiredSkills).toEqual([]);

    const [routine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(routine).toMatchObject({
      title: "Reconstruct initiatives and projects from the repositories and the board",
      status: "paused",
      assigneeAgentId: state.agentId,
      originKind: "built_in_agent_bundle",
      originId: "product-assistant:reconstruct-initiatives",
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
      cronExpression: "0 9 1 * *",
      timezone: "UTC",
    });

    const grantKeys = await permissionKeysForAgent(state.agentId!);
    expect(grantKeys).not.toContain("tasks:assign");
    expect(grantKeys).not.toContain("agents:configure");
    expect(grantKeys).not.toContain("skills:create");
    expect(grantKeys).not.toContain("agents:suggest-changes");
    expect(grantKeys).not.toContain("skills:suggest-changes");
  });

  it("controls a bundled routine schedule without enabling it by default", async () => {
    const companyId = await seedCompany();
    await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const builtIns = builtInAgentService(db);
    const created = await builtIns.ensure(companyId, "product-assistant");
    expect(created.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      scheduleEnabled: false,
    });

    const enabled = await builtIns.enableRoutineSchedule(
      companyId,
      "product-assistant",
      "reconstruct-initiatives",
      { userId: "board-user" },
    );
    expect(enabled.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      scheduleEnabled: true,
    });
    const [enabledRoutine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    const [enabledTrigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, enabledRoutine!.id));
    expect(enabledRoutine).toMatchObject({ status: "active" });
    expect(enabledTrigger).toMatchObject({ enabled: true });

    const disabled = await builtIns.disableRoutineSchedule(
      companyId,
      "product-assistant",
      "reconstruct-initiatives",
      { userId: "board-user" },
    );
    expect(disabled.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      scheduleEnabled: false,
    });
    const [disabledRoutine] = await db.select().from(routines).where(eq(routines.id, enabledRoutine!.id));
    const [disabledTrigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, enabledTrigger!.id));
    expect(disabledRoutine).toMatchObject({ status: "paused" });
    expect(disabledTrigger).toMatchObject({ enabled: false });
  });

  it("surfaces pending proposal interactions on a built-in's routine resource", async () => {
    const companyId = await seedCompany();
    await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const created = await builtInAgentService(db).ensure(companyId, "product-assistant");
    const proposalIssueId = randomUUID();
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review Product Assistant proposal",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-42`,
      issueNumber: 42,
      assigneeAgentId: created.agentId,
      createdByAgentId: created.agentId,
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "Review proposed reconstruction",
      summary: "Accept or reject the proposed update.",
      createdByAgentId: created.agentId,
      payload: {
        version: 1,
        prompt: "Accept the proposed reconstruction?",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
      },
    });

    const state = await builtInAgentService(db).get(companyId, "product-assistant");

    expect(state.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      pendingUpdateInteractionId: interactionId,
      pendingUpdateIssueId: proposalIssueId,
      pendingUpdateIssueIdentifier: `${issuePrefix(companyId)}-42`,
    });
  });

  it("gates built-in proposal mutations until an accepted follow-up apply step", async () => {
    const companyId = await seedCompany();
    const agentsSvc = agentService(db);
    await agentsSvc.create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const target = await agentsSvc.create(companyId, {
      name: "Target Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const created = await builtInAgentService(db).ensure(companyId, "product-assistant");
    const proposer = created.agent!;
    const instructionsSvc = agentInstructionsService();
    const originalInstructions = "# Target Coder\n\nWork from the assigned issue.\n";
    const prepared = await instructionsSvc.writeFile(target, "AGENTS.md", originalInstructions);
    let persistedTarget = (await agentsSvc.update(target.id, { adapterConfig: prepared.adapterConfig }))!;

    const interactionsSvc = issueThreadInteractionService(db);
    const applyAcceptedProposalFollowUp = async (input: {
      interactionId: string;
      nextInstructions: string;
    }) => {
      const interaction = await interactionsSvc.getById(input.interactionId);
      if (interaction?.kind !== "request_confirmation" || interaction.status !== "accepted") {
        return false;
      }
      const written = await instructionsSvc.writeFile(persistedTarget, "AGENTS.md", input.nextInstructions);
      persistedTarget = (await agentsSvc.update(persistedTarget.id, { adapterConfig: written.adapterConfig }))!;
      return true;
    };
    const readTargetInstructions = async () =>
      (await instructionsSvc.readFile(persistedTarget, "AGENTS.md")).content;

    const proposalIssueId = randomUUID();
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review a built-in agent proposal",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-43`,
      issueNumber: 43,
      assigneeUserId: "board-user",
      createdByAgentId: proposer.id,
    });
    const acceptedInstructions = `${originalInstructions}\nWhen finishing, name the exact verification command.\n`;
    const acceptedProposal = await interactionsSvc.create({
      id: proposalIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      title: "Review proposed instruction change",
      summary: "Accept or reject the proposed instruction diff.",
      payload: {
        version: 1,
        prompt: "Apply this proposed instruction diff in a follow-up run?",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
        detailsMarkdown: [
          "```diff",
          " # Target Coder",
          "",
          " Work from the assigned issue.",
          "+When finishing, name the exact verification command.",
          "```",
        ].join("\n"),
        target: {
          type: "custom",
          key: `agent:${target.id}:instructions`,
          revisionId: "proposal-v1",
          label: "Target Coder AGENTS.md diff",
        },
      },
    }, {
      agentId: proposer.id,
    });

    const accepted = await interactionsSvc.acceptInteraction(
      { id: proposalIssueId, companyId, goalId: null, projectId: null },
      acceptedProposal.id,
      {},
      { userId: "board-user" },
    );

    expect(accepted.interaction).toMatchObject({
      id: acceptedProposal.id,
      kind: "request_confirmation",
      status: "accepted",
    });
    expect(accepted.continuationIssue).toMatchObject({
      id: proposalIssueId,
      assigneeAgentId: proposer.id,
      assigneeUserId: null,
      status: "todo",
    });
    expect(await readTargetInstructions()).toBe(originalInstructions);

    await expect(applyAcceptedProposalFollowUp({
      interactionId: acceptedProposal.id,
      nextInstructions: acceptedInstructions,
    })).resolves.toBe(true);
    expect(await readTargetInstructions()).toBe(acceptedInstructions);

    const rejectedProposal = await interactionsSvc.create({
      id: proposalIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: "product-assistant:proposal-v2",
      title: "Review rejected instruction change",
      summary: "Rejecting this diff must not mutate the target instructions.",
      payload: {
        version: 1,
        prompt: "Apply this rejected instruction diff?",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
        detailsMarkdown: [
          "```diff",
          "+This rejected line must not be applied.",
          "```",
        ].join("\n"),
        target: {
          type: "custom",
          key: `agent:${target.id}:instructions`,
          revisionId: "proposal-v2",
          label: "Target Coder AGENTS.md rejected diff",
        },
      },
    }, {
      agentId: proposer.id,
    });

    const rejected = await interactionsSvc.rejectInteraction(
      { id: proposalIssueId, companyId },
      rejectedProposal.id,
      { reason: "Not the right rule." },
      { userId: "board-user" },
    );

    expect(rejected).toMatchObject({
      id: rejectedProposal.id,
      kind: "request_confirmation",
      status: "rejected",
      result: expect.objectContaining({
        outcome: "rejected",
        reason: "Not the right rule.",
      }),
    });
    await expect(applyAcceptedProposalFollowUp({
      interactionId: rejectedProposal.id,
      nextInstructions: `${acceptedInstructions}\nThis rejected line must not be applied.\n`,
    })).resolves.toBe(false);
    expect(await readTargetInstructions()).toBe(acceptedInstructions);
  });

  /**
   * Drift is preserved until an operator asks for stock back, and a reset names
   * the resources it touches — the one NOT named stays drifted.
   *
   * COVERAGE NOTE: this used to exercise a third resource kind, `skill`, on the
   * inherited reflection-coach bundle. No roster agent ships a bundled skill
   * (the Product Assistant deliberately does not — see apex-agent-roster.ts),
   * so the skill branch of bundle materialization, drift detection and reset is
   * now unexercised. The assertions were not weakened to hide that: nothing in
   * the roster produces a bundled skill to assert against, and inventing one to
   * keep a test green would be a fixture pretending to be a product decision.
   */
  it("preserves built-in stock drift until explicit reset", async () => {
    const companyId = await seedCompany();
    const created = await builtInAgentService(db).ensure(companyId, "product-assistant");
    const agent = created.agent!;

    const instructionsSvc = agentInstructionsService();
    await instructionsSvc.writeFile(agent, "AGENTS.md", "# Custom Product Assistant\n\nDo not overwrite me.\n");
    await db
      .update(routines)
      .set({ title: "DRIFTED BY TEST - do not clobber" })
      .where(eq(routines.companyId, companyId));

    const drifted = await builtInAgentService(db).ensure(companyId, "product-assistant");
    expect(drifted.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    expect(drifted.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    expect((await instructionsSvc.readFile(drifted.agent!, "AGENTS.md")).content).toContain("Do not overwrite me.");
    const [preservedRoutine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(preservedRoutine?.title).toBe("DRIFTED BY TEST - do not clobber");

    // Reset the routine only: the instructions must stay drifted, which is the
    // property the old skill-vs-instructions pairing was demonstrating.
    const partialReset = await builtInAgentService(db).reset(companyId, "product-assistant", {
      resources: ["routine"],
    });
    expect(partialReset.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      resetAvailable: false,
    });
    expect(partialReset.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    const [resetRoutine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(resetRoutine?.title).toBe("Reconstruct initiatives and projects from the repositories and the board");

    const reset = await builtInAgentService(db).reset(companyId, "product-assistant", {
      resources: ["instructions"],
    });
    expect(reset.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "stock_current",
      resetAvailable: false,
    });
    expect((await instructionsSvc.readFile(reset.agent!, "AGENTS.md")).content).toContain("You are the Product Assistant.");
  });
});
