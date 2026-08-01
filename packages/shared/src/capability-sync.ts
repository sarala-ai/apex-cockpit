/**
 * Capability sync consumer contract — the summary shape for apex-core's
 * `apex capabilities sync` CLI (spec: capability sync + PATH-canonical
 * resolution, Session A / T1), as built against the spec's DOCUMENTED
 * contract while that CLI lands on a separate, unmerged branch:
 *
 *   `apex --output json capabilities sync` (group-level --output, NOT
 *   `capabilities sync --output json` — see capability-sync-cli.ts) →
 *     {"status":"success","synced_at","sources":[alias,...],
 *       "items":[{alias,kind,path,status,digest}],
 *       "diverged":[...same shape, status="diverged" only...],
 *       "pending_skills":[{alias,path,digest,reason}]}
 *   Errors: {"status":"error","error_type","message","remediation"} — same
 *   envelope shape as the workflows contract (workflows.ts), including this
 *   cockpit's own `cli_missing_command` classification for a CLI that
 *   predates the `capabilities` command entirely.
 *
 * `items` mirrors the on-disk lock file's per-item record (T1:
 * `~/.apex/company/<alias>/.sync-lock.json`); `diverged` is the same items
 * filtered to status="diverged", broken out separately so a consumer (the
 * cockpit banner) doesn't have to re-filter; `pending_skills` are skill
 * bundle updates seen upstream but NOT applied because skill sync defaults
 * to notify-not-auto (apply via `--accept-skills` or
 * `capability_sync.skills_auto: true`) — they are NOT lock items (nothing
 * was written) so they get their own list rather than a fourth item status.
 */
import { z } from "zod";

export const CapabilitySyncItemStatusSchema = z.enum(["synced", "diverged", "tombstoned"]);
export type CapabilitySyncItemStatus = z.infer<typeof CapabilitySyncItemStatusSchema>;

export const CapabilitySyncKindSchema = z.enum(["workflows", "skills"]);
export type CapabilitySyncKind = z.infer<typeof CapabilitySyncKindSchema>;

export const CapabilitySyncItemSchema = z.object({
  alias: z.string(),
  kind: CapabilitySyncKindSchema,
  path: z.string(),
  status: CapabilitySyncItemStatusSchema,
  digest: z.string().nullable().optional(),
});
export type CapabilitySyncItem = z.infer<typeof CapabilitySyncItemSchema>;

export const CapabilityPendingSkillSchema = z.object({
  alias: z.string(),
  path: z.string(),
  digest: z.string().nullable().optional(),
  // e.g. "skills_auto not enabled — run with --accept-skills or set
  // capability_sync.skills_auto: true".
  reason: z.string().nullable().optional(),
});
export type CapabilityPendingSkill = z.infer<typeof CapabilityPendingSkillSchema>;

export const CapabilitySyncSuccessSchema = z.object({
  status: z.literal("success"),
  synced_at: z.string(),
  sources: z.array(z.string()),
  items: z.array(CapabilitySyncItemSchema),
  diverged: z.array(CapabilitySyncItemSchema),
  pending_skills: z.array(CapabilityPendingSkillSchema),
});
export type CapabilitySyncSuccess = z.infer<typeof CapabilitySyncSuccessSchema>;

// Shares its shape with WorkflowError (workflows.ts) by convention, not by
// import — the two contracts are independent surfaces that happen to agree
// on "classified error envelope", same as every CLI-backed route here.
export const CapabilitySyncErrorSchema = z.object({
  status: z.literal("error"),
  error_type: z.string(),
  message: z.string(),
  remediation: z.string().nullable().optional(),
});
export type CapabilitySyncError = z.infer<typeof CapabilitySyncErrorSchema>;

export const CapabilitySyncResponseSchema = z.union([CapabilitySyncSuccessSchema, CapabilitySyncErrorSchema]);
export type CapabilitySyncResponse = z.infer<typeof CapabilitySyncResponseSchema>;

/** GET /apex/capabilities/sync — the last summary held in memory by the
 *  periodic job, read-only (no CLI shell). `ranAt`/`summary` are null
 *  together, exactly once: before the first run since boot. */
export const CapabilitySyncStatusResponseSchema = z.object({
  ranAt: z.string().nullable(),
  summary: CapabilitySyncResponseSchema.nullable(),
});
export type CapabilitySyncStatusResponse = z.infer<typeof CapabilitySyncStatusResponseSchema>;
