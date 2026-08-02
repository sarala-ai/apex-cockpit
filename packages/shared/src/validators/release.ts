import { z } from "zod";
import { RELEASE_CLOSURES, RELEASE_STATUSES } from "../constants.js";

export const createReleaseSchema = z.object({
  version: z.string().min(1),
  name: z.string().optional().nullable(),
  environment: z.string().min(1),
  status: z.enum(RELEASE_STATUSES).optional().default("planned"),
  releasedAt: z.coerce.date().optional().nullable(),
  observationWindowEndsAt: z.coerce.date().optional().nullable(),
  // Accepted at creation so a release can be opened with its changes already
  // known; `attachChanges` covers the incremental case.
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateRelease = z.infer<typeof createReleaseSchema>;

export const updateReleaseSchema = z
  .object({
    name: z.string().optional().nullable(),
    status: z.enum(RELEASE_STATUSES),
    releasedAt: z.coerce.date().optional().nullable(),
    observationWindowEndsAt: z.coerce.date().optional().nullable(),
  })
  .partial();

export type UpdateRelease = z.infer<typeof updateReleaseSchema>;

/**
 * A promotion is a new release row in the target environment, not an update.
 * Version is inherited from the source unless overridden — promoting normally
 * carries the same artifacts forward, which is the whole claim of a promotion.
 */
export const promoteReleaseSchema = z.object({
  environment: z.string().min(1),
  version: z.string().min(1).optional(),
  name: z.string().optional().nullable(),
  status: z.enum(RELEASE_STATUSES).optional().default("planned"),
  observationWindowEndsAt: z.coerce.date().optional().nullable(),
});

export type PromoteRelease = z.infer<typeof promoteReleaseSchema>;

/** Every closure keeps its reason: the reason is the evidence slot. */
export const closeReleaseSchema = z.object({
  closure: z.enum(RELEASE_CLOSURES),
  closureReason: z.string().min(1),
});

export type CloseRelease = z.infer<typeof closeReleaseSchema>;

export const attachReleaseChangesSchema = z.object({
  issueIds: z.array(z.string().uuid()).min(1),
});

export type AttachReleaseChanges = z.infer<typeof attachReleaseChangesSchema>;

export const addReleaseArtifactSchema = z.object({
  repo: z.string().min(1),
  tag: z.string().min(1),
  commitSha: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
});

export type AddReleaseArtifact = z.infer<typeof addReleaseArtifactSchema>;

export const confoundQuerySchema = z.object({
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  initiativeId: z.string().uuid().optional().nullable(),
});

export type ConfoundQuery = z.infer<typeof confoundQuerySchema>;
