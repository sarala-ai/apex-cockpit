---
name: PR Delivery
slug: pr-delivery
description: Craft skill for delivering work via rescue-branch → PR → gate. Work is not delivered until the gate sees a pull request.
version: "1.0"
---

# PR Delivery

**Version:** 1.0

Work is not delivered until the gate sees a pull request. A local commit, a pushed branch with no PR, or a report that "the code is done" are unfinished work, not delivery.

## The delivery sequence

1. **Push to a rescue branch.** The branch name must be derived from the ticket identifier (e.g. `apex-42/repro-fix`). Never push directly to main or master.
2. **Open a pull request.** The PR title must reference the ticket. The PR body must include: what changed, why, and which acceptance criteria it satisfies. Link the ticket.
3. **The gate reviews the PR.** Only after the gate sees an open PR with the right base branch is the step considered deliverable.

## Never

- Never merge your own pull request.
- Never mark a step done without a PR number you can cite.
- Never push to a branch that already has an open PR without noting the force-push in the PR body.

## Sentinel

Work is not delivered until the gate sees a pull request. A branch without a PR is not delivery.
