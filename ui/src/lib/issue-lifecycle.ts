/**
 * Which process a ticket is on, chosen from the cases linked to it.
 *
 * A ticket can be linked to several cases in several roles: `work` is the case
 * that IS this ticket's work, `conversation`/`origin`/`automation` are cases
 * that merely mention it or spawned it. Only the `work` link answers "where is
 * this ticket in its lifecycle" — the others would report a ticket as sitting
 * in a process it is only a bystander to.
 *
 * The server already drops retired links and orders newest first, so the live
 * case is simply the first `work` link that has not reached a terminal stage;
 * if every one has, the newest terminal case is still the honest answer
 * ("finished the Feature process") and is returned rather than nothing.
 */
import type { Issue, IssueLinkedCase } from "@paperclipai/shared";

export function selectIssueLifecycleCase(
  issue: Pick<Issue, "linkedCases"> | null | undefined,
): IssueLinkedCase | null {
  const workCases = (issue?.linkedCases ?? []).filter((row) => row.role === "work");
  return workCases.find((row) => row.terminalKind === null) ?? workCases[0] ?? null;
}

/**
 * What the strip says about a case that is not waiting on anyone.
 *
 * Deliberately a sentence rather than a status chip: a person who has never
 * opened the pipelines page still has to understand it, and "Feature · Spec"
 * only reads as a location once you already know the vocabulary.
 */
export function describeIssueLifecyclePosition(row: IssueLinkedCase): {
  prefix: string;
  stageName: string;
  suffix: string;
} {
  if (row.terminalKind === "cancelled") {
    return { prefix: `Stopped on the ${row.pipeline.name} process, at `, stageName: row.stage.name, suffix: "." };
  }
  if (row.terminalKind !== null) {
    return { prefix: `Finished the ${row.pipeline.name} process, at `, stageName: row.stage.name, suffix: "." };
  }
  return { prefix: `On the ${row.pipeline.name} process, now at `, stageName: row.stage.name, suffix: "." };
}

/** Deep link to where this case is worked and decided. */
export function issueLifecycleCaseHref(row: IssueLinkedCase): string {
  return `/pipelines/${row.pipeline.id}/items/${row.id}`;
}

/**
 * How an unowned ticket describes itself.
 *
 * "Unassigned" is literally true whenever nobody owns a ticket, and a process
 * leaves that vacuum wherever it is not running an agent — at a human gate
 * above all, which is exactly where a person is most likely to be reading.
 * (Where a process DOES commission an agent it fills the vacuum, so the ticket
 * shows a real owner and this wording never appears.)
 *
 * But in a board-shaped tool "Unassigned" carries a second meaning: nothing is
 * happening here, pick it up. That half is false while a process is moving the
 * ticket, and it is the half this rewording removes.
 *
 * The fix is the wording, never the data. Assignment is a DISPATCH trigger —
 * writing it wakes that agent and gates who may hold the ticket's execution
 * lock — so inventing an assignee to make the panel look tidy would start real
 * work, not merely mislabel it.
 */
export function describeUnassigned(row: IssueLinkedCase | null): { label: string; title?: string } {
  if (!row || row.terminalKind !== null) return { label: "Unassigned" };
  return {
    label: "Nobody yet",
    title: `Nobody owns this ticket. The ${row.pipeline.name} process is moving it, and commissions its own agents.`,
  };
}

/**
 * Who is being waited on, in words. Resolving a named approver needs a member
 * lookup the strip does not own, so the caller passes one; without it the
 * sentence still says something true rather than guessing.
 */
export function describeGateApprover(
  config: Record<string, unknown> | null | undefined,
  resolveUserLabel?: (userId: string) => string | null,
): string {
  const approver = config?.approver;
  if (!approver || typeof approver !== "object" || Array.isArray(approver)) {
    return "Anyone on the board can decide this.";
  }
  const record = approver as Record<string, unknown>;
  if (record.kind === "user" && typeof record.userId === "string") {
    const label = resolveUserLabel?.(record.userId);
    return label ? `${label} is the approver.` : "One named person is the approver.";
  }
  if (record.kind === "agent") {
    return "An agent approves this one.";
  }
  return "Anyone on the board can decide this.";
}
