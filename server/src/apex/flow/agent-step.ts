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
 * - every other acceptance string is recorded verbatim in the activity log
 *   and evaluated as run-success-only — no LLM judging, no expression engine.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
    issue_id: context.issueId,
    flow_name: context.flowName ?? "",
    node_id: context.nodeId,
    acceptance: context.acceptance,
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (token, key: string) =>
    key in values ? values[key] : token,
  );
}

export type AcceptanceEvaluation =
  | { ok: true; evaluation: string }
  | { ok: false; evaluation: string; message: string };

const FILE_EXISTS_RE = /^file_exists:\s*(.+)$/;

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

/** v1 acceptance evaluation — see module doc for exactly what is checked. */
export async function evaluateAcceptanceV1(
  acceptance: string,
  options: { launchDir?: string } = {},
): Promise<AcceptanceEvaluation> {
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
  lines.push(
    "",
    "When this run completes, the flow coordinator evaluates acceptance and advances the flow automatically.",
  );
  return lines.join("\n");
}
