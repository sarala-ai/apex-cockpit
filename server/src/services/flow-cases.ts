/**
 * The case a flow-driven issue runs on.
 *
 * Step 1 of the execution-substrate merge
 * (docs/architecture/execution-substrate.md §6.1): flows stop keeping their
 * runtime state in columns on the issue and start keeping it where pipelines
 * already keep theirs — a case row, with a version, a terminal and a link to
 * the issue. The issue's `flow*` columns survive as a denormalised mirror and
 * nothing more (see packages/db/src/schema/issues.ts for the removal note).
 *
 * What this module is FOR is the version. A flow transition used to be
 * guarded by a compare-and-set on `(flow_status, flow_node_id)`, which sounds
 * equivalent and is not: that pair is not monotonic. A flow that walks away
 * from a node and comes back — a gate requesting changes, a completed flow
 * restarted — returns the pair to a value it already held, so a writer holding
 * a snapshot from BEFORE the round trip still matches and still wins. That is
 * the classic ABA problem, and it is the shape of the APE-5 defect: two
 * writers, a stale read, and a silent success where there should have been a
 * conflict. A monotonically increasing version has no ABA.
 *
 * Leases, parent rollup and blockers are deliberately NOT used by flows yet.
 * The point of this step is that they become available, not that they are
 * adopted.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pipelineCaseIssueLinks, pipelineCases } from "@paperclipai/db";
import { conflict } from "../errors.js";

type FlowCaseDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The link role a flow case takes on its issue. `work` is the existing
 *  vocabulary for "this issue is where the work happens" — the same role a
 *  pipeline stage automation's execution issue uses. No new role is invented. */
export const FLOW_CASE_LINK_ROLE = "work";

/** The slice of the case row the coordinator carries in its snapshot. */
export type FlowCaseState = {
  id: string;
  version: number;
  stepKey: string;
  terminalKind: string | null;
};

/** Flow statuses are six; a case terminal is two. `paused` is deliberately
 *  absent — a paused flow is waiting for a human, not finished. */
export function flowTerminalKind(flowStatus: string | null | undefined): string | null {
  if (flowStatus === "done") return "done";
  if (flowStatus === "failed") return "cancelled";
  return null;
}

function toState(row: {
  id: string;
  version: number;
  stepKey: string | null;
  terminalKind: string | null;
}): FlowCaseState {
  return {
    id: row.id,
    version: row.version,
    // The shape check in 0164 makes step_key NOT NULL for flow-defined cases,
    // so this coalesce can only fire on a row that violated it.
    stepKey: row.stepKey ?? "",
    terminalKind: row.terminalKind,
  };
}

const FLOW_CASE_COLUMNS = {
  id: pipelineCases.id,
  version: pipelineCases.version,
  stepKey: pipelineCases.stepKey,
  terminalKind: pipelineCases.terminalKind,
};

/** The flow case linked to an issue, or null for an issue whose flow predates
 *  the merge (or that has no flow at all). Callers must tolerate null: the
 *  backfill in 0165 covers today's rows, but a coordinator that hard-failed on
 *  a missing case would turn a data gap into an outage. */
export async function loadFlowCaseForIssue(db: FlowCaseDb, issueId: string): Promise<FlowCaseState | null> {
  const rows = await db
    .select(FLOW_CASE_COLUMNS)
    .from(pipelineCases)
    .innerJoin(pipelineCaseIssueLinks, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
    .where(
      and(
        eq(pipelineCaseIssueLinks.issueId, issueId),
        eq(pipelineCaseIssueLinks.role, FLOW_CASE_LINK_ROLE),
        isNull(pipelineCaseIssueLinks.retiredAt),
        eq(pipelineCases.definitionKind, "flow"),
      ),
    )
    .limit(1);
  return rows[0] ? toState(rows[0]) : null;
}

/** Batch form for the sweep, which loads many stale flows at once and must not
 *  turn that into one query per row. */
export async function loadFlowCasesForIssues(
  db: FlowCaseDb,
  issueIds: string[],
): Promise<Map<string, FlowCaseState>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({ ...FLOW_CASE_COLUMNS, issueId: pipelineCaseIssueLinks.issueId })
    .from(pipelineCases)
    .innerJoin(pipelineCaseIssueLinks, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
    .where(
      and(
        inArray(pipelineCaseIssueLinks.issueId, issueIds),
        eq(pipelineCaseIssueLinks.role, FLOW_CASE_LINK_ROLE),
        isNull(pipelineCaseIssueLinks.retiredAt),
        eq(pipelineCases.definitionKind, "flow"),
      ),
    );
  return new Map(rows.map((row) => [row.issueId, toState(row)]));
}

/**
 * The case for a starting flow: created on the issue's first flow, RESET on
 * every later one.
 *
 * Reset rather than a second row, because the case is the issue's runtime
 * state and an issue runs at most one flow at a time — a second row would make
 * "the case for this issue" ambiguous for every reader, to buy a history the
 * activity log already keeps. The version keeps climbing across the reset,
 * which is exactly what makes a snapshot taken before a restart unusable
 * afterwards.
 */
export async function startFlowCase(
  db: FlowCaseDb,
  input: {
    companyId: string;
    issueId: string;
    caseKey: string;
    title: string;
    flowName: string;
    stepKey: string;
    at: Date;
  },
): Promise<FlowCaseState> {
  const existing = await loadFlowCaseForIssue(db, input.issueId);
  if (existing) {
    const [updated] = await db
      .update(pipelineCases)
      .set({
        definitionRef: input.flowName,
        stepKey: input.stepKey,
        title: input.title,
        terminalKind: null,
        terminalAt: null,
        version: sql`${pipelineCases.version} + 1`,
        updatedAt: input.at,
      })
      .where(eq(pipelineCases.id, existing.id))
      .returning(FLOW_CASE_COLUMNS);
    if (!updated) throw conflict("Flow case disappeared while starting the flow", { code: "version_conflict" });
    return toState(updated);
  }
  const [inserted] = await db
    .insert(pipelineCases)
    .values({
      companyId: input.companyId,
      pipelineId: null,
      stageId: null,
      definitionKind: "flow",
      definitionRef: input.flowName,
      stepKey: input.stepKey,
      caseKey: input.caseKey,
      title: input.title,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning(FLOW_CASE_COLUMNS);
  await db
    .insert(pipelineCaseIssueLinks)
    .values({
      companyId: input.companyId,
      caseId: inserted.id,
      issueId: input.issueId,
      role: FLOW_CASE_LINK_ROLE,
    })
    .onConflictDoNothing();
  return toState(inserted);
}

/**
 * Move the case, under the version the caller read.
 *
 * A miss is a 409 carrying the pipelines `version_conflict` contract verbatim
 * (`{ code, expectedVersion, actualVersion }`, services/pipelines.ts) — one
 * concurrency contract across the substrate, not two.
 */
export async function advanceFlowCase(
  db: FlowCaseDb,
  expected: FlowCaseState,
  next: { stepKey: string; terminalKind: string | null; at: Date },
): Promise<FlowCaseState> {
  const [updated] = await db
    .update(pipelineCases)
    .set({
      stepKey: next.stepKey,
      terminalKind: next.terminalKind,
      terminalAt: next.terminalKind ? next.at : null,
      version: sql`${pipelineCases.version} + 1`,
      updatedAt: next.at,
    })
    .where(and(eq(pipelineCases.id, expected.id), eq(pipelineCases.version, expected.version)))
    .returning(FLOW_CASE_COLUMNS);
  if (!updated) {
    const actual = await db
      .select({ version: pipelineCases.version })
      .from(pipelineCases)
      .where(eq(pipelineCases.id, expected.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    throw conflict("Flow case version conflict", {
      code: "version_conflict",
      caseId: expected.id,
      expectedVersion: expected.version,
      actualVersion: actual?.version ?? null,
    });
  }
  return toState(updated);
}
