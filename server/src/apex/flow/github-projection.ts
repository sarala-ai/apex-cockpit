/**
 * GitHub projection of flow lifecycle — the decision-ledger mirror.
 *
 * Doctrine (founder-decided, see apex docs/architecture/work-loop.md): the
 * GitHub issue is the canonical CONVERSATION and audit surface; the cockpit
 * board is the canonical EXECUTION store (flow state, gates, runs). Board
 * tickets that run flows project their decision ledger — commission,
 * acceptance, gate approvals, completion — to GitHub so it is legible where
 * the industry audits. Projection is LIVE-ONLY: events are posted as they
 * happen, never retro-projected.
 *
 * Design constraints this module owns so the coordinator doesn't have to:
 * - Fire-and-forget failure isolation: every public hook resolves, never
 *   rejects. A GitHub/apex failure is a classified log line and a dropped
 *   event — it NEVER blocks or fails the flow (same posture as
 *   pipeline/github-issue-reflect.ts).
 * - Per-company opt-in: companies.githubProjectionEnabled +
 *   githubProjectionRepo, both off/null by default. Disabled = silent no-op.
 * - Mirror targeting: a board-origin issue gets a mirror GitHub issue
 *   CREATED at flow start (ref stored in issues.githubMirrorRef, typed
 *   column); a github-origin issue (originKind='plugin:github') uses its own
 *   origin issue as the target — never duplicated, and never closed by us
 *   (we close only mirrors we created, state_reason=completed).
 * - Transport: the apex CLI via the central `CliApexInvoker`
 *   (../invoke.ts) against apex-core's github_repo tools
 *   (create_issue / comment_issue / close_issue).
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { ApexInvocationError, ApexUnavailableError, CliApexInvoker, type ApexInvoker } from "../invoke.js";
import { parseGithubOriginId } from "../pipeline/github-issue-reflect.js";

/** Machine-readable marker linking a mirror GitHub issue back to its board issue. */
export function apexIssueMarker(issueId: string): string {
  return `<!-- apex:issue:${issueId} -->`;
}

/** First https URL in an acceptance evaluation string (pr_exists evaluations
 *  embed the verified PR's html_url) — the "PR link when known". */
export function extractPullRequestUrl(evaluation: string | null | undefined): string | null {
  if (!evaluation) return null;
  const match = /https:\/\/\S+/.exec(evaluation);
  if (!match) return null;
  // Trim trailing punctuation the evaluation sentence may append.
  return match[0].replace(/[).,]+$/, "");
}

/** The thin seam the flow coordinator sees. Every method is fire-and-forget
 *  safe: it resolves (never rejects) regardless of GitHub/apex outcome. */
export type FlowProjectionHooks = {
  flowStarted(event: { issueId: string; flowName: string }): Promise<void>;
  agentRunCommissioned(event: { issueId: string; nodeId: string; runId: string }): Promise<void>;
  acceptanceEvaluated(event: {
    issueId: string;
    nodeId: string;
    runId: string;
    ok: boolean;
    evaluation: string;
  }): Promise<void>;
  gateOpened(event: {
    issueId: string;
    nodeId: string;
    prompt: string | null;
    approvalId: string;
  }): Promise<void>;
  gateDecided(event: {
    issueId: string;
    nodeId: string;
    decision: "approve" | "reject";
    decidedByUserId: string;
    approvalId: string;
  }): Promise<void>;
  flowCompleted(event: {
    issueId: string;
    completedNodeId: string | null;
    acceptanceEvaluation?: string | null;
  }): Promise<void>;
  flowFailed(event: {
    issueId: string;
    nodeId: string | null;
    errorType: string;
    message: string;
  }): Promise<void>;
};

/** For tests and callers that want projection hard-off. */
export const noopFlowProjection: FlowProjectionHooks = {
  flowStarted: async () => {},
  agentRunCommissioned: async () => {},
  acceptanceEvaluated: async () => {},
  gateOpened: async () => {},
  gateDecided: async () => {},
  flowCompleted: async () => {},
  flowFailed: async () => {},
};

/** apex-core github_repo write results, post-envelope-flatten (see invoke.ts):
 *  {status, ...tool payload}. Only the fields the projection reads. */
const githubWriteResultSchema = z
  .object({
    status: z.string(),
    number: z.number().nullish(),
    url: z.string().nullish(),
  })
  .passthrough();

type ProjectionContext = {
  issueId: string;
  companyId: string;
  identifier: string | null;
  title: string;
  description: string | null;
  originKind: string;
  originId: string | null;
  githubMirrorRef: string | null;
  projectionEnabled: boolean;
  projectionRepo: string | null;
};

type ProjectionTarget = { repo: string; number: number; owned: boolean };

function classifyProjectionError(err: unknown): string {
  if (err instanceof ApexUnavailableError) return "apex_unavailable";
  if (err instanceof ApexInvocationError) return "apex_invocation_failed";
  if (err instanceof z.ZodError) return "contract_mismatch";
  return "projection_error";
}

export function githubFlowProjection(
  db: Db,
  opts: { invoker?: ApexInvoker; now?: () => Date } = {},
): FlowProjectionHooks {
  const invoker = opts.invoker ?? new CliApexInvoker();
  const now = opts.now ?? (() => new Date());

  async function loadContext(issueId: string): Promise<ProjectionContext | null> {
    const rows = await db
      .select({
        issueId: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        originKind: issues.originKind,
        originId: issues.originId,
        githubMirrorRef: issues.githubMirrorRef,
        projectionEnabled: companies.githubProjectionEnabled,
        projectionRepo: companies.githubProjectionRepo,
      })
      .from(issues)
      .innerJoin(companies, eq(issues.companyId, companies.id))
      .where(eq(issues.id, issueId));
    return (rows[0] as ProjectionContext | undefined) ?? null;
  }

  /** Resolve the GitHub issue this board issue projects onto, or null when
   *  none exists yet. github-origin issues target their origin issue
   *  (owned: false); board-origin issues target the mirror we created
   *  (owned: true). */
  function resolveTarget(ctx: ProjectionContext): ProjectionTarget | null {
    if (ctx.originKind === "plugin:github" && ctx.originId) {
      const parsed = parseGithubOriginId(ctx.originId);
      if (parsed) return { ...parsed, owned: false };
    }
    if (ctx.githubMirrorRef) {
      const parsed = parseGithubOriginId(ctx.githubMirrorRef);
      if (parsed) return { ...parsed, owned: true };
    }
    return null;
  }

  /** Create the mirror GitHub issue for a board-origin ticket (flow START
   *  only — live projection, no retro-creation on later events). Stores the
   *  ref via a null-guarded compare-and-set so a race never overwrites an
   *  existing ref. */
  async function createMirror(ctx: ProjectionContext): Promise<ProjectionTarget | null> {
    if (!ctx.projectionRepo) {
      logger.warn(
        { issueId: ctx.issueId, companyId: ctx.companyId },
        "github projection: enabled but no githubProjectionRepo configured — mirror not created (classified: projection_repo_missing)",
      );
      return null;
    }
    const title = ctx.identifier ? `${ctx.identifier}: ${ctx.title}` : ctx.title;
    const body =
      (ctx.description ? `${ctx.description.trim()}\n\n---\n\n` : "") +
      `Mirror of cockpit board ticket **${ctx.identifier ?? ctx.issueId}**. ` +
      `The board is the canonical execution store; this issue carries the ` +
      `conversation and decision-audit trail (live projection).\n\n` +
      apexIssueMarker(ctx.issueId);
    const created = await invoker.invoke(
      "github_repo",
      "create_issue",
      { repo: ctx.projectionRepo, title, body },
      githubWriteResultSchema,
    );
    if (created.status !== "success" || typeof created.number !== "number") {
      throw new ApexInvocationError(
        `create_issue on ${ctx.projectionRepo} reported status ${JSON.stringify(created.status)}`,
      );
    }
    const ref = `${ctx.projectionRepo}#${created.number}`;
    const stored = await db
      .update(issues)
      .set({ githubMirrorRef: ref, updatedAt: now() })
      .where(and(eq(issues.id, ctx.issueId), isNull(issues.githubMirrorRef)))
      .returning({ id: issues.id });
    if (stored.length === 0) {
      // Lost a create race — keep the winner's ref, log ours as orphaned.
      const fresh = await loadContext(ctx.issueId);
      logger.warn(
        { issueId: ctx.issueId, orphanedRef: ref, keptRef: fresh?.githubMirrorRef ?? null },
        "github projection: mirror ref store raced — created issue orphaned (classified: mirror_ref_race)",
      );
      return fresh ? resolveTarget(fresh) : null;
    }
    logger.info(
      { issueId: ctx.issueId, mirrorRef: ref, url: created.url ?? null },
      "github projection: mirror issue created",
    );
    return { repo: ctx.projectionRepo, number: created.number, owned: true };
  }

  async function comment(target: ProjectionTarget, body: string): Promise<void> {
    const result = await invoker.invoke(
      "github_repo",
      "comment_issue",
      { repo: target.repo, number: target.number, body },
      githubWriteResultSchema,
    );
    if (result.status !== "success") {
      throw new ApexInvocationError(
        `comment_issue on ${target.repo}#${target.number} reported status ${JSON.stringify(result.status)}`,
      );
    }
  }

  /** Shared guard: enablement check, target resolution, failure isolation.
   *  `handler` receives a resolved target; every error path is a classified
   *  log line — this function NEVER rejects. */
  async function project(
    event: string,
    issueId: string,
    handler: (ctx: ProjectionContext, target: ProjectionTarget) => Promise<void>,
    resolve: (ctx: ProjectionContext) => Promise<ProjectionTarget | null> = async (ctx) =>
      resolveTarget(ctx),
  ): Promise<void> {
    try {
      const ctx = await loadContext(issueId);
      if (!ctx || !ctx.projectionEnabled) return;
      const target = await resolve(ctx);
      if (!target) {
        logger.warn(
          { issueId, event },
          "github projection: no mirror target for event — dropped (classified: projection_target_missing)",
        );
        return;
      }
      await handler(ctx, target);
    } catch (err) {
      logger.warn(
        { err, issueId, event, errorType: classifyProjectionError(err) },
        "github projection: event dropped, flow unaffected (fire-and-forget)",
      );
    }
  }

  return {
    flowStarted: (event) =>
      project(
        "flow_started",
        event.issueId,
        async (_ctx, target) => {
          await comment(
            target,
            `**Flow \`${event.flowName}\` started** on the cockpit board — lifecycle decisions ` +
              `(commissions, acceptance, gate approvals, completion) will be projected here.`,
          );
        },
        // Flow start is the ONE point that may create the mirror.
        async (ctx) => resolveTarget(ctx) ?? createMirror(ctx),
      ),

    agentRunCommissioned: (event) =>
      project("agent_run_commissioned", event.issueId, async (_ctx, target) => {
        // Permission stamping is best-effort on the run row (typed columns);
        // read it here so the coordinator doesn't have to thread it through.
        const run = await db
          .select({
            permissionMode: heartbeatRuns.permissionMode,
            permissionProfile: heartbeatRuns.permissionProfile,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, event.runId))
          .then((rows) => rows[0] ?? null);
        const permissionLine = run?.permissionProfile
          ? `\n- permission profile: \`${run.permissionProfile}\`${run.permissionMode ? ` (${run.permissionMode})` : ""}`
          : "";
        await comment(
          target,
          `**Agent run commissioned** at node \`${event.nodeId}\`\n- run: \`${event.runId}\`` +
            permissionLine,
        );
      }),

    acceptanceEvaluated: (event) =>
      project("acceptance_evaluated", event.issueId, async (_ctx, target) => {
        await comment(
          target,
          `**Acceptance ${event.ok ? "passed" : "FAILED"}** at node \`${event.nodeId}\` ` +
            `(run \`${event.runId}\`)\n- evaluation: ${event.evaluation}`,
        );
      }),

    gateOpened: (event) =>
      project("gate_opened", event.issueId, async (_ctx, target) => {
        await comment(
          target,
          `**Gate opened** at node \`${event.nodeId}\` — awaiting human decision.` +
            (event.prompt ? `\n> ${event.prompt}` : ""),
        );
      }),

    gateDecided: (event) =>
      project("gate_decided", event.issueId, async (_ctx, target) => {
        await comment(
          target,
          `**Gate \`${event.nodeId}\` ${event.decision === "approve" ? "approved" : "rejected"}**` +
            `\n- by: ${event.decidedByUserId}\n- at: ${now().toISOString()}`,
        );
      }),

    flowCompleted: (event) =>
      project("flow_completed", event.issueId, async (ctx, target) => {
        const prUrl = extractPullRequestUrl(event.acceptanceEvaluation);
        await comment(
          target,
          `**Flow completed** (final node \`${event.completedNodeId ?? "?"}\`).` +
            (prUrl ? `\n- pull request: ${prUrl}` : ""),
        );
        // Close ONLY mirrors we created — never an ingested origin issue
        // (the ingest/reflect pipeline owns that lifecycle).
        if (target.owned) {
          const closed = await invoker.invoke(
            "github_repo",
            "close_issue",
            { repo: target.repo, number: target.number, state_reason: "completed" },
            githubWriteResultSchema,
          );
          if (closed.status !== "success") {
            throw new ApexInvocationError(
              `close_issue on ${target.repo}#${target.number} reported status ${JSON.stringify(closed.status)}`,
            );
          }
        }
      }),

    flowFailed: (event) =>
      project("flow_failed", event.issueId, async (_ctx, target) => {
        await comment(
          target,
          `**Flow FAILED** at node \`${event.nodeId ?? "?"}\`\n- [${event.errorType}] ${event.message}`,
        );
      }),
  };
}
