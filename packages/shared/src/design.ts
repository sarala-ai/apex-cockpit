/**
 * Design surface contract — design-as-code (.op, OpenPencil) discovery across
 * a company's bound GitHub repos.
 *
 * Placement-agnostic by principle: a standalone design repo (apex-design) and
 * an in-repo design/ dir are both just entries in the company's githubRepos
 * binding — discovery globs *.op across all of them and takes no position.
 * (Include/exclude rules per org/company/repo are a deliberate LATER
 * generalization — same cascade-settings pattern as skills/capabilities.)
 */
import { z } from "zod";

export const DesignFileEntrySchema = z.object({
  /** "owner/name" of the bound repo the file lives in. */
  repo: z.string(),
  /** Path within the repo, e.g. "product/apex-vision.op". */
  path: z.string(),
  /** Basename without extension — display name. */
  name: z.string(),
  /** GitHub blob URL for open-in-GitHub. */
  url: z.string(),
  sizeBytes: z.number().nullable(),
  sha: z.string().nullable(),
});
export type DesignFileEntry = z.infer<typeof DesignFileEntrySchema>;

export const DesignRepoListingSchema = z.object({
  repo: z.string(),
  files: z.array(DesignFileEntrySchema),
  /** GitHub's recursive tree listing is capped; true means results may be
   *  incomplete for this repo (surfaced, never silent). */
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type DesignRepoListing = z.infer<typeof DesignRepoListingSchema>;

export const DesignFileContentSchema = z.object({
  repo: z.string(),
  path: z.string(),
  /** Parsed .op JSON when it parses; null when it doesn't (surfaced via
   *  parseError rather than pretending). */
  document: z.unknown().nullable(),
  parseError: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});
export type DesignFileContent = z.infer<typeof DesignFileContentSchema>;
