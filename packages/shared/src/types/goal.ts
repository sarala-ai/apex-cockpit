import type {
  GoalClosure,
  GoalLevel,
  GoalStatus,
  InitiativeDerivedStatus,
} from "../constants.js";
import type { InitiativeProjectCounts } from "../initiative-status.js";
import type {
  GoalAssumption,
  GoalHold,
  GoalHypothesis,
  GoalProvenance,
  GoalValidationCriterion,
} from "../validators/goal.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  // ── Initiative-only fields ──────────────────────────────────────────────
  // Optional as well as nullable: the API always returns them (asserted by the
  // goals round-trip test, not by this type), but they are level-conditional,
  // so goal values built by anything other than the server — plugin fakes,
  // fixtures, older clients — legitimately omit them. Readers must treat
  // absent and null identically.
  /**
   * Initiative-only, COMPUTED from the projects joined to this goal — never
   * stored, never accepted on a write. The stored `status` column is inert on
   * an initiative (the API refuses to hand-edit it) precisely so the two can
   * never disagree. `derivedStatus` is a consequence; `closure` below is a
   * decision. Absent when the caller did not compute it.
   */
  derivedStatus?: InitiativeDerivedStatus | null;
  /**
   * Initiative-only, computed alongside `derivedStatus`. The status alone can
   * imply completeness it does not have — `delivered` says nothing about the
   * projects cancelled to get there, or the ones built and never exercised —
   * so the counts travel with it.
   */
  projectCounts?: InitiativeProjectCounts | null;
  /** Initiative-only. Null on every other level, and on an open initiative. */
  closure?: GoalClosure | null;
  /** The evidence that goes with the closure — every closure keeps its reason. */
  closureReason?: string | null;
  /** Initiative-only risk sheet; null (or empty) when nothing was written down. */
  assumptions?: GoalAssumption[] | null;
  /** Initiative-only. Free text — time or money, deliberately not unit-modelled. */
  budget?: string | null;
  /** Initiative-only. What would make us stop, written before work begins. */
  stopCondition?: string | null;
  /**
   * Initiative-only, and genuinely optional: most initiatives carry no
   * question. The original single-field form, kept readable and deliberately
   * not migrated — see `hypotheses`.
   */
  hypothesis?: string | null;
  /**
   * Initiative-only. The structured form: each question separately answerable,
   * with a verdict a query can find. Null (or empty) when nothing was written
   * down.
   */
  hypotheses?: GoalHypothesis[] | null;
  /**
   * Initiative-only. A decided pause with its reason. Present means held, and
   * a held initiative reads `on_hold` whatever its projects say: the
   * derivation is a consequence, this is a decision.
   */
  hold?: GoalHold | null;
  /**
   * Initiative-only. The pre-registered bars this initiative is judged
   * against, each with a named reader and a date. Null (or empty) when nothing
   * was written down — which is a different statement from a single criterion
   * with status `never_registered`, and both are honest records of different
   * facts.
   */
  validationCriteria?: GoalValidationCriterion[] | null;
  /** Initiative-only. How this record came to exist: confirmed, or inferred. */
  provenance?: GoalProvenance | null;
  createdAt: Date;
  updatedAt: Date;
}
