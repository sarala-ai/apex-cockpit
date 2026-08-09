---
name: Spec Writing
slug: spec-writing
description: Craft skill for writing specs that gate approves — task breakdown with machine-checkable criteria, artifact destination is the ticket spec document (never the repo).
version: "1.0"
---

# Spec Writing

**Version:** 1.0

You are writing a specification that will be approved at a gate. That gate pre-approves every task and every line of code derived from what you write. Write accordingly.

## Artifact destination

**The spec goes to the ticket's spec document, never the repo.** Use the Paperclip API to write or update the `spec` document on the issue. Never write a SPEC.md, README, or any file into a repository as a substitute for the board document. The gate reads the board document; a file in the repo is invisible to it.

## What belongs in a spec

A spec has two things and nothing pretending to be a third:

1. **A task breakdown.** PR-sized units, in dependency order, each one a thing a single bounded session can finish. Name which tasks share files (they batch) and which must be separate pull requests (they do not).
2. **Machine-checkable acceptance criteria, per task.** A criterion is machine-checkable when a program can decide it without asking anyone's opinion: a named test passes, a named file exists, a named command exits zero, a pull request exists. "Works correctly" is not a criterion.

Where a task genuinely cannot carry a machine-checkable criterion, state that gap explicitly in the spec for that task. A stated gap is honest. A prose criterion that reads like a check and enforces nothing is a false assurance.

## Before you write

Read the code. A breakdown that names files that do not exist costs the Implementer a whole session to discover. State any open design decisions where the reviewer will see them — not buried inside a task.

## Required: Dependencies section

Every spec must include a `## Dependencies` section. This is a machine-read
section — the gate parser extracts blocker edges from it at approval time.

Grammar (exact):

- Heading: `## Dependencies`
- No blockers: write `None` as the entire body.
- Each blocker on its own line: `- Blocked by: APEX-N` where `APEX-N` is a
  ticket identifier matching the company pattern (e.g. `APEX-26`, `APEX-51`).

On approval the gate resolves each `APEX-\d+` token in this section to a
same-company issue and writes a `blocks` edge. Unknown identifiers are skipped
(logged). An edge that would form a cycle is rejected; the approval still
proceeds. Write only genuine blockers here — tickets that must be `done` before
implementation can start. Related-but-non-blocking context belongs in spec prose.

## Sentinel

The spec artifact destination is the ticket spec document, never the repo.
