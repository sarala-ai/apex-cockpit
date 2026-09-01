/**
 * THE FRIENDLY GUARD — told at the point of choosing, not nine minutes into a
 * failed run.
 *
 * The server already refuses to dispatch an agent that has no codebase
 * (`assertRunDispatchPreconditions`, server/src/services/heartbeat.ts). That
 * refusal is correct and stays: it is the last line, it covers every entry
 * point including the API, and nothing here replaces it. But it fires at
 * LAUNCH, after the ticket is filed, assigned, and picked up — a real run
 * spent ten minutes RUNNING before the board said anything. The person who
 * could have fixed it in two seconds learned about it last.
 *
 * So this module answers the same question one step earlier, in the composer,
 * while the author still has the project picker open.
 *
 * ── THE TRIGGER IS THE COMMISSION, NOT THE EMPTY FIELD ──
 *
 * "Project is blank" is the wrong thing to warn about, and warning about it is
 * how a product teaches people to dismiss warnings. A question, a note to
 * self, a chore, a ticket assigned to a person — all legitimately have no
 * project, and a nag on every one of them would be noise that hides the one
 * case that matters. Project is therefore NOT made required.
 *
 * What is asked instead is: WILL THIS TICKET COMMISSION SOMETHING THAT NEEDS A
 * CHECKOUT? Two independent ways that becomes true before the ticket exists,
 * and both are read from data rather than assumed:
 *
 *   1. THE ASSIGNEE. The chosen agent's own permission grant says whether it
 *      can change files (`agentWritesRepositories`, packages/shared). An agent
 *      that can only read — the Specifier, the Product Assistant — makes no
 *      such demand and gets no warning.
 *   2. THE TYPE. The chosen ticket type's lifecycle may contain an agent step
 *      that writes repos even when no assignee is picked at all. The server
 *      computes that per type from the seeded stages' permission profiles and
 *      serves it (`GET /companies/:id/ticket-types`), so this file never
 *      hardcodes which lifecycles need code.
 *
 * ── WHY STATUS DECIDES BLOCK vs WARN ──
 *
 * The board already draws this line and the composer already shows it: an
 * assigned ticket left in `Backlog` is explicitly parked, and its assignee is
 * not woken. Blocking creation of a parked ticket would refuse a perfectly
 * reasonable act — file it now, bind the repo before starting it. Blocking an
 * EXECUTABLE ticket (`Todo` / `In Progress`) is refusing a dispatch that is
 * about to happen, which is precisely what the server would do a minute later
 * and less pleasantly. Same rule the missing-secrets banner uses
 * (`shouldWarnAboutRunUserSecrets`), for the same reason.
 */

import { agentWritesRepositories } from "@paperclipai/shared";

export type TicketTypeOption = {
  ticketType: string;
  pipelineId: string | null;
  pipelineKey: string | null;
  pipelineName: string | null;
  processlessByDesign: boolean;
  commissionsRepoWritingAgent: boolean;
};

export type CodebaseProjectCandidate = {
  id: string;
  name: string;
  repoUrl: string | null;
};

export type CodebasePreflight =
  /** Nothing about this ticket asks for code. No message at all. */
  | { kind: "not_needed" }
  /** Something will need code, and a repository is bound. */
  | {
      kind: "satisfied";
      projectId: string;
      projectName: string;
      repoUrl: string;
      /** True when the composer chose this project rather than the author.
       *  A default that is not shown is a silent default, which is the same
       *  defect in a nicer costume. */
      defaulted: boolean;
      message: string;
    }
  /** Something will need code and nothing is bound. */
  | {
      kind: "missing";
      /** Executable now — refuse creation. Parked — warn only. */
      blocking: boolean;
      /** Who is going to want the code. */
      demandedBy: "assignee" | "lifecycle";
      message: string;
    };

/** Whether a status means "the assignee will be woken". Mirrors the wording
 *  the status picker itself shows ("Executable" vs "Parked"). */
export function isExecutableIssueStatus(status: string): boolean {
  return status === "todo" || status === "in_progress";
}

/** Projects with a repository actually bound — the only ones that satisfy the
 *  demand. A project row alone is not a codebase; that is the exact confusion
 *  the dispatch precondition had to be taught, and it is not repeated here. */
export function projectsWithRepository(
  projects: readonly CodebaseProjectCandidate[],
): CodebaseProjectCandidate[] {
  return projects.filter((project) => Boolean(project.repoUrl && project.repoUrl.trim().length > 0));
}

/**
 * The project to preselect, or null.
 *
 * ONE candidate only. With exactly one project carrying a repository there is
 * nothing to get wrong and picking it saves the author a step; with two there
 * is a real choice and guessing it would be the product deciding where an
 * agent writes code. The caller must SHOW the result — see `defaulted`.
 */
export function defaultCodebaseProjectId(
  projects: readonly CodebaseProjectCandidate[],
): string | null {
  const candidates = projectsWithRepository(projects);
  return candidates.length === 1 ? candidates[0]!.id : null;
}

export function evaluateCodebasePreflight(input: {
  status: string;
  assignee: { name: string; adapterType: string; adapterConfig?: Record<string, unknown> | null } | null;
  ticketTypeOption: TicketTypeOption | null;
  selectedProject: CodebaseProjectCandidate | null;
  /** True when `selectedProject` was chosen by `defaultCodebaseProjectId`
   *  rather than by the author. */
  selectedProjectWasDefaulted: boolean;
}): CodebasePreflight {
  const assigneeWrites = input.assignee ? agentWritesRepositories(input.assignee) : false;
  const lifecycleWrites = input.ticketTypeOption?.commissionsRepoWritingAgent === true;
  if (!assigneeWrites && !lifecycleWrites) return { kind: "not_needed" };

  const repoUrl = input.selectedProject?.repoUrl?.trim();
  if (input.selectedProject && repoUrl) {
    return {
      kind: "satisfied",
      projectId: input.selectedProject.id,
      projectName: input.selectedProject.name,
      repoUrl,
      defaulted: input.selectedProjectWasDefaulted,
      message: input.selectedProjectWasDefaulted
        ? `Codebase: ${input.selectedProject.name} (${repoUrl}) — the only project with a repository bound. Change it above if that is wrong.`
        : `Codebase: ${input.selectedProject.name} (${repoUrl}).`,
    };
  }

  const demandedBy = assigneeWrites ? "assignee" : "lifecycle";
  const who = assigneeWrites && input.assignee
    ? input.assignee.name
    : `The ${input.ticketTypeOption?.pipelineName ?? input.ticketTypeOption?.ticketType ?? "lifecycle"} process`;
  const blocking = isExecutableIssueStatus(input.status);

  // Present tense, and it names the fix first — same shape as the dispatch
  // refusal this pre-empts, which opens "assign this task to a project with a
  // repository, or set a repo on the project".
  const fix = "Pick a project with a repository, or bind a repo to the project you want.";
  const consequence = assigneeWrites
    ? `${who} would start in an empty directory with none of the code it was asked to change.`
    : `${who} commissions an agent that writes code, and it would start with none of the code to change.`;

  return {
    kind: "missing",
    blocking,
    demandedBy,
    message: blocking
      ? `${who} needs a codebase and this task has none. ${fix} ${consequence}`
      : `${who} will need a codebase before this task runs. ${fix} It is parked in Backlog, so nothing is dispatched yet.`,
  };
}
