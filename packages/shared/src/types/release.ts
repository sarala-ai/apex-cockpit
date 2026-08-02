import type { ReleaseClosure, ReleaseStatus } from "../constants.js";

/**
 * A release is the measurement boundary: the aggregation across the intent tree
 * that answers "what else changed at the same time". It belongs to a product
 * (the level the schema calls `companies`), not to a repository.
 */
export interface Release {
  id: string;
  companyId: string;
  version: string;
  name: string | null;
  status: ReleaseStatus;
  closure: ReleaseClosure | null;
  closureReason: string | null;
  environment: string;
  promotedFromReleaseId: string | null;
  releasedAt: Date | null;
  observationWindowEndsAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseArtifact {
  id: string;
  releaseId: string;
  companyId: string;
  /** "owner/repo" as GitHub names it. */
  repo: string;
  tag: string;
  commitSha: string | null;
  url: string | null;
  createdAt: Date;
}

/** One ticket carried by a release, resolved through to the initiative it serves. */
export interface ReleaseChange {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  githubMirrorRef: string | null;
  goalId: string | null;
  /** Nearest ancestor goal at initiative level, or the linked goal itself. */
  initiativeId: string | null;
  initiativeTitle: string | null;
  pullRequests: ReleaseChangePullRequest[];
}

export interface ReleaseChangePullRequest {
  id: string;
  title: string;
  url: string | null;
  externalId: string | null;
  status: string;
}

export interface ReleaseDetail {
  release: Release;
  changes: ReleaseChange[];
  artifacts: ReleaseArtifact[];
  /** The release this one was promoted from, if any. */
  promotedFrom: Release | null;
  /** Releases promoted onward from this one. */
  promotedTo: Release[];
  confounds: ConfoundSet;
}

/** A distinct initiative that had changes inside a measurement window. */
export interface ConfoundInitiative {
  initiativeId: string | null;
  initiativeTitle: string | null;
  changeCount: number;
  releaseIds: string[];
}

/**
 * The answer to "is this evidence clean". `clean` is false whenever any
 * initiative other than the subject had a change in an overlapping release.
 * When no subject is given, `clean` means the window carried at most one
 * initiative at all.
 */
export interface ConfoundSet {
  windowStart: string;
  windowEnd: string;
  subjectInitiativeId: string | null;
  clean: boolean;
  /** Every initiative in the window, subject included. */
  initiatives: ConfoundInitiative[];
  /** Every initiative in the window except the subject. */
  confoundingInitiatives: ConfoundInitiative[];
  overlappingReleases: Release[];
  /** Human-readable statement of the confound, or null when the evidence is clean. */
  warning: string | null;
}

export interface ReleaseNotesEntry {
  identifier: string | null;
  title: string;
  githubMirrorRef: string | null;
  pullRequestUrls: string[];
}

export interface ReleaseNotesSection {
  initiativeId: string | null;
  initiativeTitle: string | null;
  entries: ReleaseNotesEntry[];
}

/**
 * Notes are a PROJECTION of the record (ticket → pull request → tag), never
 * hand-authored prose. `markdown` is rendered from `sections` + `artifacts`.
 */
export interface ReleaseNotes {
  releaseId: string;
  version: string;
  name: string | null;
  environment: string;
  status: ReleaseStatus;
  closure: ReleaseClosure | null;
  releasedAt: string | null;
  sections: ReleaseNotesSection[];
  artifacts: ReleaseArtifact[];
  confoundWarning: string | null;
  markdown: string;
}
