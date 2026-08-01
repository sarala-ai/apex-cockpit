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
