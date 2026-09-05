/**
 * Surface-flags service (the Veil).
 *
 * Owns the read/write/reconcile surface over `org_surface_flags` +
 * `org_surface_flag_events`. The registry (packages/shared/src/surfaces.ts)
 * and the facts snapshot (server/src/services/org-facts.ts) are pure inputs;
 * this is the only place that decides what to persist and when to publish a
 * live event.
 *
 * INVARIANT: reconcile() never re-veils (and never re-unveils) a surface an
 * operator or the chat agent set EXPLICITLY (source "chat" | "api" | "user").
 * Only a flag with source "default" | "rule" — or no flag at all — is ever
 * touched by reconcile(). See surface-flags.test.ts.
 */

import { eq } from "drizzle-orm";
import { type Db, orgSurfaceFlags, orgSurfaceFlagEvents } from "@paperclipai/db";
import { SURFACES, type OrgFacts, type SurfaceDef } from "@paperclipai/shared";
import type { SurfaceFlagSource } from "@paperclipai/shared";
import { publishGlobalLiveEvent } from "./live-events.js";

export interface SurfaceFlagRow {
  surfaceKey: string;
  unveiled: boolean;
  source: SurfaceFlagSource;
  reason: string | null;
  actorUserId: string | null;
  actorRunId: string | null;
  updatedAt: string;
}

export interface SurfaceListEntry {
  key: string;
  label: string;
  section: SurfaceDef["section"];
  routes: string[];
  navPath: string;
  stage: SurfaceDef["stage"];
  always: boolean;
  /** Whatever is currently persisted for this org, or null if never written. */
  flag: SurfaceFlagRow | null;
  /** The registry rule's live verdict against the facts snapshot passed in. */
  due: { due: boolean; reason: string };
  /** The UI's actual "should I show this" verdict: always-on, an explicit
   *  unveil, a due() rule firing, or the user's global showAllSurfaces
   *  override. */
  visible: boolean;
}

/** Explicit human/agent-set sources reconcile() must never overwrite. */
const EXPLICIT_SOURCES = new Set<SurfaceFlagSource>(["chat", "api", "user"]);

function toFlagRow(row: {
  surfaceKey: string;
  unveiled: boolean;
  source: string;
  reason: string | null;
  actorUserId: string | null;
  actorRunId: string | null;
  updatedAt: Date;
}): SurfaceFlagRow {
  return {
    surfaceKey: row.surfaceKey,
    unveiled: row.unveiled,
    source: row.source as SurfaceFlagSource,
    reason: row.reason,
    actorUserId: row.actorUserId,
    actorRunId: row.actorRunId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function surfaceFlagsService(db: Db) {
  async function getFlags(orgId: string): Promise<Map<string, SurfaceFlagRow>> {
    const rows = await db.select().from(orgSurfaceFlags).where(eq(orgSurfaceFlags.orgId, orgId));
    return new Map(rows.map((r) => [r.surfaceKey, toFlagRow(r)]));
  }

  return {
    /** The full registry merged with this org's persisted flags + live due()
     *  verdicts + the user's showAllSurfaces override. */
    async list(orgId: string, facts: OrgFacts, showAllSurfaces: boolean): Promise<SurfaceListEntry[]> {
      const flags = await getFlags(orgId);
      return SURFACES.map((surface) => {
        const flag = flags.get(surface.key) ?? null;
        const due = surface.due(facts);
        const always = surface.always === true;
        const visible = always || showAllSurfaces || (flag?.unveiled ?? due.due);
        return {
          key: surface.key,
          label: surface.label,
          section: surface.section,
          routes: surface.routes,
          navPath: surface.navPath,
          stage: surface.stage,
          always,
          flag,
          due,
          visible,
        };
      });
    },

    /** Explicitly set a flag — always an EXPLICIT_SOURCES write (chat/api/user).
     *  Writes the current-state row and appends an event, then publishes a
     *  live event so every open tab picks it up without polling. */
    async set(
      orgId: string,
      surfaceKey: string,
      input: { unveiled: boolean; reason: string; source: SurfaceFlagSource; actorUserId?: string | null; actorRunId?: string | null },
    ): Promise<SurfaceFlagRow> {
      const now = new Date();
      const values = {
        orgId,
        surfaceKey,
        unveiled: input.unveiled,
        source: input.source,
        reason: input.reason,
        actorUserId: input.actorUserId ?? null,
        actorRunId: input.actorRunId ?? null,
        updatedAt: now,
      };
      const [row] = await db
        .insert(orgSurfaceFlags)
        .values(values)
        .onConflictDoUpdate({
          target: [orgSurfaceFlags.orgId, orgSurfaceFlags.surfaceKey],
          set: {
            unveiled: values.unveiled,
            source: values.source,
            reason: values.reason,
            actorUserId: values.actorUserId,
            actorRunId: values.actorRunId,
            updatedAt: values.updatedAt,
          },
        })
        .returning();
      await db.insert(orgSurfaceFlagEvents).values({
        orgId,
        surfaceKey,
        unveiled: values.unveiled,
        source: values.source,
        reason: values.reason,
        actorUserId: values.actorUserId,
        actorRunId: values.actorRunId,
        createdAt: now,
      });
      publishGlobalLiveEvent({
        type: "surface.unveiled",
        payload: { orgId, surfaceKey, unveiled: values.unveiled, source: values.source },
      });
      return toFlagRow(row);
    },

    /** Apply every due() rule against `facts`, writing source:"rule" only for
     *  surfaces with no flag yet or an existing "default"/"rule" flag whose
     *  unveiled state disagrees with the rule. Never touches a flag an
     *  operator/chat set explicitly. Returns the diff actually applied. */
    async reconcile(orgId: string, facts: OrgFacts): Promise<Array<{ surfaceKey: string; unveiled: boolean; reason: string }>> {
      const flags = await getFlags(orgId);
      const changes: Array<{ surfaceKey: string; unveiled: boolean; reason: string }> = [];
      const now = new Date();

      for (const surface of SURFACES) {
        if (surface.always) continue;
        const existing = flags.get(surface.key) ?? null;
        if (existing && EXPLICIT_SOURCES.has(existing.source)) continue; // never overwrite an explicit unveil

        const verdict = surface.due(facts);
        if (existing && existing.unveiled === verdict.due) continue; // already correct, no-op

        const values = {
          orgId,
          surfaceKey: surface.key,
          unveiled: verdict.due,
          source: "rule" as SurfaceFlagSource,
          reason: verdict.reason,
          actorUserId: null,
          actorRunId: null,
          updatedAt: now,
        };
        await db
          .insert(orgSurfaceFlags)
          .values(values)
          .onConflictDoUpdate({
            target: [orgSurfaceFlags.orgId, orgSurfaceFlags.surfaceKey],
            set: {
              unveiled: values.unveiled,
              source: values.source,
              reason: values.reason,
              actorUserId: values.actorUserId,
              actorRunId: values.actorRunId,
              updatedAt: values.updatedAt,
            },
          });
        await db.insert(orgSurfaceFlagEvents).values(values);
        if (verdict.due) {
          publishGlobalLiveEvent({
            type: "surface.unveiled",
            payload: { orgId, surfaceKey: surface.key, unveiled: true, source: "rule" },
          });
        }
        changes.push({ surfaceKey: surface.key, unveiled: verdict.due, reason: verdict.reason });
      }

      return changes;
    },
  };
}
