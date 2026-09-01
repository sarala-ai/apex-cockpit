/**
 * The gate brief, read back out of a real database.
 *
 * The assembler is tested purely (pipeline-gate-brief.test.ts). This one
 * exists because the claim that made the whole change cheap — *every record
 * the brief needs is already stored, nothing read it back* — is a claim about
 * the DATABASE, and the only way to know it is true is to write the records
 * the way the product writes them and then read them.
 *
 * So the Feature lifecycle is seeded exactly as the product seeds it, a piece
 * of work is walked through Promote → Spec → the spec decision, and the brief
 * is read at each point.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  documents,
  documentRevisions,
  issueComments,
  issueDocuments,
  issues,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  loadGateBriefFacts,
  openGateApprovalIdsForCases,
} from "../apex/pipeline/gate-brief-facts.js";
import { assembleGateBrief } from "../apex/steps/gate-brief.js";
import { seedLifecyclePipelines } from "../apex/pipeline/lifecycles.js";
import { pipelineService } from "../services/pipelines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres gate-brief tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("the gate brief, read from the records the product writes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gate-brief-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(pipelines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A company running the real Feature lifecycle, with a ticket on it. */
  async function seedFeatureWork(input: { description?: string | null } = {}) {
    const [company] = await db.insert(companies).values({
      name: "Gate Brief Co",
      issuePrefix: `G${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;

    await seedLifecyclePipelines(db, { companyId });
    const pipeline = await db
      .select()
      .from(pipelines)
      .where(eq(pipelines.key, "feature"))
      .then((rows) => rows[0]!);

    const [project] = await db.insert(projects).values({
      companyId,
      name: "Cockpit",
      status: "in_progress",
    }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({
      companyId,
      projectId: project!.id,
      name: "Cockpit workspace",
      isPrimary: true,
      repoUrl: "https://github.com/sarala-ai/cockpit.git",
      sharedWorkspaceKey: `cockpit-${randomUUID().slice(0, 8)}`,
    }).returning();

    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Specifier",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();

    const [issue] = await db.insert(issues).values({
      companyId,
      projectId: project!.id,
      projectWorkspaceId: workspace!.id,
      title: "Gate briefs hand over the artifact, not a label",
      identifier: "APEX-14",
      ticketType: "feature",
      description:
        input.description === undefined
          ? "A gate shows the prompt it was seeded with and nothing about the ticket.\n\n" +
            "## Acceptance Criteria\n- The brief names what the last step produced\n- Absence is stated, never blank"
          : input.description,
      status: "todo",
      priority: "medium",
    }).returning();

    const svc = pipelineService(db);
    // Ingested with its conversation attached, exactly the way the product
    // does it — the link has to exist before the first stage's entry step
    // runs, or an agent step has nothing to commission against.
    const created = await svc.ingestCase({
      companyId,
      pipelineId: pipeline.id,
      title: issue!.title,
      linkIssue: { issueId: issue!.id, role: "conversation" },
      actor: { type: "system" },
    });

    return { companyId, pipeline, caseId: created.case.id, issueId: issue!.id, agentId: agent!.id, svc };
  }

  /**
   * Walk the work forward the way the board walks it, so the gate approval
   * and its `gate_opened` record are written by the PRODUCT rather than by
   * this test. That is the point of the file: the brief must read records
   * somebody else wrote.
   *
   */
  async function moveTo(
    svc: ReturnType<typeof pipelineService>,
    input: { companyId: string; caseId: string; toStageKey: string },
  ) {
    const current = await db.select().from(pipelineCases).where(eq(pipelineCases.id, input.caseId))
      .then((rows) => rows[0]!);
    await svc.transitionCase({
      companyId: input.companyId,
      caseId: input.caseId,
      toStageKey: input.toStageKey,
      expectedVersion: current.version,
      force: true,
      reason: "walked forward by the test",
      actor: { type: "user", userId: "founder" },
    });
  }

  async function stageId(pipelineId: string, key: string) {
    const rows = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId));
    return rows.find((row) => row.key === key)!.id;
  }

  it("finds the decision a review step opened, by the work it belongs to", async () => {
    const { companyId, caseId, pipeline, svc } = await seedFeatureWork();
    await moveTo(svc, { companyId, caseId, toStageKey: "spec" });
    await moveTo(svc, { companyId, caseId, toStageKey: "spec_design_gate" });

    const found = await openGateApprovalIdsForCases(db, companyId, [caseId]);
    expect(found.get(caseId)).toBeTruthy();

    const row = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, found.get(caseId)!))
      .then((rows) => rows[0]!);
    expect(row.type).toBe("flow_gate");
    expect((row.payload as { stepKey?: string }).stepKey).toBe("spec_design_gate");
    expect((row.payload as { caseId?: string }).caseId).toBe(caseId);
    expect(pipeline.key).toBe("feature");
  });

  it("reports how long the decision has been waiting, from when it was opened", async () => {
    const { companyId, caseId, svc } = await seedFeatureWork();
    await moveTo(svc, { companyId, caseId, toStageKey: "spec" });
    await moveTo(svc, { companyId, caseId, toStageKey: "spec_design_gate" });
    const approvalId = (await openGateApprovalIdsForCases(db, companyId, [caseId])).get(caseId)!;

    const brief = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId, companyId, caseId, stepKey: "spec_design_gate",
    }))!);
    if (brief.available === false) throw new Error(brief.reason);

    expect(brief.deciding.waitingFor).toBe("This has just started waiting for you.");
  });

  it("opens the Promote decision on the ticket that lands on it", async () => {
    // The Feature lifecycle's FIRST step is a decision, so a ticket ingested
    // onto it is already waiting on a person. Before this change the gate
    // opened only on a transition, so this — the first gate a real ticket
    // ever hits — had no approval row and therefore no brief.
    const { companyId, caseId } = await seedFeatureWork();

    const approvalId = (await openGateApprovalIdsForCases(db, companyId, [caseId])).get(caseId);
    expect(approvalId).toBeTruthy();
    const row = await db.select().from(approvals).where(eq(approvals.id, approvalId!))
      .then((rows) => rows[0]!);
    expect((row.payload as { stepKey?: string }).stepKey).toBe("promote");

    const brief = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: approvalId!, companyId, caseId, stepKey: "promote",
    }))!);
    if (brief.available === false) throw new Error(brief.reason);
    expect(brief.deciding.waitingFor).toBe("This has just started waiting for you.");
  });

  it("assembles the Promote brief with the ticket as the artifact", async () => {
    const { companyId, caseId } = await seedFeatureWork();

    const factsRow = await loadGateBriefFacts(db, {
      approvalId: "approval-x",
      companyId,
      caseId,
      stepKey: "promote",
    });
    expect(factsRow).not.toBeNull();
    const brief = assembleGateBrief(factsRow!);
    if (brief.available === false) throw new Error(brief.reason);

    expect(brief.deciding.headline).toBe(
      "Nothing has been built yet — this is the first decision on this work. You are deciding whether it goes on to Spec.",
    );
    expect(brief.deciding.question).toBe("Gate 1: Promote — is it worth doing. Seconds.");
    expect(brief.deciding.ticketIdentifier).toBe("APEX-14");
    // Nothing precedes Promote, so "send it back" genuinely is not on offer.
    expect(brief.deciding.outcomes.map((outcome) => outcome.decision)).toEqual(["approve", "reject"]);

    expect(brief.lookAt.items[0]!.label).toBe("What was asked for");
    expect(brief.lookAt.items[0]!.excerpt).toContain("A gate shows the prompt it was seeded with");
    // The codebase is read through the ticket's workspace, and rendered as the
    // repository a person would recognise — not the clone URL.
    expect(brief.lookAt.items[0]!.meta).toBe("Asked for as a feature · lands in sarala-ai/cockpit");
    expect(brief.lookAt.items[1]!.excerpt).toContain("The brief names what the last step produced");

    expect(brief.checked.ok).toBeNull();
    expect(brief.history).toEqual([]);
  });

  it("says the ticket has no description rather than showing a blank", async () => {
    const { companyId, caseId } = await seedFeatureWork({ description: null });

    const brief = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: "approval-x",
      companyId,
      caseId,
      stepKey: "promote",
    }))!);
    if (brief.available === false) throw new Error(brief.reason);

    expect(brief.lookAt.nothingThere).toBe(
      "The ticket has no description, so all you have to go on is its title.",
    );
  });

  it("hands over the document the Spec step wrote, and names who wrote it", async () => {
    const { companyId, pipeline, caseId, issueId, agentId } = await seedFeatureWork();
    const specStageId = await stageId(pipeline.id, "spec");

    // The records the product writes when an agent step runs: who was
    // commissioned, that the step finished, and the document it produced.
    await db.insert(pipelineCaseEvents).values([
      {
        companyId,
        caseId,
        type: "step_waiting",
        actorType: "system",
        payload: { stageId: specStageId, stageKey: "spec", agentId },
      },
      {
        companyId,
        caseId,
        type: "step_resumed",
        actorType: "system",
        payload: { stageId: specStageId, stageKey: "spec", runStatus: "succeeded" },
      },
    ]);
    const [document] = await db.insert(documents).values({
      companyId,
      title: "Spec",
      format: "markdown",
      latestBody: "# Spec\n\n## Task 1 — assemble the brief\nAcceptance: file_exists:x",
    }).returning();
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId: document!.id,
      key: "spec",
    });

    // The case is walked to the spec decision the way the board walks it.
    await db.update(pipelineCases)
      .set({ stageId: await stageId(pipeline.id, "spec_design_gate") })
      .where(eq(pipelineCases.id, caseId));

    const brief = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: "approval-x",
      companyId,
      caseId,
      stepKey: "spec_design_gate",
    }))!);
    if (brief.available === false) throw new Error(brief.reason);

    expect(brief.deciding.headline).toContain("Specifier finished Spec");
    expect(brief.deciding.headline).toContain("whether it goes on to Tasks");
    expect(brief.lookAt.headline).toBe("Spec produced this.");
    const item = brief.lookAt.items[0]!;
    expect(item.label).toBe("Spec");
    expect(item.excerpt).toContain("## Task 1 — assemble the brief");
    expect(item.anchor).toBe("spec");
    expect(item.meta).toContain("Written by Specifier");
    // This gate DOES have an earlier agent step, so it can send work back.
    expect(brief.deciding.outcomes.map((outcome) => outcome.decision)).toContain("request_changes");
    // And it asks the five review passes the seeded lifecycle declares.
    expect(brief.reviewPasses.map((pass) => pass.id)).toEqual([
      "customer_hat",
      "cognitive_load",
      "design",
      "system_compatibility",
      "reversibility",
    ]);
  });

  it("says the step left nothing when it left nothing", async () => {
    const { companyId, pipeline, caseId } = await seedFeatureWork();
    await db.update(pipelineCases)
      .set({ stageId: await stageId(pipeline.id, "spec_design_gate") })
      .where(eq(pipelineCases.id, caseId));

    const brief = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: "approval-x",
      companyId,
      caseId,
      stepKey: "spec_design_gate",
    }))!);
    if (brief.available === false) throw new Error(brief.reason);

    expect(brief.lookAt.headline).toBe("Spec finished and left nothing to read.");
    expect(brief.lookAt.nothingThere).toContain("approving a claim rather than work you have seen");
  });

  it("reads back the verdict the server recorded, and whether it still covers the work", async () => {
    const { companyId, pipeline, caseId } = await seedFeatureWork();
    const specStageId = await stageId(pipeline.id, "spec");
    const current = await db.select().from(pipelineCases).where(eq(pipelineCases.id, caseId))
      .then((rows) => rows[0]!);

    await db.insert(pipelineCaseEvents).values({
      companyId,
      caseId,
      type: "acceptance_evaluated",
      actorType: "system",
      payload: {
        stageId: specStageId,
        stageKey: "spec",
        criteria: "file_exists:specs/gate-brief.md",
        ok: true,
        evaluation: "v1: run success + file_exists verified",
        message: null,
        evaluatedCaseVersion: current.version,
      },
    });
    await db.update(pipelineCases)
      .set({ stageId: await stageId(pipeline.id, "spec_design_gate") })
      .where(eq(pipelineCases.id, caseId));

    const passing = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: "approval-x", companyId, caseId, stepKey: "spec_design_gate",
    }))!);
    if (passing.available === false) throw new Error(passing.reason);
    expect(passing.checked.ok).toBe(true);
    expect(passing.checked.machine).toContain("file_exists:specs/gate-brief.md");

    // Now the work moves on underneath the verdict. It must stop counting.
    await db.update(pipelineCases)
      .set({ version: current.version + 1 })
      .where(eq(pipelineCases.id, caseId));
    const stale = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: "approval-x", companyId, caseId, stepKey: "spec_design_gate",
    }))!);
    if (stale.available === false) throw new Error(stale.reason);
    expect(stale.checked.ok).toBeNull();
    expect(stale.checked.headline).toBe("The automatic check does not cover what you are looking at.");
  });

  it("carries the rounds already spent at THIS decision, and what was asked for", async () => {
    const { companyId, pipeline, caseId } = await seedFeatureWork();
    const gateStageId = await stageId(pipeline.id, "spec_design_gate");
    const specStageId = await stageId(pipeline.id, "spec");
    const promoteStageId = await stageId(pipeline.id, "promote");

    await db.insert(pipelineCaseEvents).values([
      {
        companyId,
        caseId,
        type: "review_decided",
        actorType: "user",
        actorUserId: "founder",
        fromStageId: gateStageId,
        toStageId: specStageId,
        payload: { decision: "request_changes", reason: "Split task 3 — it is two PRs." },
      },
      {
        companyId,
        caseId,
        type: "review_decided",
        actorType: "user",
        actorUserId: "founder",
        fromStageId: promoteStageId,
        toStageId: specStageId,
        payload: { decision: "approve", reason: null },
      },
    ]);
    await db.update(pipelineCases)
      .set({ stageId: gateStageId })
      .where(eq(pipelineCases.id, caseId));

    const brief = assembleGateBrief((await loadGateBriefFacts(db, {
      approvalId: "approval-x", companyId, caseId, stepKey: "spec_design_gate",
    }))!);
    if (brief.available === false) throw new Error(brief.reason);

    expect(brief.history[0]).toContain("You have sent this back once already");
    expect(brief.history[1]).toBe("Last time you asked for: “Split task 3 — it is two PRs.”");
    // A decision taken at a DIFFERENT step is context, not a round here.
    expect(brief.history.some((line) => line.startsWith("You approved Promote"))).toBe(true);
  });

  it("finds no work rather than throwing when the case is gone", async () => {
    const { companyId } = await seedFeatureWork();
    expect(
      await loadGateBriefFacts(db, {
        approvalId: "approval-x",
        companyId,
        caseId: randomUUID(),
        stepKey: "promote",
      }),
    ).toBeNull();
  });
});
