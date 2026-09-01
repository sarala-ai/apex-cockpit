import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  FLOW_MACHINE_GROUP_KIND,
  groupFlowMachineCorrespondence,
  isAgentStatusTransition,
  isFlowMachineCorrespondence,
  isFlowSystemNotice,
} from "./flow-machine-correspondence";

function systemNotice(id: string, text: string): ThreadMessage {
  return {
    id,
    role: "system",
    createdAt: new Date("2026-08-01T07:00:00.000Z"),
    content: [{ type: "text", text }],
    metadata: { custom: { kind: "system_notice", anchorId: `comment-${id}` } },
  } as ThreadMessage;
}

function statusEvent(id: string, actorType: string): ThreadMessage {
  return {
    id,
    role: "system",
    createdAt: new Date("2026-08-01T07:00:00.000Z"),
    content: [{ type: "text", text: "Status: in_progress -> done" }],
    metadata: {
      custom: {
        kind: "event",
        anchorId: `activity-${id}`,
        actorType,
        statusChange: { from: "in_progress", to: "done" },
      },
    },
  } as ThreadMessage;
}

function humanComment(id: string, text: string): ThreadMessage {
  return {
    id,
    role: "user",
    createdAt: new Date("2026-08-01T07:00:00.000Z"),
    content: [{ type: "text", text }],
    metadata: { custom: { kind: "comment", anchorId: `comment-${id}` } },
  } as unknown as ThreadMessage;
}

/** The real instruction comment agent-step.ts posts — the wall of machine
 *  correspondence the founder called "agent slop". */
const INSTRUCTION_COMMENT = systemNotice(
  "c-instruction",
  "Flow **design-change** agent step `board_diff` — bounded agent run commissioned.\n\nInstruction:\nAuthor the design-board change…\n\nAcceptance: pr_exists:sarala-ai/apex-design#design/APE-5",
);
const PAUSE_NOTICE = systemNotice(
  "c-pause",
  "Flow **design-change** paused at node `board_diff` — [agent_acceptance_failed] acceptance pull request not found",
);

describe("flow machine-correspondence identification", () => {
  it("recognises every coordinator-authored system comment by its `Flow **name**` prefix", () => {
    expect(isFlowSystemNotice(INSTRUCTION_COMMENT)).toBe(true);
    expect(isFlowSystemNotice(PAUSE_NOTICE)).toBe(true);
    expect(
      isFlowSystemNotice(
        systemNotice("c-gate", "Flow **design-change** gate `design_gate` was **rejected** — flow paused."),
      ),
    ).toBe(true);
  });

  it("leaves unrelated system notices and human comments alone", () => {
    expect(isFlowSystemNotice(systemNotice("c-other", "Run finished without a clear next step."))).toBe(false);
    expect(isFlowMachineCorrespondence(humanComment("c-human", "Looks good, merging."))).toBe(false);
  });

  it("treats only agent-driven pure status transitions as absorbable", () => {
    expect(isAgentStatusTransition(statusEvent("e-agent", "agent"))).toBe(true);
    expect(isAgentStatusTransition(statusEvent("e-user", "user"))).toBe(false);
  });
});

describe("groupFlowMachineCorrespondence", () => {
  it("collapses a contiguous run into one group message and preserves order", () => {
    const grouped = groupFlowMachineCorrespondence([
      humanComment("c-1", "Please make this change."),
      statusEvent("e-1", "agent"),
      PAUSE_NOTICE,
      INSTRUCTION_COMMENT,
      humanComment("c-2", "Thanks."),
    ]);

    expect(grouped).toHaveLength(3);
    expect(grouped[0].id).toBe("c-1");
    expect(grouped[2].id).toBe("c-2");

    const custom = grouped[1].metadata.custom as Record<string, unknown>;
    expect(custom.kind).toBe(FLOW_MACHINE_GROUP_KIND);
    expect(custom.count).toBe(3);
    expect((custom.messages as ThreadMessage[]).map((m) => m.id)).toEqual([
      "e-1",
      "c-pause",
      "c-instruction",
    ]);
  });

  it("keeps a status change that stands alone visible (it is history, not machine chatter)", () => {
    const messages = [humanComment("c-1", "hi"), statusEvent("e-1", "agent"), humanComment("c-2", "bye")];
    expect(groupFlowMachineCorrespondence(messages).map((m) => m.id)).toEqual(["c-1", "e-1", "c-2"]);
  });

  it("returns a flow-free thread completely untouched", () => {
    const messages = [humanComment("c-1", "hi"), humanComment("c-2", "bye")];
    expect(groupFlowMachineCorrespondence(messages)).toEqual(messages);
  });

  it("groups multiple separate runs independently", () => {
    const grouped = groupFlowMachineCorrespondence([
      INSTRUCTION_COMMENT,
      humanComment("c-1", "working on it"),
      PAUSE_NOTICE,
    ]);
    expect(grouped).toHaveLength(3);
    expect((grouped[0].metadata.custom as Record<string, unknown>).kind).toBe(FLOW_MACHINE_GROUP_KIND);
    expect(grouped[1].id).toBe("c-1");
    expect((grouped[2].metadata.custom as Record<string, unknown>).kind).toBe(FLOW_MACHINE_GROUP_KIND);
  });

  it("never drops a message — every input is reachable from the output", () => {
    const input = [INSTRUCTION_COMMENT, statusEvent("e-1", "agent"), humanComment("c-1", "hi")];
    const flattened = groupFlowMachineCorrespondence(input).flatMap((message) => {
      const custom = message.metadata.custom as Record<string, unknown>;
      return custom.kind === FLOW_MACHINE_GROUP_KIND ? (custom.messages as ThreadMessage[]) : [message];
    });
    expect(flattened.map((m) => m.id)).toEqual(input.map((m) => m.id));
  });
});
