/**
 * Demote flow MACHINE CORRESPONDENCE in the issue reading view.
 *
 * Why (founder critique): a flow-gated ticket today reads as "agent slop" —
 * the thread is dominated by machine correspondence the coordinator writes for
 * the audit trail (bounded-agent instruction comments with the whole rendered
 * prompt + raw `pr_exists:owner/repo#branch` acceptance string, pause/reject
 * notices, and the agent's own status flapping) — and the reviewer says "I
 * don't know what to interpret, where to start and where to end."
 *
 * Nothing is deleted and nothing stops being written: these comments and
 * activity rows ARE the audit trail, and the Activity tab still shows every
 * one of them verbatim. This module only groups contiguous machine
 * correspondence in the *reading* view into one collapsed
 * "Flow activity (N)" affordance, so human conversation and the decision
 * brief are what a reader lands on first.
 *
 * Identification is by the markers the producers already write — no new
 * field, no schema change:
 *  - system-authored comments whose body opens with the coordinator's
 *    `Flow **<name>** …` prefix. Every flow-authored issue comment uses it:
 *    the instruction/wake comment (agent-step.ts
 *    `buildAgentInstructionComment`) and every coordinator `surface()` body
 *    (paused / failed / notify-gate / deferred-wakeup / gate-rejected /
 *    abandoned).
 *  - agent-actor status-transition timeline events, but ONLY where they are
 *    contiguous with such a comment. A status change a human made, or one
 *    standing on its own, stays visible — this collapses the machine's
 *    conversation with itself, not the ticket's history.
 *
 * A group is only formed when the run contains at least one flow comment, so
 * a thread with no flow involvement is returned completely untouched.
 */
import type { ThreadMessage } from "@assistant-ui/react";

/** The coordinator's issue-comment prefix — `Flow **<flow name>** …`. */
export const FLOW_SYSTEM_COMMENT_RE = /^\s*Flow\s+\*\*[^*]+\*\*/;

export const FLOW_MACHINE_GROUP_KIND = "flow_machine_group";

function customOf(message: ThreadMessage): Record<string, unknown> {
  const custom = (message.metadata as { custom?: unknown } | undefined)?.custom;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return {};
  return custom as Record<string, unknown>;
}

function bodyTextOf(message: ThreadMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

/** A system-authored comment the flow coordinator wrote (instruction/wake
 *  fence, pause, gate rejection, abandonment …). */
export function isFlowSystemNotice(message: ThreadMessage): boolean {
  const custom = customOf(message);
  if (custom.kind !== "system_notice") return false;
  return FLOW_SYSTEM_COMMENT_RE.test(bodyTextOf(message));
}

/** An agent-driven status transition — noise only next to flow machine
 *  correspondence, which is why absorption is contiguity-gated below. */
export function isAgentStatusTransition(message: ThreadMessage): boolean {
  const custom = customOf(message);
  if (custom.kind !== "event") return false;
  if (custom.actorType !== "agent") return false;
  if (custom.followUpRequested === true) return false;
  if (custom.assigneeChange || custom.workspaceChange) return false;
  return !!custom.statusChange;
}

/** Anything eligible to be absorbed into a flow-activity group. */
export function isFlowMachineCorrespondence(message: ThreadMessage): boolean {
  return isFlowSystemNotice(message) || isAgentStatusTransition(message);
}

export type FlowMachineGroupCustom = {
  kind: typeof FLOW_MACHINE_GROUP_KIND;
  anchorId: string;
  count: number;
  messages: ThreadMessage[];
};

function makeGroupMessage(members: ThreadMessage[]): ThreadMessage {
  const first = members[0] as ThreadMessage;
  const last = members[members.length - 1] as ThreadMessage;
  const custom: FlowMachineGroupCustom = {
    kind: FLOW_MACHINE_GROUP_KIND,
    anchorId: `flow-activity-${first.id}`,
    count: members.length,
    messages: members,
  };
  return {
    id: `flow-activity:${first.id}`,
    role: "system",
    createdAt: last.createdAt ?? first.createdAt,
    content: [{ type: "text", text: `Flow activity (${members.length})` }],
    metadata: { custom },
  } as ThreadMessage;
}

/**
 * Replace each contiguous run of flow machine correspondence with one
 * collapsed group message. Order is otherwise preserved exactly, and a run
 * containing no flow-authored comment is left alone.
 */
export function groupFlowMachineCorrespondence(
  messages: readonly ThreadMessage[],
): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  let run: ThreadMessage[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    if (run.some(isFlowSystemNotice)) {
      out.push(makeGroupMessage(run));
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const message of messages) {
    if (isFlowMachineCorrespondence(message)) {
      run.push(message);
      continue;
    }
    flushRun();
    out.push(message);
  }
  flushRun();
  return out;
}
