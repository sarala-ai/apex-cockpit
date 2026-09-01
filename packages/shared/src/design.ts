/**
 * Design surface contract — design-as-code discovery across a company's bound
 * GitHub repos. Canonical format: .penpot (Penpot export, ZIP-of-JSON);
 * legacy .op files are still listed so they surface instead of vanishing.
 *
 * Placement-agnostic by principle: a standalone design repo (apex-design) and
 * an in-repo design/ dir are both just entries in the company's githubRepos
 * binding — discovery globs design files across all of them and takes no
 * position.
 * (Include/exclude rules per org/company/repo are a deliberate LATER
 * generalization — same cascade-settings pattern as skills/capabilities.)
 */
import { z } from "zod";

export const DesignFileEntrySchema = z.object({
  /** "owner/name" of the bound repo the file lives in. */
  repo: z.string(),
  /** Path within the repo, e.g. "product/apex-vision.penpot". */
  path: z.string(),
  /** Basename without extension — display name. */
  name: z.string(),
  /** GitHub blob URL for open-in-GitHub. */
  url: z.string(),
  sizeBytes: z.number().nullable(),
  sha: z.string().nullable(),
});
export type DesignFileEntry = z.infer<typeof DesignFileEntrySchema>;

/**
 * A design change PROPOSED but not landed — an open pull request touching at
 * least one design file.
 *
 * The Design surface exists so a design gate is seconds of board review. That
 * only works if the boards under review are visible, and the boards under
 * review are by definition the unmerged ones. Listing only the default branch
 * meant the gate asked a founder to approve a 2.6 MB binary diff they could
 * not open, which is approving a claim rather than work they have seen —
 * exactly what the product's own gate copy refuses.
 */
export const DesignDraftSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  /** Head branch — what `?ref=` needs to read the proposed bytes. */
  headRef: z.string(),
  /** Design files as they exist ON THE DRAFT, not on the default branch. */
  files: z.array(DesignFileEntrySchema),
});
export type DesignDraft = z.infer<typeof DesignDraftSchema>;

export const DesignRepoListingSchema = z.object({
  repo: z.string(),
  files: z.array(DesignFileEntrySchema),
  /** Open pull requests touching a design file. Empty is the common case and
   *  means "nothing proposed", never "drafts unsupported". */
  drafts: z.array(DesignDraftSchema).default([]),
  /** GitHub's recursive tree listing is capped; true means results may be
   *  incomplete for this repo (surfaced, never silent). */
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type DesignRepoListing = z.infer<typeof DesignRepoListingSchema>;

export const DesignFileContentSchema = z.object({
  repo: z.string(),
  path: z.string(),
  /** Parsed document when it parses; null when it doesn't (surfaced via
   *  parseError rather than pretending). For .penpot this is a summary
   *  ({ format: "penpot", manifest, boards, objectCount, entryCount }); for
   *  legacy .op it's the raw JSON. */
  document: z.unknown().nullable(),
  parseError: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});
export type DesignFileContent = z.infer<typeof DesignFileContentSchema>;
