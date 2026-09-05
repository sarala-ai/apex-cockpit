import { z } from "zod";

/** Who/what set a surface flag. Mirrors org_surface_flags.source's CHECK. */
export const surfaceFlagSourceSchema = z.enum(["chat", "api", "user", "default", "rule"]);
export type SurfaceFlagSource = z.infer<typeof surfaceFlagSourceSchema>;

/** PUT /orgs/:orgId/surfaces/:key body. */
export const putSurfaceFlagSchema = z.object({
  unveiled: z.boolean(),
  reason: z.string().min(1).max(500),
});
export type PutSurfaceFlag = z.infer<typeof putSurfaceFlagSchema>;

/** POST /orgs/:orgId/surfaces/reconcile body — always empty today; kept as an
 *  object (not z.undefined()) so the route can add options later without a
 *  breaking shape change. */
export const reconcileSurfaceFlagsSchema = z.object({}).strict();
export type ReconcileSurfaceFlags = z.infer<typeof reconcileSurfaceFlagsSchema>;
