/**
 * A-node bridge helpers — the pure half of driving a bounded agent step
 * through the fork's native execution machinery (heartbeat runs).
 *
 * The instruction-injection channel (discovered, not invented): a heartbeat
 * wakeup that carries a `commentId` in its payload/contextSnapshot has that
 * issue comment loaded at dispatch (services/heartbeat.ts, wakeCommentContext)
 * and rendered into the agent's prompt as the "Latest wake comment" fence by
 * `buildPaperclipTaskMarkdown`. So the coordinator posts the node's rendered
 * prompt + acceptance as a system issue comment and passes its id through the
 * wakeup — the run's instruction IS that comment, alongside the issue
 * title/description the task markdown already carries natively.
 *
 * Honest v1 acceptance evaluation (documented, not hidden):
 * - base criterion, always: the commissioned run reached terminal status
 *   `succeeded`.
 * - additionally, when the node's `acceptance` string declares a cheaply
 *   verifiable artifact in the form `file_exists:<path>` (absolute, or
 *   relative to APEX_LAUNCH_DIR / ~/.apex-cockpit), the file's existence is
 *   verified with fs.stat.
 * - additionally, when it declares `pr_exists:<repo>#<head-branch>`, the
 *   OPEN pull request for that head branch is verified through the apex CLI
 *   (`apex run github_repo get-pull-request --repo … --head …` — the
 *   producer-owns seam, same doctrine as flow definitions). The PR's URL is
 *   recorded in the evaluation string, so the gate approval's activity
 *   trail carries the artifact link.
 * - every other acceptance string is recorded verbatim in the activity log
 *   and evaluated as run-success-only — no LLM judging, no expression engine.
 *
 * Acceptance strings are TEMPLATES: the coordinator renders `{{identifier}}`
 * etc. through `renderAgentPrompt` before posting the instruction comment
 * and before evaluating — the agent and the evaluator always see the same
 * concrete string (e.g. `pr_exists:sarala-ai/apex-design#design/APE-7`).
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { run } from "../exec.js";
import { ApexUnavailableError } from "../invoke.js";

export const FLOW_AGENT_WAKE_REASON = "flow_agent_step";
/** contextSnapshot marker the completion hook keys on — only runs the flow
 *  coordinator itself commissioned ever re-enter the coordinator. */
export const FLOW_AGENT_CONTEXT_KEY = "flowAgentStep";

/** Run statuses the flow treats as a completed commission. `interrupted` is
 *  deliberately absent: the heartbeat machinery may still revive it via its
 *  process-loss retry (retryOfRunId chain); the sweep resolves the chain. */
export const FLOW_TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;
export type FlowTerminalRunStatus = (typeof FLOW_TERMINAL_RUN_STATUSES)[number];

export type AgentPromptContext = {
  identifier: string | null;
  title: string;
  description: string | null;
  /** issues.agent_brief — the machine half of the ticket. Available to flow
   *  prompt templates as `{{agent_brief}}`; the agent also receives it
   *  natively in its task context (buildPaperclipTaskMarkdown). */
  agentBrief: string | null;
  issueId: string;
  flowName: string | null;
  nodeId: string;
  acceptance: string;
};

/** Interpolate `{{placeholder}}` tokens in an A-node prompt template.
 *  Unknown placeholders are left verbatim — never silently dropped. */
export function renderAgentPrompt(template: string, context: AgentPromptContext): string {
  const values: Record<string, string> = {
    identifier: context.identifier ?? context.issueId,
    title: context.title,
    description: context.description ?? "",
    agent_brief: context.agentBrief ?? "",
    issue_id: context.issueId,
    flow_name: context.flowName ?? "",
    node_id: context.nodeId,
    acceptance: context.acceptance,
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (token, key: string) =>
    key in values ? values[key] : token,
  );
}

/** Interpolate `{{placeholder}}` tokens in a workflow node's params — string
 *  values only, non-strings pass through untouched. Same token grammar as
 *  prompts/acceptance, so `head: design/{{identifier}}` in a flow definition
 *  becomes the ticket's concrete branch. */
export function renderWorkflowParams(
  params: Record<string, unknown>,
  context: AgentPromptContext,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === "string" ? renderAgentPrompt(value, context) : value,
    ]),
  );
}

export type AcceptanceEvaluation =
  | { ok: true; evaluation: string }
  | { ok: false; evaluation: string; message: string };

const FILE_EXISTS_RE = /^file_exists:\s*(.+)$/;
const PR_EXISTS_RE = /^pr_exists:\s*([^#\s]+)#(\S+)$/;

export type PullRequestCheck =
  | { exists: true; url: string; number: number | null }
  | { exists: false; message: string };

/** Look up the OPEN pull request for a head branch via the apex CLI —
 *  github_repo's get-pull-request tool is read-path (dry_run_enabled: false),
 *  so no execution-mode escalation is involved. */
const prCheckEnvelopeSchema = z
  .object({
    status: z.string(),
    error: z.string().optional(),
    error_type: z.string().optional(),
    result: z
      .object({ url: z.string().optional(), number: z.number().optional(), state: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export async function checkPullRequestViaCli(
  repo: string,
  head: string,
  options: { bin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<PullRequestCheck> {
  const bin = options.bin ?? process.env.APEX_BIN ?? "apex";
  const cwd = options.cwd ?? process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit");
  const res = await run(
    bin,
    ["--output", "json", "run", "github_repo", "get-pull-request", "--repo", repo, "--head", head],
    options.timeoutMs ?? 120_000,
    cwd,
  );
  if (res.status === "missing") {
    throw new ApexUnavailableError(`apex CLI not found (bin: ${bin})`);
  }
  let envelope: z.infer<typeof prCheckEnvelopeSchema>;
  try {
    envelope = prCheckEnvelopeSchema.parse(JSON.parse(res.stdout));
  } catch {
    return {
      exists: false,
      message:
        res.status === "failed"
          ? `apex github_repo get-pull-request failed (code ${res.code}): ${res.stderr.slice(0, 300)}`
          : "apex github_repo get-pull-request returned unparseable output",
    };
  }
  if (envelope.status !== "success") {
    return {
      exists: false,
      message: envelope.error ?? `get-pull-request reported status ${JSON.stringify(envelope.status)}`,
    };
  }
  return {
    exists: true,
    url: envelope.result?.url ?? "",
    number: envelope.result?.number ?? null,
  };
}

export function acceptanceArtifactPath(
  acceptance: string,
  launchDir: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
): string | null {
  const match = FILE_EXISTS_RE.exec(acceptance.trim());
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(launchDir, raw);
}

/** Parse a `pr_exists:<repo>#<head>` acceptance declaration, or null. */
export function acceptancePullRequestTarget(
  acceptance: string,
): { repo: string; head: string } | null {
  const match = PR_EXISTS_RE.exec(acceptance.trim());
  if (!match) return null;
  return { repo: match[1], head: match[2] };
}

/** v1 acceptance evaluation — see module doc for exactly what is checked. */
export async function evaluateAcceptanceV1(
  acceptance: string,
  options: {
    launchDir?: string;
    checkPullRequest?: (repo: string, head: string) => Promise<PullRequestCheck>;
  } = {},
): Promise<AcceptanceEvaluation> {
  const prTarget = acceptancePullRequestTarget(acceptance);
  if (prTarget !== null) {
    const check = options.checkPullRequest ?? checkPullRequestViaCli;
    const outcome = await check(prTarget.repo, prTarget.head);
    if (outcome.exists) {
      return {
        ok: true,
        evaluation:
          `v1: run success + pr_exists verified (${prTarget.repo}#${prTarget.head}` +
          (outcome.url ? ` → ${outcome.url}` : "") +
          ")",
      };
    }
    return {
      ok: false,
      evaluation: `v1: run success + pr_exists check FAILED (${prTarget.repo}#${prTarget.head})`,
      message: `acceptance pull request not found: ${outcome.message}`,
    };
  }
  const artifactPath = acceptanceArtifactPath(acceptance, options.launchDir);
  if (artifactPath === null) {
    return {
      ok: true,
      evaluation: "v1: run success only (acceptance criteria recorded, not machine-evaluated)",
    };
  }
  try {
    await stat(artifactPath);
    return { ok: true, evaluation: `v1: run success + file_exists verified (${artifactPath})` };
  } catch {
    return {
      ok: false,
      evaluation: `v1: run success + file_exists check FAILED (${artifactPath})`,
      message: `acceptance artifact not found: ${artifactPath}`,
    };
  }
}

/**
 * How a bounded agent step reports back on the ticket.
 *
 * The ticket thread is a human conversation, and an agent report is one of
 * the few things in it a human actually has to read — so it is held to the
 * standard of a colleague's message, not a build log. Everything the reader
 * can already see (the instruction, the steps, the parameters, the run's
 * own transcript) is not news and does not belong in the thread.
 *
 * This is production, not rendering: the shortest report is the one that was
 * never written long.
 */
export const AGENT_STEP_REPORT_INSTRUCTION = [
  "Reporting — how you close this step on the ticket:",
  "Post ONE short comment. First line: what happened, in one sentence, in plain language.",
  "After that, only what a reader could NOT already see — a surprise, a deviation from this instruction, or a decision someone now has to make. If there is none of that, the one sentence IS the whole comment.",
  "Do not use emoji or status checklists. Do not restate this instruction or its parameters back. Do not list the steps you took — the activity trail already has them. Do not paste command output, payloads, or diagnostics.",
  "If you are blocked, that is the report: name what is blocked and the single thing that would unblock it, in a few lines. What you tried, the errors, and the variations you attempted stay in this run's transcript — it is linked from the ticket and retrievable; do not paste it into the conversation.",
].join("\n");

/** The instruction comment the coordinator posts before commissioning —
 *  delivered to the agent as its wake comment. */
export function buildAgentInstructionComment(input: {
  flowName: string;
  nodeId: string;
  renderedPrompt: string;
  acceptance: string;
  budget: Record<string, unknown> | null | undefined;
}): string {
  const lines = [
    `Flow **${input.flowName}** agent step \`${input.nodeId}\` — bounded agent run commissioned.`,
    "",
    "Instruction:",
    input.renderedPrompt.trim(),
    "",
    `Acceptance: ${input.acceptance}`,
  ];
  if (input.budget && Object.keys(input.budget).length > 0) {
    lines.push(`Budget (advisory in v1 — not runtime-enforced): ${JSON.stringify(input.budget)}`);
  }
  lines.push("", AGENT_STEP_REPORT_INSTRUCTION);
  lines.push(
    "",
    "When this run completes, the flow coordinator evaluates acceptance and advances the flow automatically.",
  );
  return lines.join("\n");
}
