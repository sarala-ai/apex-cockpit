---
routineKey: reconstruct-initiatives
title: Reconstruct initiatives and projects from the repositories and the board
description: Bounded brownfield sweep over git history, specs/docs and board activity that reconstructs candidate initiatives and projects as ONE reviewable proposal. Writes nothing to the board directly; every record carries its provenance and absence is reported rather than filled in.
assigneeRef:
  resourceKind: agent
  resourceKey: product-assistant
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: repoPaths
    label: Repository paths to scan (comma-separated, blank = every repo already registered)
    type: string
    defaultValue: null
    required: false
    options: []
  - name: lookbackDays
    label: Lookback window (days)
    type: number
    defaultValue: 540
    required: false
    options: []
  - name: maxRecords
    label: Max records in the proposal
    type: number
    defaultValue: 40
    required: false
    options: []
  - name: recordKind
    label: What to reconstruct
    type: select
    defaultValue: initiatives
    required: false
    options:
      - initiatives
triggers:
  - kind: schedule
    label: Reconstruction sweep
    enabled: false
    cronExpression: "0 9 1 * *"
    timezone: UTC
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

# Reconstruct initiatives from an existing product

This routine is **paused by default** and spends nothing until an operator
triggers a run. A company arriving with years of work and an empty board has no
bulk path onto it; this is that path, and it produces **a proposal to review**,
never rows on the board.

Read `docs/architecture/product-engineering.md` ("Onboarding an existing
product") and `docs/architecture/initiative-discipline.md` before you start if
they are present in the repos you can reach. What follows is binding either
way.

## The one rule everything else serves

**Reconstruct evidence. Propose structure. Never assert intent.**

What shipped and when, what exists now, what broke, what was decided *where
someone wrote it down*, and what was abandoned — these are recoverable from the
record. **Why it was built, what was assumed, what would have stopped it, and
whether it succeeded are not.** They live in people's heads. An agent that
infers them is guessing in a confident voice, and a false memory is worse than
no memory because nobody knows to doubt it.

You may characterise generously. You may not assert.

- *"This body of work ran March to May; the essence appears to be payments
  reliability"* — a characterisation, honest when labelled as one.
- *"Initiative: payments reliability. Stop condition: p99 under 200ms"* — a
  record, and inventing it is fabrication.

Same content, different claim about where it came from. A wrong draft gets
corrected; an empty board gets abandoned. So do not stall on certainty — draft
generously and mark honestly.

## What this run must do

1. **Establish scope.** Scan the repositories named in `{{repoPaths}}` (blank →
   every repository this company has registered). Limit history to the last
   `{{lookbackDays}}` days. Reconstruct `{{recordKind}}`.

2. **Read the record, in this order of authority.** Specs, design documents and
   architecture records first — they are the only place written intent exists.
   Then pull requests and their review discussion. Then commit history, grouped
   into bodies of work by time window and touched paths. Then the board's own
   history: existing goals, tickets, comments, approvals and activity. Prefer
   the primary record over any later summary of it, **including summaries
   written by agents**.

3. **Read what is already on the board FIRST, before drafting anything.** Call
   `paperclipListGoals` and read every existing initiative. This board is not
   empty and the realistic case is correction, not creation.

4. **Decide update vs create, per record.**
   - A body of work whose evidence lines up with an existing initiative →
     **UPDATE**: set `targetId` to that initiative's id and propose only the
     fields your evidence actually improves. Carry the existing title unless
     the evidence contradicts it.
   - A body of work with no existing initiative → **CREATE**: leave `targetId`
     unset.
   - When two existing initiatives appear to describe one body of work, or one
     appears to describe two, **do not merge or split them yourself**. Propose
     the record you can evidence and say so in the proposal summary. Merging is
     a decision, and decisions are the reviewer's.

5. **Emit exactly ONE proposal**, via `paperclipCreateProposal` (kind
   `initiatives`), capped at `{{maxRecords}}` records, then
   `paperclipSubmitProposal`. One proposal, one gate — the decision being made
   is "is this reconstruction right", not "is row 14 right".

## Provenance, per record, without exception

Every record carries `provenance`, and the source is required either way:

- `{kind: "confirmed", source: "<commit sha | spec path | PR number | document
  title>"}` — you read this in the record. Name the artifact precisely enough
  that a reviewer can open it.
- `{kind: "inferred", source: "<what you inferred it FROM>"}` — e.g. *"47
  commits under server/payments, 2026-03-04 to 2026-05-19"*, *"3 specs under
  specs/022-*"*. A reviewer must be able to check the inference rather than
  trust it.

**Never present reconstructed intent as recorded intent.** A title you derived
from a directory name is inferred, whatever it reads like. If a description
mixes both, the record is `inferred` and the confirmed parts cite their sources
inline.

**Evidence carries dates.** A three-year-old assumption may no longer hold —
say *"this was true in 2024, worth re-checking"* rather than restating it as
current.

## Absence is reported, never filled in

These are the most valuable lines the proposal can contain, because they are
the ones that change what happens next:

- No validation criteria were registered → say so. **Do not write criteria.** A
  criterion without a named reader and a date is not a criterion, and you can
  name neither.
- No stop condition was recorded → leave `stopCondition` empty.
  **Never retro-fit a stop condition.** Asking what would have stopped a past
  initiative is a good question for a person; recording an answer as though it
  had been decided at the time is fabrication.
- No hypothesis was written → leave `hypothesis` empty rather than
  reverse-engineering one from the outcome.
- Owner, dates or adoption unknown → say unknown.
- Closure: `delivered is not validated`. Propose `closure` only where the
  record itself contains the verdict. Code existing is delivery; someone using
  it is validation, and if nothing says anyone used it, leave closure empty.

An empty field is an honest record that nobody wrote one. A filled field you
invented is the failure this entire routine is shaped to prevent.

## Shape of the records themselves

- **Names state an outcome, not a component.** The test: can you follow the
  name with *"…and we will know it is true when…"* without rewriting it? "The
  MCP server layer" fails; "Every interface generated from MCP tools" passes.
- **An initiative containing "and" is usually two.** Where the evidence
  genuinely covers two outcomes, propose two records and say why in the
  summary.
- **Prefer fewer, well-evidenced records over exhaustive guesses.** Twelve
  records a reviewer can check beat forty they cannot. Unattributed work is
  reported in the summary as unattributed — *"reconstructed roughly sixty
  percent of the window; the remainder is unattributed"* is trustworthy, and a
  tidy tree covering everything is a lie about a codebase nobody documented.

## Hard limits

- **Proposal-only.** Do not create, update or close a goal, project, ticket or
  approval directly. `paperclipCreateProposal` and `paperclipSubmitProposal`
  are your only write path, and what they write is inert until a person
  approves it.
- **Do not edit any file**, in any repository or working directory. Do not open
  a pull request, push a branch, or run any command that changes anything.
- **Read-only git and `gh` only.** `git log`, `git show`, `git diff`,
  `git rev-list`, `git blame`, `git shortlog` and the other read verbs;
  `gh pr view`, `gh pr diff`, `gh issue view`, `gh release view`, `gh run view`
  and their `list` forms. Everything else through `Bash` is refused by the
  runtime — including `git checkout`, `git fetch`, `git stash`, every `gh`
  write, and `gh api` (the grant cannot tell a GET from a POST). If a read you
  want is refused, report that it was refused rather than looking for another
  way to run it.
- **`gh` may not be authenticated.** If it fails on auth, say so in the summary
  and reconstruct from git and the board alone — clearly marked as such, since
  a window read without pull requests is a window with its review discussion
  missing. Never print a token, and never set one.
- Keep every read company-scoped. Do not cross company boundaries.
- Never quote a credential, token or connection string you encounter while
  reading, even to report that you found one. Report the location and the fact,
  never the value.
- If you cannot read git history in this run, **say so and stop**. Produce no
  proposal rather than a proposal reconstructed from the board alone and
  presented as if it came from the repositories.

## Output

One submitted proposal, plus a summary comment on the routine issue stating:
repositories and window scanned, how many records are proposed as updates
versus creates, how many are `confirmed` versus `inferred`, what was found but
deliberately left out, and — explicitly — what the record did not contain.
