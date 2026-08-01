import { and, count, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
  agents,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  financeEvents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  documents,
  routines,
  routineRuns,
  routineDocuments,
  cloudScopeBindings,
} from "@paperclipai/db";
import { companySlugSchema, type CompanySlugBreakGlassConsequences } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { environmentService } from "./environments.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { builtInAgentService } from "./built-in-agents.js";

export interface CompanyActivityActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_COMPANY_ACTOR: CompanyActivityActor = {
  actorType: "system",
  actorId: "system",
  agentId: null,
  runId: null,
};

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db);
  const builtInAgents = builtInAgentService(db);

  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function applyArchiveCascadeInTx(tx: CompanyTx, id: string) {
    const pausedAgentRows = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agents.companyId, id),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ))
      .returning({ id: agents.id });

    const activeRunIds = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, id),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .then((rows) => rows.map((row) => row.id));

    await tx
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        error: "Cancelled because the company was archived",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.companyId, id),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        isNull(agentWakeupRequests.runId),
      ));

    return { agentsPaused: pausedAgentRows.length, activeRunIds };
  }

  async function finalizeArchive(
    id: string,
    actor: CompanyActivityActor,
    cascade: { agentsPaused: number; activeRunIds: string[] },
  ) {
    for (const runId of cascade.activeRunIds) {
      await heartbeat.cancelRun(runId, "Cancelled because the company was archived");
    }

    await logActivity(db, {
      companyId: id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "company.archived",
      entityType: "company",
      entityId: id,
      details: {
        agentsPaused: cascade.agentsPaused,
        runsCancelled: cascade.activeRunIds.length,
      },
    });
  }

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    slug: companies.slug,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    attachmentMaxBytes: companies.attachmentMaxBytes,
    defaultResponsibleUserId: companies.defaultResponsibleUserId,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    brandColor: companies.brandColor,
    githubProjectionEnabled: companies.githubProjectionEnabled,
    githubProjectionRepo: companies.githubProjectionRepo,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (companyIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
        .select({
          companyId: costEvents.companyId,
          spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.companyId, companyIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.companyId);
    return new Map(rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isConstraintViolation(error: unknown, constraintName: string) {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
      const constraint = maybe.constraint ?? maybe.constraint_name;
      if (maybe.code === "23505" && constraint === constraintName) {
        return true;
      }
      current = maybe.cause;
    }
    return false;
  }

  function isIssuePrefixConflict(error: unknown) {
    return isConstraintViolation(error, "companies_issue_prefix_idx");
  }

  function isSlugConflict(error: unknown) {
    return isConstraintViolation(error, "companies_slug_idx");
  }

  function slugConflictError(slug: string) {
    return conflict(`Slug "${slug}" is already in use by another company.`, { code: "slug_conflict" });
  }

  function slugImmutableError(existingSlug: string) {
    return conflict(
      `Company slug is permanent and cannot be changed once set — it names capability paths and env vars ` +
        `(APEX_${existingSlug.toUpperCase()}_...). Current slug: "${existingSlug}".`,
      { code: "slug_immutable" },
    );
  }

  function slugBreakGlassConfirmMismatchError(currentSlug: string) {
    return conflict(
      `Break-glass slug change requires typing the CURRENT slug ("${currentSlug}") as confirm — this is the ` +
        `deliberateness proof for the one escape hatch out of write-once immutability.`,
      { code: "slug_break_glass_confirm_mismatch" },
    );
  }

  function slugBreakGlassNotSetError() {
    return unprocessable(
      "Break-glass slug change only applies once a slug is already set — use the normal update() path to set it the first time.",
      { code: "slug_break_glass_not_set" },
    );
  }

  // NEVER exposed through the normal update() path — companyService.update
  // rejects any change to a non-null slug outright (see slugImmutableError).
  // This is the one deliberate, loud, audited escape hatch: it is returned
  // as a dry-run preview whenever `confirm` is absent, and the SAME report is
  // snapshotted into the activity log entry when the change is performed, so
  // what the operator saw and what got recorded are provably the same thing.
  async function buildSlugBreakGlassConsequences(
    database: Pick<Db, "select">,
    companyId: string,
    currentSlug: string,
    proposedSlug: string,
  ): Promise<CompanySlugBreakGlassConsequences> {
    const binding = await database
      .select({ githubRepos: cloudScopeBindings.githubRepos })
      .from(cloudScopeBindings)
      .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, companyId)))
      .then((rows) => rows[0] ?? null);
    const boundRepos = binding?.githubRepos ?? [];

    const currentUpper = currentSlug.toUpperCase();
    const nextUpper = proposedSlug.toUpperCase();

    return {
      companyId,
      currentSlug,
      proposedSlug,
      envVarsThatChange: [
        {
          kind: "env_var",
          current: `APEX_${currentUpper}_WORKFLOWS_PATH`,
          next: `APEX_${nextUpper}_WORKFLOWS_PATH`,
          note: "Per-company workflows capability env var — any shell, systemd unit, or CI job that reads this name by the old slug will silently stop resolving after the change.",
        },
        {
          kind: "env_var",
          current: `APEX_${currentUpper}_SKILLS_PATH`,
          next: `APEX_${nextUpper}_SKILLS_PATH`,
          note: "Per-company skills capability env var, same convention as the workflows path.",
        },
      ],
      capabilitySyncTargets: [
        {
          kind: "capability_sync_path",
          current: `~/.apex/company/${currentSlug}/`,
          next: `~/.apex/company/${proposedSlug}/`,
          note: "Convention root apex-core resolves capability paths from for this company. This command does NOT move or re-key anything under this path — the old directory (and its .sync-lock.json) is orphaned until moved by hand.",
        },
        {
          kind: "capability_sync_path",
          current: `~/.apex/company/${currentSlug}/.sync-lock.json`,
          next: `~/.apex/company/${proposedSlug}/.sync-lock.json`,
          note: "Capability sync lock file (workflows + skills items, synced_at, digests). Sync will treat the new slug as a fresh, never-synced alias until this is manually relocated.",
        },
      ],
      boundRepoConfigs: boundRepos.map((repo) => ({
        repo,
        note: "This repo is bound to the company via cloudScopeBindings. If its committed .apex/settings.yaml carries `company: " +
          currentSlug +
          "`, that config is now stale — this command does NOT open a PR to update it. Update it by hand (or via a PR) in this repo.",
      })),
      warning: boundRepos.length > 0
        ? `${boundRepos.length} bound repo(s) may carry the old slug in committed config — see boundRepoConfigs. Nothing outside this database row is touched by this command.`
        : "No repos are currently bound to this company via cloudScopeBindings, but capability sync paths and env vars derived from the old slug are still orphaned by this change — see capabilitySyncTargets and envVarsThatChange.",
    };
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    const explicitSlug = data.slug !== undefined && data.slug !== null ? data.slug : null;
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      // Slug is write-once and, absent an explicit value, is derived from the
      // allocated issue prefix (same source of uniqueness) rather than left
      // null — creation is the intended one-time set point.
      const slugValue = explicitSlug ?? candidate.toLowerCase();
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate, slug: slugValue })
          .returning();
        return rows[0];
      } catch (error) {
        if (isSlugConflict(error)) {
          if (explicitSlug) throw slugConflictError(explicitSlug);
          // Derived slug collided independently of the issue prefix (rare) —
          // retry with the next candidate, which derives a different slug too.
          suffix += 1;
          continue;
        }
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: async (
      data: typeof companies.$inferInsert,
      opts?: { seedBundledAgents?: boolean },
    ) => {
      const created = await createCompanyWithUniquePrefix(data);
      await environmentsSvc.ensureLocalEnvironment(created.id);
      // Bundled built-in agents (e.g. the Reflection Coach) are auto-provisioned by
      // default (the fork's onboarding behavior). The apex-tower setup flow creates
      // companies clean — pass { seedBundledAgents: false } to skip the seed.
      if (opts?.seedBundledAgents !== false) {
        await builtInAgents.autoProvisionBundledAgents(created.id);
      }
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: async (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const result = await db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;

        // Slug is write-once: once a company has a non-null slug, capability env
        // vars and paths are already keyed on it, so any further update attempt —
        // including re-sending the same value — is rejected. Setting it for the
        // first time (existing.slug is null) is the only allowed path.
        if (companyPatch.slug !== undefined) {
          if (existing.slug) {
            throw slugImmutableError(existing.slug);
          }
          if (companyPatch.slug !== null) {
            companyPatch.slug = companyPatch.slug.toLowerCase();
          }
        }

        // GitHub projection needs a creation target for board-origin mirror
        // issues — enabling without a repo (in this patch or already stored)
        // would make the projection silently skip everything.
        if (companyPatch.githubProjectionEnabled === true) {
          const projectionRepo =
            companyPatch.githubProjectionRepo !== undefined
              ? companyPatch.githubProjectionRepo
              : existing.githubProjectionRepo;
          if (!projectionRepo) {
            throw unprocessable(
              "githubProjectionRepo (owner/name) is required to enable GitHub projection",
            );
          }
        }

        const willReactivate = existing.status !== "active" && companyPatch.status === "active";
        const willArchive = existing.status !== "archived" && companyPatch.status === "archived";

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        let updated;
        try {
          updated = await tx
            .update(companies)
            .set({ ...companyPatch, updatedAt: new Date() })
            .where(eq(companies.id, id))
            .returning()
            .then((rows) => rows[0] ?? null);
        } catch (error) {
          if (isSlugConflict(error) && typeof companyPatch.slug === "string") {
            throw slugConflictError(companyPatch.slug);
          }
          throw error;
        }
        if (!updated) return null;

        let agentsRestored = 0;
        if (willReactivate) {
          const restoredRows = await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.companyId, id),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "company_archived"),
            ))
            .returning({ id: agents.id });
          agentsRestored = restoredRows.length;
        }

        const archiveCascade = willArchive ? await applyArchiveCascadeInTx(tx, id) : null;

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        const shouldLogReactivation = willReactivate &&
          (existing.status === "archived" || agentsRestored > 0);

        return {
          company: enrichCompany(hydrated),
          reactivated: shouldLogReactivation ? { agentsRestored } : null,
          archiveCascade,
        };
      });
      if (!result) return null;
      if (result.reactivated) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.reactivated",
          entityType: "company",
          entityId: id,
          details: { agentsRestored: result.reactivated.agentsRestored },
        });
      }
      if (result.archiveCascade) {
        await finalizeArchive(id, actor, result.archiveCascade);
      }
      return result.company;
    },

    archive: async (id: string, actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR) => {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const wasAlreadyArchived = existing.status === "archived";

        if (!wasAlreadyArchived) {
          await tx
            .update(companies)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(companies.id, id));
        }

        const cascade = wasAlreadyArchived ? null : await applyArchiveCascadeInTx(tx, id);

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return {
          company: enrichCompany(hydrated),
          cascade,
        };
      });
      if (!result) return null;

      if (result.cascade) {
        await finalizeArchive(id, actor, result.cascade);
      }

      return result.company;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Delete from child tables in dependency order
        const companyRunIds = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, id));

        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
        if (companyRunIds.length > 0) {
          await tx
            .delete(heartbeatRunEvents)
            .where(inArray(heartbeatRunEvents.runId, companyRunIds.map((run) => run.id)));
        }
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
        await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, id));
        await tx.delete(documents).where(eq(documents.companyId, id));
        await tx.delete(issues).where(eq(issues.companyId, id));
        await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        await tx.delete(assets).where(eq(assets.companyId, id));
        await tx.delete(goals).where(eq(goals.companyId, id));
        await tx.delete(projects).where(eq(projects.companyId, id));
        // routine_runs references routines (cascade) and routines.assignee_agent_id
        // references agents (set null as of migration 0148) — delete routines
        // ahead of agents regardless, since routine_runs would otherwise dangle
        // on a routines delete performed after agents is gone.
        await tx.delete(routineRuns).where(eq(routineRuns.companyId, id));
        await tx.delete(routines).where(eq(routines.companyId, id));
        await tx.delete(agents).where(eq(agents.companyId, id));
        // cloud_scope_bindings has no FK to companies (generic scopeType/scopeId
        // binding) so it never blocked deletion, but it must still be cleaned up
        // here or it orphans silently.
        await tx
          .delete(cloudScopeBindings)
          .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, id)));
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    // Deletion safety check: counts SUBSTANTIVE work product for a company
    // (issues, heartbeat runs, documents, goals, cost/finance events) plus
    // scaffolding counts (agents, cloud scope bindings) needed for the 409
    // confirmation payload. Seeded/bundled agents+routines, projects, skills,
    // memberships, and scope bindings are intentionally NOT "substantive" —
    // only real work counts toward blocking a delete.
    getDeletionSummary: async (id: string) => {
      const [
        issueCount,
        heartbeatRunCount,
        documentCount,
        goalCount,
        costEventCount,
        financeEventCount,
        agentCount,
        scopeBindingCount,
      ] = await Promise.all([
        db.select({ value: count() }).from(issues).where(eq(issues.companyId, id))
          .then((rows) => rows[0]?.value ?? 0),
        db.select({ value: count() }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, id))
          .then((rows) => rows[0]?.value ?? 0),
        // Exclude documents that are auto-generated routine descriptions
        // (e.g. the seeded "Reflection Coach" bundle's routine doc) — those
        // are scaffolding, not real work product.
        db
          .select({ value: count() })
          .from(documents)
          .leftJoin(routineDocuments, eq(routineDocuments.documentId, documents.id))
          .where(and(eq(documents.companyId, id), isNull(routineDocuments.id)))
          .then((rows) => rows[0]?.value ?? 0),
        db.select({ value: count() }).from(goals).where(eq(goals.companyId, id))
          .then((rows) => rows[0]?.value ?? 0),
        db.select({ value: count() }).from(costEvents).where(eq(costEvents.companyId, id))
          .then((rows) => rows[0]?.value ?? 0),
        db.select({ value: count() }).from(financeEvents).where(eq(financeEvents.companyId, id))
          .then((rows) => rows[0]?.value ?? 0),
        db.select({ value: count() }).from(agents).where(eq(agents.companyId, id))
          .then((rows) => rows[0]?.value ?? 0),
        db.select({ value: count() }).from(cloudScopeBindings)
          .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, id)))
          .then((rows) => rows[0]?.value ?? 0),
      ]);

      const counts = {
        issues: issueCount,
        heartbeatRuns: heartbeatRunCount,
        documents: documentCount,
        goals: goalCount,
        costEvents: costEventCount,
        financeEvents: financeEventCount,
        agents: agentCount,
        scopeBindings: scopeBindingCount,
      };

      const isEmpty =
        counts.issues === 0 &&
        counts.heartbeatRuns === 0 &&
        counts.documents === 0 &&
        counts.goals === 0 &&
        counts.costEvents === 0 &&
        counts.financeEvents === 0;

      return { isEmpty, counts };
    },

    // The ONE deliberate escape hatch out of write-once slug immutability —
    // modeled on the state-lock-break pattern: an explicit command, never
    // reachable through the normal update() path, that shows the operator
    // exactly what breaks BEFORE anything happens, and requires typing the
    // CURRENT slug (not a boolean) as proof of deliberateness.
    //
    // Called with no `confirm` — returns the consequences report only, does
    // NOT touch the row. Called with `confirm` equal to the current slug —
    // performs the change in a transaction and records an audit entry
    // snapshotting the exact same consequences report the operator saw.
    breakGlassChangeSlug: async (
      id: string,
      newSlug: string,
      opts: { confirm?: string; actor: CompanyActivityActor },
    ): Promise<{
      preview: boolean;
      consequences: CompanySlugBreakGlassConsequences;
      company?: ReturnType<typeof enrichCompany>;
      activityId?: string | null;
    }> => {
      const parsedSlug = companySlugSchema.safeParse(newSlug);
      if (!parsedSlug.success) {
        throw unprocessable(parsedSlug.error.issues[0]?.message ?? "Invalid slug", { code: "slug_invalid" });
      }
      const normalizedNewSlug = parsedSlug.data;

      const existing = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Company not found");
      if (!existing.slug) throw slugBreakGlassNotSetError();

      if (opts.confirm === undefined) {
        const consequences = await buildSlugBreakGlassConsequences(db, id, existing.slug, normalizedNewSlug);
        return { preview: true, consequences };
      }

      if (opts.confirm !== existing.slug) {
        throw slugBreakGlassConfirmMismatchError(existing.slug);
      }

      const oldSlug = existing.slug;

      const result = await db.transaction(async (tx) => {
        const txExisting = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!txExisting || !txExisting.slug) throw notFound("Company not found");
        if (txExisting.slug !== oldSlug) {
          // Slug moved out from under this call between the pre-check and the
          // transaction (e.g. a concurrent break-glass) — re-validate rather
          // than blindly overwrite.
          throw slugBreakGlassConfirmMismatchError(txExisting.slug);
        }

        const consequences = await buildSlugBreakGlassConsequences(tx, id, oldSlug, normalizedNewSlug);

        let updated;
        try {
          updated = await tx
            .update(companies)
            .set({ slug: normalizedNewSlug, updatedAt: new Date() })
            .where(eq(companies.id, id))
            .returning()
            .then((rows) => rows[0] ?? null);
        } catch (error) {
          if (isSlugConflict(error)) throw slugConflictError(normalizedNewSlug);
          throw error;
        }
        if (!updated) throw notFound("Company not found");

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: txExisting.logoAssetId,
        }], tx);

        return { company: enrichCompany(hydrated), consequences };
      });

      const activity = await logActivity(db, {
        companyId: id,
        actorType: opts.actor.actorType,
        actorId: opts.actor.actorId,
        agentId: opts.actor.agentId ?? null,
        runId: opts.actor.runId ?? null,
        action: "company.slug_break_glass",
        entityType: "company",
        entityId: id,
        details: {
          oldSlug,
          newSlug: normalizedNewSlug,
          consequences: result.consequences,
        },
      });

      return {
        preview: false,
        company: result.company,
        consequences: result.consequences,
        activityId: activity.id,
      };
    },

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
