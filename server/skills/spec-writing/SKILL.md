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

## Required: Dependencies declaration

Every spec must declare its dependencies in two places that must agree:

**1. YAML front matter field (machine-authoritative):**

```
---
dependencies: [APEX-26, APEX-51]
---
```

Use a comma-separated list inside `[...]`. For no blockers, omit the field or
use `dependencies: []`.

**2. `## Dependencies` prose section (human documentation):**

- Heading: `## Dependencies`
- No blockers: write `None` as the entire body.
- Each blocker on its own line: `- Blocked by: APEX-N — <reason>` where
  `APEX-N` is a ticket identifier.

The gate reads blocker edges from the front matter field — that is the only
machine source. The prose section documents **why** each dependency exists for
human reviewers. Both must list the same identifiers. A mismatch between the
two is a gate validation error that blocks approval.

Write only genuine blockers — tickets that must be `done` before implementation
can start. Related-but-non-blocking context belongs in spec prose, not in the
dependencies field.

## Sentinel

The spec artifact destination is the ticket spec document, never the repo.
