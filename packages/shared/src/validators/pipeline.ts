import { z } from "zod";
import {
  ISSUE_EXECUTION_WORKSPACE_PREFERENCES,
  issueExecutionWorkspaceSettingsSchema,
} from "./issue.js";

const routineVariableLikeNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const pipelineStageKindSchema = z.enum(["working", "review", "done", "cancelled"]);
export const legacyPipelineStageKindSchema = z.enum(["open", "working", "review", "done", "cancelled"]);

export const pipelineStageApproverSchema = z.object({
  kind: z.enum(["any_human", "user", "agent"]).optional().default("any_human"),
  id: z.string().trim().min(1).max(200).optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== "any_human" && (typeof value.id !== "string" || value.id.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["id"],
      message: "Specific stage approvers require an id",
    });
  }
});

/**
 * A stage's entry STEP, on the wire.
 *
 * This is the AUTHORING surface, and it is deliberately small: an author picks
 * a kind, names a target, and optionally says where success and failure send
 * the case. Everything else the substrate needs to run the step — cases,
 * versions, leases, sweeps, briefs, permission profiles — is runtime machinery
 * and appears nowhere here, because none of it is a decision an author makes
 * (docs/architecture/process-definition.md).
 *
 * Three kinds, by WHO EXECUTES: `run` (the machine, free), `agent` (a model,
 * tokens), `routine` (a model, via a routine template). The GATE kind is
 * absent because a gate is not an entry action — it is what a `review` stage
 * IS, and it is configured by the stage's `gate` block.
 */
const runTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workflow"),
    workflow: z.string().trim().min(1).max(200),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  // A `command` target executes on the HOST. It is accepted by the schema
  // because seeded definitions and instance admins legitimately use it, and
  // REFUSED for everyone else server-side (`assertRunTargetAuthorized` in
  // services/pipelines.ts). The check lives there, not here, because a schema
  // cannot see who is asking — and a boundary that depends on the client
  // choosing not to send a field is not a boundary.
  z.object({
    type: z.literal("command"),
    tool: z.string().trim().min(1).max(200),
    args: z.array(z.string()).optional(),
  }),
]);

const stageStepRoutingSchema = {
  id: z.string().trim().min(1).max(200).optional(),
  /** Where a zero exit sends the case. Absent = stay put. */
  onSuccessToStageKey: z.string().trim().min(1).max(200).optional(),
  /** Where a non-zero exit sends the case. Absent = HOLD the stage, which is
   *  what `on_fail: pause` means. */
  onFailureToStageKey: z.string().trim().min(1).max(200).optional(),
};

export const pipelineStageOnEnterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run"),
    target: runTargetSchema,
    /** One line, for a person, interpolated against the tool's result — e.g.
     *  "deployed {{steps_completed}} services". Optional on purpose: a step
     *  with no template reports nothing rather than dumping its payload. */
    report: z.string().trim().min(1).max(500).optional(),
    ...stageStepRoutingSchema,
  }).passthrough(),
  z.object({
    type: z.literal("agent"),
    promptTemplate: z.string().trim().min(1),
    budget: z.record(z.string(), z.unknown()).optional().nullable(),
    permissions: z.unknown().optional(),
    ...stageStepRoutingSchema,
  }).passthrough(),
  z.object({
    type: z.literal("routine"),
    routineId: z.string().uuid(),
    projectId: z.string().uuid().optional().nullable(),
    projectWorkspaceId: z.string().uuid().optional().nullable(),
    executionWorkspaceId: z.string().uuid().optional().nullable(),
    executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
    executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
    ...stageStepRoutingSchema,
  }).passthrough(),
]);

export const pipelineStageAutomationSchema = z.object({
  routineId: z.string().uuid().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  instructionsBody: z.string().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
}).passthrough();

export const pipelineStageCarryOverPolicySchema = z.object({
  version: z.literal(1).default(1),
  mode: z.enum(["all_except", "only"]).default("all_except"),
  includeFields: z.array(routineVariableLikeNameSchema).max(100).default([]),
  excludeFields: z.array(routineVariableLikeNameSchema).max(100).default([]),
});

export const pipelineStageBreakdownSchema = z.object({
  targetPipelineId: z.string().uuid(),
  targetStageKey: z.string().trim().min(1).max(120),
  pieceNoun: z.string().trim().min(1).max(80).default("piece"),
  carryOverPolicy: pipelineStageCarryOverPolicySchema.optional(),
  inheritFields: z.array(routineVariableLikeNameSchema).max(100).default([]),
  advanceTo: z.string().trim().min(1).max(120).optional(),
  waitForPieces: z.boolean().optional().default(false),
  whenFinishedMoveTo: z.string().trim().min(1).max(120).optional(),
}).superRefine((value, ctx) => {
  if (value.waitForPieces && !value.whenFinishedMoveTo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["whenFinishedMoveTo"],
      message: "Breakdown stages that wait for pieces need a destination stage",
    });
  }
});

export const pipelineStageVariableSchema = z.object({
  key: routineVariableLikeNameSchema,
  label: z.string().trim().max(120),
  type: z.enum(["select", "text", "multiline"]).default("text"),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
  required: z.boolean().optional().default(false),
  showInAddForm: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Select variables require at least one option",
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Only select variables can define options",
    });
  }
});

export const pipelineStageConfigSchema = z.object({
  variables: z.array(pipelineStageVariableSchema).default([]),
  disabled: z.boolean().optional(),
  disabledReason: z.string().trim().max(1_000).nullable().optional(),
  requireApproval: z.boolean().optional(),
  approver: pipelineStageApproverSchema.optional(),
  /** Legacy input only; the server migrates it to requireApproval/approver. */
  reviewerKind: z.enum(["human", "any"]).optional(),
  whatHappensHere: z.string().trim().max(10_000).optional(),
  onEnter: pipelineStageOnEnterSchema.optional(),
  automation: pipelineStageAutomationSchema.optional(),
  breakdown: pipelineStageBreakdownSchema.optional(),
  approveToStageKey: z.string().trim().min(1).max(120).optional(),
  rejectToStageKey: z.string().trim().min(1).max(120).optional(),
  requestChangesToStageKey: z.string().trim().min(1).max(120).optional(),
  requireRejectReason: z.boolean().optional(),
  requireRequestChangesReason: z.boolean().optional(),
  requireChildrenTerminal: z.boolean().optional(),
  requireNoUnresolvedDrift: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const keys = new Set<string>();
  value.variables.forEach((variable, index) => {
    if (keys.has(variable.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variables", index, "key"],
        message: "Pipeline stage variable keys must be unique",
      });
    }
    keys.add(variable.key);
  });
});

export const pipelineAutomationRetryScopeSchema = z.enum(["current_stage", "previous_stage"]);

export const pipelineAutomationRetryCleanupOptionsSchema = z.object({
  retireDirectChildren: z.boolean().default(true),
  retireDescendants: z.boolean().default(true),
  cancelLinkedAutomationIssues: z.boolean().default(true),
});

export const pipelineAutomationRetryRequestSchema = z.object({
  scope: pipelineAutomationRetryScopeSchema,
  targetStageId: z.string().uuid().nullable().optional(),
  expectedVersion: z.number().int().positive(),
  cleanup: pipelineAutomationRetryCleanupOptionsSchema.default({
    retireDirectChildren: true,
    retireDescendants: true,
    cancelLinkedAutomationIssues: true,
  }),
});

export type PipelineStageKind = z.infer<typeof pipelineStageKindSchema>;
export type PipelineStageApprover = z.infer<typeof pipelineStageApproverSchema>;
export type PipelineStageOnEnter = z.infer<typeof pipelineStageOnEnterSchema>;
export type PipelineStageAutomationConfig = z.infer<typeof pipelineStageAutomationSchema>;
export type PipelineStageCarryOverPolicy = z.infer<typeof pipelineStageCarryOverPolicySchema>;
export type PipelineStageBreakdown = z.infer<typeof pipelineStageBreakdownSchema>;
export type PipelineStageVariable = z.infer<typeof pipelineStageVariableSchema>;
export type PipelineStageConfig = z.infer<typeof pipelineStageConfigSchema>;
export type PipelineAutomationRetryScope = z.infer<typeof pipelineAutomationRetryScopeSchema>;
export type PipelineAutomationRetryCleanupOptions = z.infer<typeof pipelineAutomationRetryCleanupOptionsSchema>;
export type PipelineAutomationRetryRequest = z.infer<typeof pipelineAutomationRetryRequestSchema>;
