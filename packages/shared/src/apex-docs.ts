/**
 * apex-docs consumer contract — the read surface over apex-core's `apex docs`
 * CLI (list/show/search/tags/related), as documented in
 * apex/core/src/apex_core/tools/apex_docs.py:
 *
 *   `apex docs list --output json` →
 *     {"status":"success","docs":[{id,source,path,title,kind,stage,styles,
 *       entities,topics,surfaces,workflows,relates_to,status,summary,valid,
 *       version}],"errors":[...]}
 *   `apex docs show <id> --output json` →
 *     {"status":"success","doc":{...DocSummary,body,headings}}
 *   `apex docs search "<q>" --output json` →
 *     {"status":"success","query":string,"results":[DocSummary & {score,
 *       explain?}]}
 *   `apex docs tags --output json` →
 *     {"status":"success","tags":{<field>:{closed,values?,counts}}}
 *   `apex docs related <id> --output json` →
 *     {"status":"success","id":string,"related":[{id,reason,shared}]}
 *   Errors: {"status":"error","error_type","message","remediation"}.
 *
 * `version` is apex-core's own installed-package version, stamped onto every
 * catalog/detail entry by GuidanceIndex — NOT a doc-content version. Passed
 * through verbatim rather than re-derived, per server/src/apex/docs-cli.ts.
 */
import { z } from "zod";

export const DocsErrorSchema = z.object({
  status: z.literal("error"),
  error_type: z.string(),
  message: z.string(),
  remediation: z.string().nullable().optional(),
});
export type DocsError = z.infer<typeof DocsErrorSchema>;

export const DocSummarySchema = z.object({
  id: z.string(),
  source: z.enum(["guidance", "curated"]),
  path: z.string(),
  title: z.string(),
  kind: z.string().nullable().optional(),
  stage: z.union([z.number(), z.string()]).nullable().optional(),
  styles: z.array(z.string()),
  entities: z.array(z.string()),
  topics: z.array(z.string()),
  surfaces: z.array(z.string()),
  workflows: z.array(z.string()),
  relates_to: z.array(z.string()),
  status: z.string().nullable().optional(),
  summary: z.string().optional(),
  valid: z.boolean(),
  version: z.string(),
});
export type DocSummary = z.infer<typeof DocSummarySchema>;

export const DocsListSuccessSchema = z.object({
  status: z.literal("success"),
  docs: z.array(DocSummarySchema),
  errors: z.array(
    z.object({
      error_type: z.string(),
      message: z.string(),
      remediation: z.string().nullable().optional(),
    }),
  ),
});
export type DocsListSuccess = z.infer<typeof DocsListSuccessSchema>;

export const DocHeadingSchema = z.object({
  text: z.string(),
  level: z.number().optional(),
});

export const DocDetailSchema = DocSummarySchema.extend({
  body: z.string(),
  headings: z.array(DocHeadingSchema).optional(),
});
export type DocDetail = z.infer<typeof DocDetailSchema>;

export const DocsShowSuccessSchema = z.object({
  status: z.literal("success"),
  doc: DocDetailSchema,
});
export type DocsShowSuccess = z.infer<typeof DocsShowSuccessSchema>;

export const DocSearchResultSchema = DocSummarySchema.extend({
  score: z.number(),
  explain: z
    .object({
      matched_filters: z.record(z.string(), z.array(z.string())).optional(),
      matched_terms: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      matched_headings: z.array(z.string()).optional(),
    })
    .optional(),
});
export type DocSearchResult = z.infer<typeof DocSearchResultSchema>;

export const DocsSearchSuccessSchema = z.object({
  status: z.literal("success"),
  query: z.string(),
  results: z.array(DocSearchResultSchema),
});
export type DocsSearchSuccess = z.infer<typeof DocsSearchSuccessSchema>;

export const DocsTagFieldSchema = z.object({
  closed: z.boolean(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  counts: z.record(z.string(), z.number()),
});
export type DocsTagField = z.infer<typeof DocsTagFieldSchema>;

export const DocsTagsSuccessSchema = z.object({
  status: z.literal("success"),
  tags: z.record(z.string(), DocsTagFieldSchema),
});
export type DocsTagsSuccess = z.infer<typeof DocsTagsSuccessSchema>;

export const DocRelatedEntrySchema = z.object({
  id: z.string(),
  reason: z.enum(["relates_to", "tag_overlap"]).or(z.string()),
  shared: z.record(z.string(), z.number()).nullable().optional(),
});
export type DocRelatedEntry = z.infer<typeof DocRelatedEntrySchema>;

export const DocsRelatedSuccessSchema = z.object({
  status: z.literal("success"),
  id: z.string(),
  related: z.array(DocRelatedEntrySchema),
});
export type DocsRelatedSuccess = z.infer<typeof DocsRelatedSuccessSchema>;

/** Shared closed-taxonomy filters accepted by `list`/`search` (AND across
 *  fields, OR within a field — repeatable on the CLI side). */
export interface DocsFilterInput {
  kind?: string[];
  stage?: string[];
  style?: string[];
  entity?: string[];
  surface?: string[];
  topic?: string[];
  status?: string[];
  workflow?: string[];
}
