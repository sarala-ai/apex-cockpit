/**
 * Workflows consumer contract — the read surface over apex-core's `apex
 * workflows` CLI (list/show), as documented for the Part 2 migration:
 *
 *   `apex workflows list --output json` →
 *     {"status":"success","workflows":[{name,path,source,layer,lifecycle,
 *       shadowed_count,shadows_other_layer}]}
 *   `apex workflows show <name> --output json` →
 *     {"status":"success",name,version,lifecycle,description,path,source,
 *       layer,inputs:[...],steps:[...],outputs:[...],definition_yaml}
 *   Errors: {"status":"error","error_type","message","remediation"}.
 *
 * The core CLI this contract describes is unreleased as of this route's
 * authoring (Part 1 lives on an unmerged branch) — see
 * server/src/apex/workflows-cli.ts for how a live CLI that doesn't recognize
 * `workflows` yet is classified rather than crashing the route.
 */
import { z } from "zod";

export const WorkflowLayerSchema = z.enum(["built-in", "user", "project"]);
export type WorkflowLayer = z.infer<typeof WorkflowLayerSchema>;

export const WorkflowSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  source: z.string(),
  layer: WorkflowLayerSchema,
  lifecycle: z.string(),
  shadowed_count: z.number(),
  shadows_other_layer: z.boolean(),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

export const WorkflowListSuccessSchema = z.object({
  status: z.literal("success"),
  workflows: z.array(WorkflowSummarySchema),
});
export type WorkflowListSuccess = z.infer<typeof WorkflowListSuccessSchema>;

export const WorkflowInputSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  default: z.unknown().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

export const WorkflowStepSchema = z.object({
  name: z.string(),
  node_type: z.string(),
  server_type: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  condition: z.string().nullable().optional(),
  continue_on_error: z.boolean().nullable().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDetailSuccessSchema = z.object({
  status: z.literal("success"),
  name: z.string(),
  version: z.string().nullable().optional(),
  lifecycle: z.string(),
  description: z.string().nullable().optional(),
  path: z.string(),
  source: z.string(),
  layer: WorkflowLayerSchema,
  inputs: z.array(WorkflowInputSchema),
  steps: z.array(WorkflowStepSchema),
  outputs: z.array(z.unknown()),
  definition_yaml: z.string(),
});
export type WorkflowDetailSuccess = z.infer<typeof WorkflowDetailSuccessSchema>;

// The CLI's own classified error envelope (not_found / parse_failed / …) AND
// this route's own degraded-CLI classification (cli_missing_command, when the
// installed `apex` binary predates the workflows CLI, or isn't installed at
// all) share this shape — the UI renders both the same way.
export const WorkflowErrorSchema = z.object({
  status: z.literal("error"),
  error_type: z.string(),
  message: z.string(),
  remediation: z.string().nullable().optional(),
});
export type WorkflowError = z.infer<typeof WorkflowErrorSchema>;

export const WorkflowListResponseSchema = z.union([WorkflowListSuccessSchema, WorkflowErrorSchema]);
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;

// ── Footprint join (db-known attribution only — see resource-attribution-store) ──

export const WorkflowFootprintResourceSchema = z.object({
  resourceUri: z.string(),
  assetType: z.string(),
  projectId: z.string(),
  source: z.string(),
});
export type WorkflowFootprintResource = z.infer<typeof WorkflowFootprintResourceSchema>;

export const WorkflowFootprintSchema = z.object({
  resources: z.array(WorkflowFootprintResourceSchema),
  count: z.number(),
  // Always present on a footprint object — an honest reminder this is NOT a
  // live cloud query, only what the cockpit's resource_attributions table
  // already knows about this workflow.
  note: z.string(),
});
export type WorkflowFootprint = z.infer<typeof WorkflowFootprintSchema>;

export const WorkflowDetailResponseSchema = z.union([
  WorkflowDetailSuccessSchema.extend({ footprint: WorkflowFootprintSchema }),
  WorkflowErrorSchema,
]);
export type WorkflowDetailResponse = z.infer<typeof WorkflowDetailResponseSchema>;
