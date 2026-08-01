/**
 * Flow-gate DECISION BRIEF assembly.
 *
 * Why this exists (founder critique, verbatim): reviewing a flow-gated ticket
 * today means "reviewing agent slop" — the gate is surrounded by machine
 * correspondence (instruction comments, wake fences, status transitions, raw
 * acceptance strings like `pr_exists:owner/repo#branch`) and the reviewer says
 * "I don't know what to interpret, where to start and where to end."
 *
 * A gate approval must therefore read as a DECISION, not a log. This module
 * assembles, in the order a human decides:
 *   1. what is being decided        (plain sentence, no UUIDs)
 *   2. what the system already verified (acceptance translated to English;
 *      the machine string is carried alongside for a details affordance,
 *      never as the headline)
 *   3. what to look at              (the artifact — the PR summary)
 *   4. what happens next            (DERIVED from the flow definition's
 *      post-gate nodes via `apex flows show`, never hardcoded)
 *   5. who/what did the work        (agent display name, permission profile,
 *      timestamps)
 *
 * Failure isolation, same doctrine as the pr-diff route it grew out of: every
 * external read (apex CLI for the PR, apex CLI for the flow definition, the
 * provenance DB lookup) degrades to a structured, still-useful brief. This
 * module never throws for an external failure and the route never 500s.
 */
import { z } from "zod";
import { ApexUnavailableError, ApexInvocationError, type ApexInvoker } from "../invoke.js";
import { acceptancePullRequestTarget } from "./agent-step.js";
import { FlowDefinitionError, type FlowDefinition, type FlowNode, type LoadedFlowDefinition } from "./definition.js";

/** Zod contract for github_repo's get_pull_request tool result (apex-core,
 *  the changed-files extension) — the SAME schema both the pr-diff route and
 *  the brief shape their response from, so a CLI contract drift fails loudly
 *  here rather than silently in the UI. */
const PullRequestFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
});
export const GetPullRequestResultSchema = z
  .object({
    status: z.string(),
    url: z.string().optional(),
    head_ref: z.string().optional(),
    title: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changed_files: z.number().nullable().optional(),
    files: z.array(PullRequestFileSchema).optional(),
    files_truncated: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type PullRequestFile = z.infer<typeof PullRequestFileSchema>;

export type PrDiffSummary =
  | { available: false; reason: string }
  | {
      available: true;
      degraded: true;
      repo: string;
      headBranch: string;
      error: string;
      acceptanceEvaluation: string | null;
    }
  | {
      available: true;
      degraded: false;
      repo: string;
      headBranch: string;
      url: string;
      title: string;
      totals: { additions: number; deletions: number; changedFiles: number };
      files: PullRequestFile[];
      files_truncated: boolean;
      acceptanceEvaluation: string | null;
    };

/** One row of the issue's activity log, as much of it as the brief reads. */
export type ActivityRowLike = {
  action?: string | null;
  createdAt?: Date | string | null;
  details?: unknown;
};

export type AcceptanceTarget = {
  prTarget: { repo: string; head: string };
  acceptance: string;
  acceptanceEvaluation: string | null;
};

function detailsOf(row: ActivityRowLike): Record<string, unknown> {
  const details = row.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  return details as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

/**
 * Walk the issue's activity log (newest first) for the most recent
 * agent-step acceptance that declared a `pr_exists:<repo>#<head>` target.
 * Same parsing the acceptance evaluator uses (acceptancePullRequestTarget) —
 * not duplicated here.
 */
export function findAcceptanceTarget(rows: ActivityRowLike[]): AcceptanceTarget | null {
  for (const row of rows) {
    const details = detailsOf(row);
    const acceptance = str(details.acceptance);
    if (!acceptance) continue;
    const target = acceptancePullRequestTarget(acceptance);
    if (target) {
      return {
        prTarget: target,
        acceptance,
        acceptanceEvaluation: str(details.acceptanceEvaluation),
      };
    }
  }
  return null;
}

/** Fetch the current PR summary through apex-core's github_repo tool.
 *  Never throws for an apex/gh failure — degrades to a structured summary. */
export async function fetchPullRequestSummary(
  apexInvoker: ApexInvoker,
  target: AcceptanceTarget,
): Promise<PrDiffSummary> {
  const { prTarget, acceptanceEvaluation } = target;
  try {
    const result = await apexInvoker.invoke(
      "github_repo",
      "get_pull_request",
      { repo: prTarget.repo, head: prTarget.head },
      GetPullRequestResultSchema,
    );
    if (result.status !== "success") {
      return {
        available: true,
        degraded: true,
        repo: prTarget.repo,
        headBranch: prTarget.head,
        error: result.error ?? `get-pull-request reported status '${result.status}'`,
        acceptanceEvaluation,
      };
    }
    return {
      available: true,
      degraded: false,
      repo: prTarget.repo,
      headBranch: result.head_ref ?? prTarget.head,
      url: result.url ?? "",
      title: result.title ?? "",
      totals: {
        additions: result.additions ?? 0,
        deletions: result.deletions ?? 0,
        changedFiles: result.changed_files ?? result.files?.length ?? 0,
      },
      files: result.files ?? [],
      files_truncated: result.files_truncated ?? false,
      acceptanceEvaluation,
    };
  } catch (err) {
    if (err instanceof ApexUnavailableError || err instanceof ApexInvocationError) {
      return {
        available: true,
        degraded: true,
        repo: prTarget.repo,
        headBranch: prTarget.head,
        error: err.message,
        acceptanceEvaluation,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2. What the system already verified — acceptance, translated
// ---------------------------------------------------------------------------

export type VerifiedSection = {
  /** Plain-English headline. Never a machine string. */
  headline: string;
  /** true = check passed, false = check failed, null = nothing machine-checked. */
  ok: boolean | null;
  /** The raw machine strings, for a details/tooltip affordance only. */
  machine: string[];
};

/**
 * Translate an acceptance declaration + its recorded evaluation into the one
 * sentence a founder needs. `pr_exists:owner/repo#branch` is NEVER the
 * headline — it goes to `machine`.
 */
export function describeAcceptance(
  acceptance: string | null,
  evaluation: string | null,
): VerifiedSection {
  const machine = [acceptance, evaluation].filter((v): v is string => !!v && v.trim().length > 0);
  if (!acceptance && !evaluation) {
    return {
      headline: "No automatic check was recorded for the step that produced this change.",
      ok: null,
      machine,
    };
  }
  const failed = !!evaluation && /FAILED/i.test(evaluation);
  const prTarget = acceptance ? acceptancePullRequestTarget(acceptance) : null;

  if (prTarget) {
    if (failed) {
      return {
        headline:
          "The check did NOT pass: the pull request the agent was required to open could not be found.",
        ok: false,
        machine,
      };
    }
    return {
      headline: "Verified: the agent's run succeeded and the pull request it was required to open exists.",
      ok: true,
      machine,
    };
  }
  if (acceptance && /^file_exists:/i.test(acceptance.trim())) {
    return failed
      ? {
          headline: "The check did NOT pass: the file the agent was required to produce is missing.",
          ok: false,
          machine,
        }
      : {
          headline: "Verified: the agent's run succeeded and the file it was required to produce exists.",
          ok: true,
          machine,
        };
  }
  if (failed) {
    return { headline: "The step's automatic check did NOT pass.", ok: false, machine };
  }
  return {
    headline:
      "Verified: the agent's run succeeded. The step declared no further automatically checkable artifact.",
    ok: null,
    machine,
  };
}

// ---------------------------------------------------------------------------
// 4. What happens next — DERIVED from the flow definition
// ---------------------------------------------------------------------------

export type NextSection = {
  approve: string;
  reject: string;
  /** true when the text came from the flow definition; false = generic fallback. */
  derived: boolean;
  /** Why the derivation degraded, when it did. */
  note: string | null;
};

/** Describe one post-gate node in plain language, naming the concrete thing
 *  it runs (the workflow / check tool / gate id) — this is the whole point of
 *  reading the flow definition instead of hardcoding a sentence. */
function describeNode(node: FlowNode): string {
  if (node.kind === "workflow" && node.workflow) {
    return `workflow \`${node.workflow.workflow}\` runs`;
  }
  if (node.kind === "check" && node.check) {
    return `the automatic check \`${node.check.tool}\` runs`;
  }
  if (node.kind === "agent") {
    return `a bounded agent step (\`${node.id}\`) is commissioned`;
  }
  if (node.kind === "gate") {
    return `the flow pauses for another approval (\`${node.id}\`)`;
  }
  return `step \`${node.id}\` runs`;
}

const GENERIC_NEXT: NextSection = {
  approve: "Approve → the flow continues past this gate and runs its remaining steps automatically.",
  reject:
    "Reject → the flow stops here and is left paused. Nothing is merged or undone; any work already published stays as it is, for you to handle.",
  derived: false,
  note: null,
};

/**
 * Derive "what happens next" from the flow's own definition: find this gate
 * node, then describe the node(s) after it. The rejection consequence is the
 * coordinator's documented behaviour (onGateDecision → pause + surface), and
 * is stated concretely against the artifact when we know what the artifact is.
 */
export function deriveNextSteps(
  flow: FlowDefinition | null,
  gateNodeId: string | null,
  artifact: { kind: "pull_request"; repo: string; headBranch: string } | null,
  note: string | null = null,
): NextSection {
  const artifactNoun = artifact ? "the pull request" : "the change";
  const rejectText =
    `Reject → the flow stops at this gate and stays paused; nothing further runs automatically. ` +
    (artifact
      ? `${artifactNoun} (${artifact.repo} · ${artifact.headBranch}) stays open for you to handle.`
      : `${artifactNoun} is left as it is for you to handle.`);

  if (!flow || !gateNodeId) {
    return { ...GENERIC_NEXT, reject: rejectText, note };
  }
  const index = flow.nodes.findIndex((node) => node.id === gateNodeId);
  if (index < 0) {
    return {
      ...GENERIC_NEXT,
      reject: rejectText,
      note: note ?? `gate '${gateNodeId}' is not present in flow '${flow.name}'`,
    };
  }
  const remaining = flow.nodes.slice(index + 1);
  if (remaining.length === 0) {
    return {
      approve: "Approve → this is the flow's last gate; the flow completes.",
      reject: rejectText,
      derived: true,
      note,
    };
  }
  const next = remaining[0] as FlowNode;
  const tail =
    remaining.length === 1
      ? " and the flow completes."
      : `, then ${remaining.length - 1} more step${remaining.length - 1 === 1 ? "" : "s"} before the flow completes.`;
  const scope =
    next.kind === "workflow" && next.workflow && artifact
      ? ` on ${artifact.repo} (${artifact.headBranch})`
      : "";
  return {
    approve: `Approve → ${describeNode(next)}${scope}${tail}`,
    reject: rejectText,
    derived: true,
    note,
  };
}

// ---------------------------------------------------------------------------
// 5. Who / what did the work
// ---------------------------------------------------------------------------

export type ProvenanceSection = {
  agentName: string | null;
  agentId: string | null;
  runId: string | null;
  permissionProfile: string | null;
  permissionMode: string | null;
  commissionedAt: string | null;
  verifiedAt: string | null;
  gateOpenedAt: string | null;
};

export type ProvenanceLookup = (input: {
  agentId: string | null;
  runId: string | null;
}) => Promise<{ agentName: string | null; permissionProfile: string | null; permissionMode: string | null }>;

/** Pull the agent/run identifiers and the three timestamps a reviewer cares
 *  about out of the issue's activity log (newest-first). */
export function readProvenanceFromActivity(rows: ActivityRowLike[]): ProvenanceSection {
  let agentId: string | null = null;
  let runId: string | null = null;
  let commissionedAt: string | null = null;
  let verifiedAt: string | null = null;
  let gateOpenedAt: string | null = null;

  for (const row of rows) {
    const action = str(row.action);
    const details = detailsOf(row);
    if (action === "flow.gate_opened" && !gateOpenedAt) gateOpenedAt = iso(row.createdAt);
    if (action === "flow.agent_step_succeeded" && !verifiedAt) verifiedAt = iso(row.createdAt);
    if (action === "flow.agent_run_commissioned" && !commissionedAt) {
      commissionedAt = iso(row.createdAt);
      agentId = agentId ?? str(details.agentId);
      runId = runId ?? str(details.runId);
    }
    if (!agentId) agentId = str(details.agentId);
    if (!runId && (action === "flow.agent_step_succeeded" || action === "flow.agent_run_relinked")) {
      runId = str(details.runId) ?? str(details.toRunId);
    }
  }
  return {
    agentName: null,
    agentId,
    runId,
    permissionProfile: null,
    permissionMode: null,
    commissionedAt,
    verifiedAt,
    gateOpenedAt,
  };
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export type DecisionSection = {
  /** One short sentence naming the kind of decision. No IDs. */
  headline: string;
  /** The ticket's own title — the human subject of the change. */
  subject: string | null;
  /** What concretely changed, in plain language ("1 file changed in …"). */
  detail: string | null;
  /** The flow's own one-line description of what it is for, when available. */
  flowPurpose: string | null;
  ticketIdentifier: string | null;
};

export type FlowGateBrief =
  | { available: false; reason: string }
  | {
      available: true;
      decision: DecisionSection;
      verified: VerifiedSection;
      artifact: PrDiffSummary;
      next: NextSection;
      provenance: ProvenanceSection;
      /** Machine identifiers — details affordance only, never the headline. */
      machine: {
        approvalId: string;
        issueId: string;
        flowName: string | null;
        nodeId: string | null;
        ticketType: string | null;
      };
    };

function titleCaseTicketType(ticketType: string | null): string {
  if (!ticketType) return "change";
  return ticketType.replace(/[-_]+/g, " ").trim() || "change";
}

function describeArtifactDetail(artifact: PrDiffSummary): string | null {
  if (artifact.available === false) return null;
  if (artifact.degraded) return `A pull request on ${artifact.repo} (${artifact.headBranch}).`;
  const n = artifact.totals.changedFiles;
  const fileWord = `${n} file${n === 1 ? "" : "s"}`;
  const named =
    artifact.files.length > 0 && artifact.files.length <= 3
      ? ` — ${artifact.files.map((f) => f.path).join(", ")}`
      : "";
  return `${fileWord} changed in ${artifact.repo}${named}.`;
}

/**
 * Assemble the full decision brief. Pure orchestration over injected readers,
 * so every branch (full data / degraded PR / missing acceptance / flow
 * definition unavailable) is directly testable.
 */
export async function assembleFlowGateBrief(input: {
  approvalId: string;
  payload: Record<string, unknown>;
  activityRows: ActivityRowLike[];
  apexInvoker: ApexInvoker;
  loadFlowDefinition: (name: string) => Promise<LoadedFlowDefinition>;
  provenanceLookup?: ProvenanceLookup;
}): Promise<FlowGateBrief> {
  const { payload } = input;
  const issueId = str(payload.issueId);
  if (!issueId) {
    return { available: false, reason: "approval payload missing issueId" };
  }
  const flowName = str(payload.flowName);
  const nodeId = str(payload.nodeId);
  const ticketType = str(payload.ticketType);
  const ticketIdentifier = str(payload.issueIdentifier);
  const issueTitle = str(payload.issueTitle);

  // --- artifact + acceptance -------------------------------------------
  const target = findAcceptanceTarget(input.activityRows);
  const artifact: PrDiffSummary = target
    ? await fetchPullRequestSummary(input.apexInvoker, target)
    : { available: false, reason: "no pr_exists acceptance found for this issue" };

  const verified = describeAcceptance(target?.acceptance ?? null, target?.acceptanceEvaluation ?? null);

  // --- what happens next, derived from the flow definition ---------------
  let flow: FlowDefinition | null = null;
  let flowNote: string | null = null;
  if (flowName) {
    try {
      flow = (await input.loadFlowDefinition(flowName)).flow;
    } catch (err) {
      flowNote =
        err instanceof FlowDefinitionError || err instanceof ApexUnavailableError
          ? `flow definition unavailable (${err.message})`
          : `flow definition unavailable (${err instanceof Error ? err.message : String(err)})`;
    }
  } else {
    flowNote = "approval payload carries no flow name";
  }
  const artifactRef =
    target !== null
      ? { kind: "pull_request" as const, repo: target.prTarget.repo, headBranch: target.prTarget.head }
      : null;
  const next = deriveNextSteps(flow, nodeId, artifactRef, flowNote);

  // --- provenance --------------------------------------------------------
  const provenance = readProvenanceFromActivity(input.activityRows);
  if (input.provenanceLookup && (provenance.agentId || provenance.runId)) {
    try {
      const extra = await input.provenanceLookup({
        agentId: provenance.agentId,
        runId: provenance.runId,
      });
      provenance.agentName = extra.agentName;
      provenance.permissionProfile = extra.permissionProfile;
      provenance.permissionMode = extra.permissionMode;
    } catch {
      // Provenance is context, never a blocker — a failed lookup leaves the
      // ids in place and the brief still answers the decision.
    }
  }

  const kind = titleCaseTicketType(ticketType ?? flow?.ticket_type ?? null);
  return {
    available: true,
    decision: {
      headline: `Approve a ${kind}`,
      subject: issueTitle,
      detail: describeArtifactDetail(artifact),
      flowPurpose: flow?.description?.trim() || null,
      ticketIdentifier,
    },
    verified,
    artifact,
    next,
    provenance,
    machine: {
      approvalId: input.approvalId,
      issueId,
      flowName,
      nodeId,
      ticketType: ticketType ?? flow?.ticket_type ?? null,
    },
  };
}
