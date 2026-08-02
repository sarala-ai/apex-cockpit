import type { GoalClosure, GoalLevel, GoalStatus } from "../constants.js";
import type { GoalAssumption } from "../validators/goal.js";

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
  /** Initiative-only, and genuinely optional: most initiatives carry no question. */
  hypothesis?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
