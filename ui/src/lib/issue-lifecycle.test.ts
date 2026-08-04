/**
 * Which case a ticket reports itself as being on.
 *
 * The failure this guards against is a ticket claiming to sit in a process it
 * is only a bystander to — linked as `conversation` or `automation` rather
 * than as the work itself.
 */
import { describe, expect, it } from "vitest";
import type { IssueLinkedCase } from "@paperclipai/shared";
import {
  describeGateApprover,
  describeUnassigned,
  describeIssueLifecyclePosition,
  issueLifecycleCaseHref,
  selectIssueLifecycleCase,
} from "./issue-lifecycle";

function linkedCase(overrides: Partial<IssueLinkedCase> = {}): IssueLinkedCase {
  return {
    id: "case-1",
    caseKey: "ticket:issue-1",
    title: "Render a ticket's type",
    status: "open",
    role: "work",
    version: 1,
    terminalKind: null,
    pipeline: { id: "pipeline-1", key: "feature", name: "Feature" },
    stage: { id: "stage-1", key: "promote", name: "Promote", kind: "review" },
    review: null,
    hold: null,
    ...overrides,
  };
}

describe("choosing the case a ticket is actually running on", () => {
  it("ignores cases the ticket is only a bystander to", () => {
    const selected = selectIssueLifecycleCase({
      linkedCases: [
        linkedCase({ id: "chat", role: "conversation" }),
        linkedCase({ id: "robot", role: "automation" }),
        linkedCase({ id: "mine", role: "work" }),
      ],
    });

    expect(selected?.id).toBe("mine");
  });

  it("prefers the live case over one that has already ended", () => {
    const selected = selectIssueLifecycleCase({
      linkedCases: [
        linkedCase({ id: "old", terminalKind: "done" }),
        linkedCase({ id: "live", terminalKind: null }),
      ],
    });

    expect(selected?.id).toBe("live");
  });

  it("still reports a finished process rather than falling silent", () => {
    const selected = selectIssueLifecycleCase({
      linkedCases: [linkedCase({ id: "old", terminalKind: "done" })],
    });

    expect(selected?.id).toBe("old");
  });

  it("says nothing for a ticket on no process at all", () => {
    expect(selectIssueLifecycleCase({ linkedCases: [] })).toBeNull();
    expect(selectIssueLifecycleCase(null)).toBeNull();
    expect(selectIssueLifecycleCase({ linkedCases: [linkedCase({ role: "conversation" })] })).toBeNull();
  });
});

describe("saying where a ticket has got to", () => {
  it("reads as a sentence, not as vocabulary a newcomer has to already know", () => {
    const live = describeIssueLifecyclePosition(
      linkedCase({ stage: { id: "s", key: "spec", name: "Spec", kind: "working" } }),
    );

    expect(`${live.prefix}${live.stageName}${live.suffix}`).toBe("On the Feature process, now at Spec.");
  });

  it("distinguishes finished from stopped", () => {
    const done = describeIssueLifecyclePosition(linkedCase({ terminalKind: "done" }));
    const cancelled = describeIssueLifecyclePosition(linkedCase({ terminalKind: "cancelled" }));

    expect(`${done.prefix}${done.stageName}${done.suffix}`).toBe("Finished the Feature process, at Promote.");
    expect(`${cancelled.prefix}${cancelled.stageName}${cancelled.suffix}`)
      .toBe("Stopped on the Feature process, at Promote.");
  });

  it("links the stage to the board where the case lives", () => {
    expect(issueLifecycleCaseHref(linkedCase())).toBe("/pipelines/pipeline-1/items/case-1");
  });
});

describe("saying who is being waited on", () => {
  it("says anyone can decide when the gate says any human", () => {
    expect(describeGateApprover({ approver: { kind: "any_human" } }))
      .toBe("Anyone on the board can decide this.");
  });

  it("names the approver when a name can be resolved, and stays truthful when it cannot", () => {
    const config = { approver: { kind: "user", userId: "u-1" } };

    expect(describeGateApprover(config, () => "Srinivas")).toBe("Srinivas is the approver.");
    expect(describeGateApprover(config, () => null)).toBe("One named person is the approver.");
    expect(describeGateApprover(config)).toBe("One named person is the approver.");
  });

  it("does not claim a person is waited on when an agent approves", () => {
    expect(describeGateApprover({ approver: { kind: "agent", agentId: "a-1" } }))
      .toBe("An agent approves this one.");
  });

  it("falls back to anyone rather than throwing on a config it cannot read", () => {
    expect(describeGateApprover(null)).toBe("Anyone on the board can decide this.");
    expect(describeGateApprover({})).toBe("Anyone on the board can decide this.");
    expect(describeGateApprover({ approver: "nobody" })).toBe("Anyone on the board can decide this.");
  });
});

describe("a ticket nobody owns", () => {
  it("still reads as unassigned when no process is moving it", () => {
    // Literally true and, with nothing else going on, not misleading either.
    expect(describeUnassigned(null)).toEqual({ label: "Unassigned" });
  });

  it("stops implying the ticket is inert while a process is moving it", () => {
    const described = describeUnassigned(linkedCase());

    expect(described.label).toBe("Nobody yet");
    expect(described.title).toContain("The Feature process is moving it");
    expect(described.title).toContain("commissions its own agents");
  });

  it("goes back to plain unassigned once the process has ended", () => {
    // Nothing is driving it any more, so "pick it up" is the correct reading.
    expect(describeUnassigned(linkedCase({ terminalKind: "done" }))).toEqual({ label: "Unassigned" });
  });
});
