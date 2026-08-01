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
import { enrichDesignFiles, type DesignArchiveFetcher } from "./design-artifact.js";
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
  /** The file's unified diff hunks. Optional at this seam on purpose: an
   *  older apex-core (before the get_pull_request patch extension) simply
   *  omits it and the UI falls back to the file list, rather than the brief
   *  failing to assemble. */
  patch: z.string().nullish(),
  /** GitHub reported no patch AND no changes — a blob, not an empty diff. */
  binary: z.boolean().nullish(),
  /** This file's diff was cut (by core's budget, or by GitHub itself). */
  patch_truncated: z.boolean().nullish(),
  /** Filled in by the brief (NOT by apex-core) for design documents it could
   *  read: see ./design-artifact.ts. Absent means "nothing could be read",
   *  which the design renderer states rather than papers over. */
  design: z
    .object({
      preview: z.object({ label: z.string(), dataUri: z.string() }).nullish(),
      boards: z.array(z.string()).nullish(),
    })
    .nullish(),
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

// ---------------------------------------------------------------------------
// Artifact KIND — classified here, once, server-side
// ---------------------------------------------------------------------------

/**
 * What kind of thing the reviewer is being asked to look at. The UI keys its
 * artifact-renderer registry off this and never re-derives it: one classifier,
 * one vocabulary, one place to fix when a new artifact type shows up.
 */
export type ArtifactKind = "code" | "design" | "plan" | "doc" | "unknown";

/** Binary design-tool documents. A PR touching one of these IS a design change. */
const DESIGN_EXTENSIONS = new Set(["penpot", "fig", "sketch", "xd", "afdesign"]);
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb",
  "php", "cs", "swift", "c", "h", "cc", "cpp", "hpp", "scala", "clj", "ex",
  "exs", "sh", "bash", "zsh", "sql", "tf", "tfvars", "yaml", "yml", "json",
  "toml", "ini", "css", "scss", "less", "html", "vue", "svelte", "proto",
  "graphql", "gradle", "dockerfile",
]);
const DOC_EXTENSIONS = new Set(["md", "mdx", "txt", "rst", "adoc"]);
/** Markdown living under one of these is a PLAN, not prose documentation. */
const PLAN_DIR_RE = /(^|\/)(specs?|plans?|rfcs?|proposals?|adrs?)(\/|$)/i;
const PLAN_NAME_RE = /(^|[./-])(spec|plan|tasks|proposal|rfc|adr)([.-]|$)/i;

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base; // "Dockerfile", "Makefile" — the name IS the type
  return base.slice(dot + 1);
}

/** The kind of a single path. `null` = this file votes for nothing. */
export function classifyPath(path: string): ArtifactKind | null {
  const ext = extensionOf(path);
  if (DESIGN_EXTENSIONS.has(ext)) return "design";
  if (DOC_EXTENSIONS.has(ext)) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return PLAN_DIR_RE.test(path) || PLAN_NAME_RE.test(base) ? "plan" : "doc";
  }
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return null;
}

/**
 * Classify a whole changeset.
 *
 * The rule, stated once so it is arguable rather than emergent:
 *  1. ANY design document present ⇒ `design`. A .penpot in the diff is the
 *     point of the review; it is never outvoted by the files around it.
 *  2. Otherwise the kind holding the most files wins.
 *  3. Ties break by precedence code > plan > doc — the reviewer is better
 *     served being shown the more consequential surface.
 *  4. No files, or nothing recognised ⇒ `unknown` (the fallback renderer).
 */
export function classifyArtifactKind(files: { path: string }[]): ArtifactKind {
  const counts = new Map<ArtifactKind, number>();
  for (const file of files) {
    const kind = classifyPath(file.path);
    if (!kind) continue;
    if (kind === "design") return "design";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best: ArtifactKind = "unknown";
  let bestCount = 0;
  for (const kind of ["code", "plan", "doc"] as const) {
    const count = counts.get(kind) ?? 0;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

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
      /** Which renderer the UI should reach for. Derived HERE from the
       *  changed paths — the UI never re-derives it. */
      artifactKind: ArtifactKind;
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
      artifactKind: classifyArtifactKind(result.files ?? []),
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

/**
 * How hard the post-gate consequence is to take back. Ordered least → most
 * severe; `deriveReversibility` takes the WORST across every post-gate node,
 * because a flow is only as reversible as its least reversible step.
 */
export type Reversibility = "reversible" | "reversible_with_effort" | "irreversible" | "unknown";

const REVERSIBILITY_RANK: Record<Reversibility, number> = {
  reversible: 0,
  unknown: 1,
  reversible_with_effort: 2,
  irreversible: 3,
};

/** Vocabulary shown to the reviewer, one line per level. */
const REVERSIBILITY_LINE: Record<Reversibility, string> = {
  reversible: "Reversible — what runs after this gate can be undone (a merge by a revert commit).",
  reversible_with_effort:
    "Reversible with effort — the change goes live and can only be taken back by rolling forward or redeploying.",
  irreversible: "NOT reversible — a step after this gate destroys or replaces something permanently.",
  unknown: "Reversibility unknown — the flow's post-gate steps could not be read.",
};

/** Name-shape rules over the post-gate workflow a flow actually runs. Kept
 *  deliberately small and readable: these are the four verbs APEX flows use
 *  today (merge / deploy / release / destroy). An unmatched name stays
 *  `unknown` rather than being optimistically called reversible. */
const IRREVERSIBLE_RE = /destroy|delete|teardown|tear-down|drop|purge|revoke|rotate|prune/i;
const LIVE_CHANGE_RE = /deploy|release|publish|promote|rollout|roll-out|ship|apply/i;
const MERGE_RE = /merge|land|commit|push|pr-merge/i;

/** Reversibility of ONE post-gate node. */
export function nodeReversibility(node: FlowNode): Reversibility {
  if (node.kind === "workflow" && node.workflow) {
    const name = node.workflow.workflow;
    if (IRREVERSIBLE_RE.test(name)) return "irreversible";
    if (MERGE_RE.test(name)) return "reversible";
    if (LIVE_CHANGE_RE.test(name)) return "reversible_with_effort";
    return "unknown";
  }
  // Checks read, they don't change the world. Another gate pauses again, and
  // an agent step's own gate is where its consequence is decided.
  if (node.kind === "check" || node.kind === "gate") return "reversible";
  if (node.kind === "agent") return "reversible_with_effort";
  return "unknown";
}

export type RiskSection = {
  reversibility: Reversibility;
  /** The one-line reversibility statement shown under "On approval". */
  reversibilityLine: string;
  /** Concrete risks, in the vocabulary the board-approval brief already uses. */
  risks: string[];
  /** true when reversibility came from the flow definition, not a fallback. */
  derived: boolean;
};

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

/**
 * Derive the risk + reversibility of approving THIS gate.
 *
 * Reversibility is the worst level across every node after the gate — a flow
 * whose second post-gate step destroys a bucket is not made safe by its first
 * step being a merge. Risks are stated concretely (naming the workflow, the
 * failed check, the unreadable artifact) so the line is worth reading; the
 * labels match the board-approval brief's existing "Risks" section rather
 * than inventing a second vocabulary.
 */
export function deriveRisk(input: {
  flow: FlowDefinition | null;
  gateNodeId: string | null;
  verified: VerifiedSection;
  artifact: PrDiffSummary;
}): RiskSection {
  const { flow, gateNodeId, verified, artifact } = input;
  const risks: string[] = [];

  let reversibility: Reversibility = "unknown";
  let derived = false;
  const index = flow && gateNodeId ? flow.nodes.findIndex((n) => n.id === gateNodeId) : -1;
  if (flow && index >= 0) {
    derived = true;
    const remaining = flow.nodes.slice(index + 1);
    if (remaining.length === 0) {
      // Nothing runs. Approving closes the flow and changes nothing further.
      reversibility = "reversible";
    } else {
      reversibility = "reversible";
      for (const node of remaining) {
        const level = nodeReversibility(node);
        if (REVERSIBILITY_RANK[level] > REVERSIBILITY_RANK[reversibility]) {
          reversibility = level;
        }
        if (level === "irreversible" && node.kind === "workflow" && node.workflow) {
          risks.push(
            `Workflow \`${node.workflow.workflow}\` runs after this gate and destroys or replaces something — there is no undo step in this flow.`,
          );
        }
        if (level === "reversible_with_effort" && node.kind === "workflow" && node.workflow) {
          risks.push(
            `Workflow \`${node.workflow.workflow}\` runs after this gate, so the change goes live as soon as you approve.`,
          );
        }
        if (level === "unknown" && node.kind === "workflow" && node.workflow) {
          risks.push(
            `Workflow \`${node.workflow.workflow}\` runs after this gate and its effect could not be classified — check what it does before approving.`,
          );
        }
      }
    }
  }

  if (verified.ok === false) {
    risks.push("The step's automatic check did NOT pass — you are approving over a failed check.");
  } else if (verified.ok === null) {
    risks.push("Nothing about this change was machine-verified; the review is entirely yours.");
  }

  if (artifact.available === false) {
    risks.push("No artifact is linked to this gate, so there is nothing to inspect before approving.");
  } else if (artifact.degraded) {
    risks.push(`The artifact could not be loaded (${artifact.error}) — you would be approving it unseen.`);
  } else {
    if (artifact.files_truncated) {
      risks.push("The changed-file list is truncated — some changed files are not shown below.");
    }
    if (artifact.artifactKind === "design" || artifact.artifactKind === "unknown") {
      const binaries = artifact.files.filter((f) => f.binary === true).length;
      if (binaries > 0) {
        risks.push(
          `${binaries} changed file${binaries === 1 ? " is" : "s are"} binary, so no line-level diff exists for ${binaries === 1 ? "it" : "them"}.`,
        );
      }
    }
  }

  return {
    reversibility,
    reversibilityLine: REVERSIBILITY_LINE[reversibility],
    risks,
    derived,
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
      risk: RiskSection;
      provenance: ProvenanceSection;
      /** When this gate started waiting for a human — the UI turns it into
       *  "waiting 3 hours". Falls back through the activity log's stamps so a
       *  gate opened before this field existed still reports something. */
      waitingSince: string | null;
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
  /** Injected so the design preview is testable without gh, and so a brief
   *  assembled in a context with no GitHub access simply has no preview
   *  rather than failing. */
  fetchDesignArchive?: DesignArchiveFetcher;
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

  // A design artifact is the case the file list served worst — enrich it with
  // what the committed .penpot itself can tell us (board names, and a board
  // rendered offline to SVG). Failure-isolated: no preview is a fine brief.
  if (
    input.fetchDesignArchive &&
    artifact.available === true &&
    artifact.degraded === false &&
    artifact.artifactKind === "design"
  ) {
    await enrichDesignFiles({
      files: artifact.files,
      repo: artifact.repo,
      ref: artifact.headBranch,
      fetchArchive: input.fetchDesignArchive,
    });
  }

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
    risk: deriveRisk({ flow, gateNodeId: nodeId, verified, artifact }),
    provenance,
    waitingSince: provenance.gateOpenedAt ?? provenance.verifiedAt ?? provenance.commissionedAt,
    machine: {
      approvalId: input.approvalId,
      issueId,
      flowName,
      nodeId,
      ticketType: ticketType ?? flow?.ticket_type ?? null,
    },
  };
}
