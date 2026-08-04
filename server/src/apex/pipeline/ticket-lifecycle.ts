/**
 * THE FRONT DOOR — how a ticket enters a lifecycle.
 *
 * Three lifecycle pipelines are seeded per company (`bug`, `design-change`,
 * `feature`; see ./lifecycles.ts) and until this module existed none of them
 * had an entrance. The seeder wrote the processes, `pipelines.ticket_type`
 * recorded which kind of work each one is for, and nothing anywhere turned a
 * ticket into a case on one. Three definitions, zero cases, and a board on
 * which no ticket could travel a process it was designed for.
 *
 * ── TYPE MAPS TO PROCESS BY LOOKUP, NOT BY TABLE ──
 *
 * A ticket enters the pipeline whose `ticketType` equals its own. There is no
 * switch, no map literal, no `if (type === "bug")` anywhere in this file. That
 * is deliberate and it is the whole shape of the thing: a lifecycle is DATA
 * (`server/src/apex/pipeline/lifecycles.ts` seeds rows, an operator can author
 * more), so the code that routes to one must be a query. Adding a lifecycle is
 * seeding a pipeline that declares its ticket type; nothing here changes.
 *
 * The consequence worth stating: a company whose pipelines have not been
 * seeded, or whose `bug` pipeline an operator archived, gets `no_process` for
 * a bug ticket. That is reported, not repaired — this module never seeds and
 * never guesses.
 *
 * ── CHORE HAS NO PROCESS, AND SAYS SO ──
 *
 * `chore` is a legal ticket type that matches no pipeline, verified rather
 * than assumed (the reasoning is on LIFECYCLE_DEFINITIONS in ./lifecycles.ts):
 * a sequence with no agent step and no gate has no non-determinism to govern
 * and nothing to hold for a human, so a case, a lease and a version buy it
 * nothing. This module short-circuits on it BEFORE querying, and returns a
 * distinct reason (`type_has_no_process`) from the reason a bug ticket gets
 * when its pipeline is missing (`no_pipeline_seeded`). Collapsing those two
 * into one "no case was created" would let a real seeding failure hide behind
 * a deliberate design decision, on the same code path, forever.
 *
 * ── WHY THE ISSUE IS LINKED RATHER THAN COPIED ──
 *
 * The case carries the runtime state (current stage, version, terminal); the
 * issue stays the thing a person reads, comments on and assigns. They are
 * joined by a `pipeline_case_issue_links` row with role `work`, which is the
 * existing vocabulary for "this issue is where the work happens" — the same
 * role a stage automation's execution issue takes, and the same role
 * `services/flow-cases.ts` uses for a flow case. No new role is invented, so
 * every reader that already resolves a case's work issue resolves this one.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pipelineCaseIssueLinks, pipelineStages, pipelines } from "@paperclipai/db";
import {
  TICKET_TYPES,
  TICKET_TYPES_WITHOUT_PROCESS,
  isTicketType,
  type TicketType,
} from "@paperclipai/shared";
import { pipelineService, type PipelineActor } from "../../services/pipelines.js";
import {
  DEFAULT_PERMISSION_PROFILE,
  PERMISSION_PROFILES,
  permissionProfileWritesRepositories,
  type PermissionProfile,
} from "../steps/run-policy.js";
import { apexAgentPermissionProfile } from "../../services/apex-agent-roster.js";

type LifecycleDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The link role a lifecycle case takes on its ticket. Same constant meaning
 *  as `FLOW_CASE_LINK_ROLE` in services/flow-cases.ts — one vocabulary. */
export const TICKET_LIFECYCLE_LINK_ROLE = "work";

export type TicketLifecycleStart =
  | {
      status: "started";
      ticketType: TicketType;
      pipelineId: string;
      pipelineKey: string;
      caseId: string;
      stageKey: string | null;
      created: boolean;
    }
  | {
      status: "no_process";
      ticketType: TicketType;
      /** `type_has_no_process`: by design (chore). `no_pipeline_seeded`: this
       *  company has no live pipeline for the type — a gap, not a decision. */
      reason: "type_has_no_process" | "no_pipeline_seeded";
    }
  | { status: "not_typed" };

/**
 * The live pipeline a ticket type runs on, or null.
 *
 * Archived pipelines are excluded: an archived process is one an operator
 * retired, and starting new cases on it would quietly resurrect it.
 */
export async function resolveLifecyclePipelineForTicketType(
  db: LifecycleDb,
  input: { companyId: string; ticketType: string },
): Promise<typeof pipelines.$inferSelect | null> {
  if (TICKET_TYPES_WITHOUT_PROCESS.includes(input.ticketType as TicketType)) return null;
  const rows = await db
    .select()
    .from(pipelines)
    .where(
      and(
        eq(pipelines.companyId, input.companyId),
        eq(pipelines.ticketType, input.ticketType),
        isNull(pipelines.archivedAt),
      ),
    )
    .orderBy(asc(pipelines.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Put a typed ticket onto its process.
 *
 * Idempotent through `ingestCase`'s own `caseKey` conflict handling: the key
 * is derived from the issue id, so a retried create finds the existing case
 * rather than opening a second one. `created: false` in the result is that
 * path, and it is a success, not a conflict.
 */
export async function startTicketLifecycle(
  db: Db,
  input: {
    companyId: string;
    issue: {
      id: string;
      identifier: string | null;
      title: string;
      description: string | null;
      ticketType: string | null;
    };
    actor: PipelineActor;
  },
): Promise<TicketLifecycleStart> {
  const ticketType = input.issue.ticketType;
  if (!ticketType || !isTicketType(ticketType)) return { status: "not_typed" };
  if (TICKET_TYPES_WITHOUT_PROCESS.includes(ticketType)) {
    return { status: "no_process", ticketType, reason: "type_has_no_process" };
  }

  const pipeline = await resolveLifecyclePipelineForTicketType(db, {
    companyId: input.companyId,
    ticketType,
  });
  if (!pipeline) {
    return { status: "no_process", ticketType, reason: "no_pipeline_seeded" };
  }

  const result = await pipelineService(db).ingestCase({
    companyId: input.companyId,
    pipelineId: pipeline.id,
    // Derived from the issue, not random: this is what makes a retried create
    // find its own case instead of opening a duplicate process for one ticket.
    caseKey: `ticket:${input.issue.id}`,
    title: input.issue.title,
    summary: input.issue.description ?? null,
    fields: {
      issueId: input.issue.id,
      ...(input.issue.identifier ? { issueIdentifier: input.issue.identifier } : {}),
      ticketType,
    },
    // Linked INSIDE the ingest transaction, not after it. An `agent` step
    // resolves who to commission the run against through the case's issue
    // links, and `ingestCase` executes the first stage's automation the
    // instant that transaction commits — so a link written afterwards is
    // exactly one step too late, and design-change (whose FIRST stage is an
    // agent step) would fail with `agent_step_has_no_conversation` on a
    // ticket that has a perfectly good conversation. See `linkIssue` in
    // services/pipelines.ts.
    linkIssue: { issueId: input.issue.id, role: TICKET_LIFECYCLE_LINK_ROLE },
    actor: input.actor,
  });

  // The link again, for the idempotent path. `ingestCase` only writes it when
  // it INSERTS a case; a retried create that finds the existing one skips the
  // insert entirely, and a case that somehow lost its link would otherwise
  // stay unlinked forever. `onConflictDoNothing` makes the common case free.
  await db
    .insert(pipelineCaseIssueLinks)
    .values({
      companyId: input.companyId,
      caseId: result.case.id,
      issueId: input.issue.id,
      role: TICKET_LIFECYCLE_LINK_ROLE,
    })
    .onConflictDoNothing({ target: [pipelineCaseIssueLinks.caseId, pipelineCaseIssueLinks.issueId] });

  return {
    status: "started",
    ticketType,
    pipelineId: pipeline.id,
    pipelineKey: pipeline.key,
    caseId: result.case.id,
    stageKey: result.case.stepKey ?? null,
    created: result.created,
  };
}

// ---------------------------------------------------------------------------
// What the composer needs to know BEFORE the ticket exists.
// ---------------------------------------------------------------------------

function readStagePermissionProfile(config: unknown): PermissionProfile | null {
  if (!config || typeof config !== "object") return null;
  const onEnter = (config as Record<string, unknown>).onEnter;
  if (!onEnter || typeof onEnter !== "object") return null;
  const entry = onEnter as Record<string, unknown>;
  if (entry.type !== "agent") return null;

  // The stage's OWN declared profile first — that is what `derivePermissionPolicy`
  // actually applies at commission time, so it is what the answer must be
  // derived from. The roster is only the fallback for a stage that names an
  // agent without restating its profile.
  const declared = (entry.permissions as Record<string, unknown> | undefined)?.profile;
  if (typeof declared === "string" && (PERMISSION_PROFILES as readonly string[]).includes(declared)) {
    return declared as PermissionProfile;
  }
  const agentKey = entry.agentKey;
  if (typeof agentKey === "string") {
    try {
      return apexAgentPermissionProfile(agentKey);
    } catch {
      // A stage naming an agent outside the roster. Unknowable here, and
      // `derivePermissionPolicy` will fall back to its own default — so report
      // that default rather than pretending the step commissions nobody.
      return DEFAULT_PERMISSION_PROFILE;
    }
  }
  // An agent step that names no agent at all resolves its executor at
  // commission time under the default profile. Same reasoning as above.
  return DEFAULT_PERMISSION_PROFILE;
}

export type TicketTypeOption = {
  ticketType: TicketType;
  /** The live pipeline for this type, or null when the type has none. */
  pipelineId: string | null;
  pipelineKey: string | null;
  pipelineName: string | null;
  /** `true` only for types that have no process BY DESIGN (chore) — as opposed
   *  to a type whose pipeline is simply missing from this company. */
  processlessByDesign: boolean;
  /** Whether starting this type commissions an agent that can change a
   *  repository, and therefore whether a ticket of this type needs a codebase
   *  bound before it is dispatched. */
  commissionsRepoWritingAgent: boolean;
};

/**
 * The four ticket types as this company can actually use them.
 *
 * COMPUTED, never authored. `commissionsRepoWritingAgent` is read off the
 * seeded stages' permission profiles, so a lifecycle that stops writing repos
 * stops demanding a codebase without anybody remembering to update a list —
 * and a type whose pipeline was never seeded reports `pipelineId: null`
 * honestly instead of promising a process that does not exist here.
 */
export async function listTicketTypeOptions(
  db: LifecycleDb,
  companyId: string,
): Promise<TicketTypeOption[]> {
  const livePipelines = await db
    .select({
      id: pipelines.id,
      key: pipelines.key,
      name: pipelines.name,
      ticketType: pipelines.ticketType,
    })
    .from(pipelines)
    .where(and(eq(pipelines.companyId, companyId), isNull(pipelines.archivedAt)))
    .orderBy(asc(pipelines.createdAt));

  const pipelineIds = livePipelines.map((pipeline) => pipeline.id);
  const stages = pipelineIds.length
    ? await db
      .select({ pipelineId: pipelineStages.pipelineId, config: pipelineStages.config })
      .from(pipelineStages)
      .where(inArray(pipelineStages.pipelineId, pipelineIds))
    : [];

  return buildTicketTypeOptions({ pipelines: livePipelines, stages });
}

/**
 * The shaping half of `listTicketTypeOptions`, with the database taken out.
 *
 * Separated so the rule — which is the part that can be wrong — is testable
 * without a Postgres. The query above has no branches; every decision worth
 * pinning is here.
 */
export function buildTicketTypeOptions(input: {
  pipelines: ReadonlyArray<{ id: string; key: string; name: string; ticketType: string | null }>;
  stages: ReadonlyArray<{ pipelineId: string; config: unknown }>;
}): TicketTypeOption[] {
  const byTicketType = new Map<string, (typeof input.pipelines)[number]>();
  for (const pipeline of input.pipelines) {
    if (!pipeline.ticketType) continue;
    // First wins: the query orders by creation, so a company that somehow has
    // two live pipelines for one type keeps using the one it already used.
    if (!byTicketType.has(pipeline.ticketType)) byTicketType.set(pipeline.ticketType, pipeline);
  }

  const writesReposByPipelineId = new Map<string, boolean>();
  for (const stage of input.stages) {
    const profile = readStagePermissionProfile(stage.config);
    if (!profile) continue;
    if (permissionProfileWritesRepositories(profile)) {
      writesReposByPipelineId.set(stage.pipelineId, true);
    } else if (!writesReposByPipelineId.has(stage.pipelineId)) {
      writesReposByPipelineId.set(stage.pipelineId, false);
    }
  }

  return TICKET_TYPES.map((ticketType) => {
    const pipeline = byTicketType.get(ticketType) ?? null;
    return {
      ticketType,
      pipelineId: pipeline?.id ?? null,
      pipelineKey: pipeline?.key ?? null,
      pipelineName: pipeline?.name ?? null,
      processlessByDesign: TICKET_TYPES_WITHOUT_PROCESS.includes(ticketType),
      commissionsRepoWritingAgent: pipeline
        ? writesReposByPipelineId.get(pipeline.id) === true
        : false,
    };
  });
}
