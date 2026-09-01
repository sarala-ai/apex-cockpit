import type { CompanyStatus, PauseReason } from "../constants.js";

// A single env var or capability-sync path that keys off the company slug.
// Surfaced by the break-glass consequences report so an operator can see what
// they'd need to go fix by hand before/after forcing a slug change.
export interface SlugKeyedReference {
  kind: "env_var" | "capability_sync_path" | "bound_repo_config" | "other";
  /** Concrete example using the CURRENT slug, e.g. "APEX_ACME_WORKFLOWS_PATH" or "~/.apex/company/acme/.sync-lock.json". */
  current: string;
  /** Same shape with the PROPOSED slug substituted in, for comparison. */
  next: string;
  note: string;
}

// Returned by companyService.breakGlassChangeSlug BOTH as the dry-run preview
// (no `confirm`) and as the snapshot persisted into the audit/activity log
// entry when the change is actually performed — the operator sees, and the
// record keeps, the exact same accounting.
export interface CompanySlugBreakGlassConsequences {
  companyId: string;
  currentSlug: string;
  proposedSlug: string;
  envVarsThatChange: SlugKeyedReference[];
  capabilitySyncTargets: SlugKeyedReference[];
  boundRepoConfigs: Array<{ repo: string; note: string }>;
  warning: string;
}

// Returned by companyService.breakGlassChangeIssuePrefix, mirroring
// CompanySlugBreakGlassConsequences's dual role (dry-run preview AND the
// snapshot persisted into the activity log entry when performed).
//
// Unlike the slug, issue identifiers (`issues.identifier`, e.g. "APEX-1") are
// a STORED column, not computed at read time (see companyService's
// buildIssuePrefixBreakGlassConsequences for the identifier-rewrite decision
// this informed). So a prefix change is not purely forward-looking the way a
// slug change is: existing identifiers get rewritten transactionally in the
// same operation, and this report tells the operator how many rows that
// touches plus what it can't reach (e.g. old identifiers already baked into
// external GitHub mirror issue titles/bodies).
export interface CompanyIssuePrefixBreakGlassConsequences {
  companyId: string;
  currentPrefix: string;
  proposedPrefix: string;
  existingIssueCount: number;
  sampleRewrittenIdentifiers: Array<{ current: string; next: string }>;
  githubProjectionRepo: string | null;
  warning: string;
}

// Returned by GET /api/companies/identity-preview?name=<name> — a read-only
// preview of the issue prefix + slug companyService.create() would allocate
// for `name`, plus availability against existing companies, so onboarding can
// show it (and let the operator override it) BEFORE submit rather than
// discovering a conflict as a 500 afterward. See companyService.identityPreview.
export interface CompanyIdentityPreview {
  name: string;
  /** Derived issue prefix for `name` (e.g. "APEX-1" prefix "APEX"). Empty string if `name` is blank. */
  issuePrefix: string;
  /** Derived workspace slug for `name`. Empty string if `name` is blank. */
  slug: string;
  /** Whether `issuePrefix` is free to use as-is. */
  prefixAvailable: boolean;
  /** Whether `slug` is free to use as-is. */
  slugAvailable: boolean;
  /** A colliding-free alternative prefix, only set when `prefixAvailable` or `slugAvailable` is false. */
  suggestedPrefix: string | null;
  /** A colliding-free alternative slug, paired with `suggestedPrefix`. */
  suggestedSlug: string | null;
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  // Write-once (see companySlugSchema / companyService.update). Nullable only
  // for the not-yet-backfilled edge case; new companies always get one at
  // creation.
  slug: string | null;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes: number;
  defaultResponsibleUserId: string | null;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
