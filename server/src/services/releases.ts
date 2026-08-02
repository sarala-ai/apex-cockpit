import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  goals,
  issueWorkProducts,
  issues,
  releaseArtifacts,
  releaseChanges,
  releases,
} from "@paperclipai/db";
import {
  RELEASE_CLOSURES,
  RELEASE_STATUSES,
  type ConfoundInitiative,
  type ConfoundSet,
  type Release,
  type ReleaseArtifact,
  type ReleaseChange,
  type ReleaseChangePullRequest,
  type ReleaseClosure,
  type ReleaseDetail,
  type ReleaseNotes,
  type ReleaseNotesSection,
  type ReleaseStatus,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";

type ReleaseRow = typeof releases.$inferSelect;
type ReleaseArtifactRow = typeof releaseArtifacts.$inferSelect;

/**
 * The goal level that names an initiative. Declared here rather than imported
 * from GOAL_LEVELS because the level vocabulary is being extended on a sibling
 * branch; `goals.level` is plain text, so this resolver works whether or not
 * "initiative" has been added to the shared enum yet. If no ancestor carries
 * the level, the goal the ticket is linked to IS the initiative for
 * measurement purposes — the confound question does not get to return "unknown"
 * just because the vocabulary is mid-migration.
 */
const INITIATIVE_LEVEL = "initiative";

/**
 * Postgres reports the violated constraint on the error, but drizzle wraps the
 * driver error and the name can sit several `cause` levels down — matching on
 * the stringified message instead would silently stop working the day the query
 * text changes.
 */
function hasConstraintName(error: unknown, constraintName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { constraint?: unknown; constraint_name?: unknown; cause?: unknown };
  return (
    candidate.constraint === constraintName
    || candidate.constraint_name === constraintName
    || hasConstraintName(candidate.cause, constraintName)
  );
}

function readEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${field} value on release row: ${value}`);
}

function toRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    companyId: row.companyId,
    version: row.version,
    name: row.name ?? null,
    status: readEnum<ReleaseStatus>(row.status, RELEASE_STATUSES, "status"),
    closure: row.closure ? readEnum<ReleaseClosure>(row.closure, RELEASE_CLOSURES, "closure") : null,
    closureReason: row.closureReason ?? null,
    environment: row.environment,
    promotedFromReleaseId: row.promotedFromReleaseId ?? null,
    releasedAt: row.releasedAt ?? null,
    observationWindowEndsAt: row.observationWindowEndsAt ?? null,
    closedAt: row.closedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toArtifact(row: ReleaseArtifactRow): ReleaseArtifact {
  return {
    id: row.id,
    releaseId: row.releaseId,
    companyId: row.companyId,
    repo: row.repo,
    tag: row.tag,
    commitSha: row.commitSha ?? null,
    url: row.url ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * The measurement window of a release.
 *
 * A release that has not been released changed nothing in the world and must
 * never enter a confound computation — that is why `releasedAt` is nullable and
 * why this returns null for it. When no observation window was declared the
 * window degenerates to the instant of release, which still overlaps any window
 * containing that instant.
 */
export function releaseWindow(release: {
  releasedAt: Date | null;
  observationWindowEndsAt: Date | null;
}): { start: Date; end: Date } | null {
  if (!release.releasedAt) return null;
  const start = release.releasedAt;
  const end = release.observationWindowEndsAt ?? release.releasedAt;
  // A window recorded backwards is a data error, not a reason to drop the
  // release from the confound set: treat it as the instant of release.
  return end.getTime() < start.getTime() ? { start, end: start } : { start, end };
}

/** Closed-interval overlap. Touching endpoints count: same instant, same window. */
export function windowsOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): boolean {
  return a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime();
}

type GoalNode = { id: string; level: string; parentId: string | null; title: string };

/**
 * Walk a goal to the nearest ancestor at initiative level, itself included.
 * Falls back to the goal itself when no ancestor is an initiative (see the
 * INITIATIVE_LEVEL note). Cycle-guarded: `goals.parent_id` is a self-reference
 * with no DB-level acyclicity constraint.
 */
export function resolveInitiative(
  goalId: string | null,
  byId: Map<string, GoalNode>,
): GoalNode | null {
  if (!goalId) return null;
  const seen = new Set<string>();
  let current = byId.get(goalId) ?? null;
  const linked = current;
  while (current && !seen.has(current.id)) {
    if (current.level === INITIATIVE_LEVEL) return current;
    seen.add(current.id);
    current = current.parentId ? (byId.get(current.parentId) ?? null) : null;
  }
  return linked;
}

async function loadGoalIndex(db: Db, companyId: string): Promise<Map<string, GoalNode>> {
  const rows = await db
    .select({
      id: goals.id,
      level: goals.level,
      parentId: goals.parentId,
      title: goals.title,
    })
    .from(goals)
    .where(eq(goals.companyId, companyId));
  return new Map(rows.map((row) => [row.id, { ...row, parentId: row.parentId ?? null }]));
}

function initiativeKey(initiative: GoalNode | null): string {
  return initiative ? initiative.id : "__unattributed__";
}

function describeInitiative(initiative: ConfoundInitiative): string {
  return initiative.initiativeTitle ?? "an unattributed change set";
}

/**
 * Build the confound statement. The doctrine is explicit: STATE CONFOUNDS,
 * NEVER HIDE THEM. An unclean verdict, labelled, is worth more than a clean one
 * that is wrong — so this returns a sentence a person can read, not a boolean
 * that a caller might forget to check.
 */
function buildWarning(
  confounding: ConfoundInitiative[],
  releaseLabels: string[],
): string | null {
  if (confounding.length === 0) return null;
  const others = confounding.map(describeInitiative);
  const carried =
    others.length === 1
      ? others[0]
      : `${others.length} other initiatives (${others.join(", ")})`;
  const where =
    releaseLabels.length > 0
      ? ` in ${releaseLabels.length === 1 ? "release" : "releases"} ${releaseLabels.join(", ")}`
      : "";
  return `This measurement window also carried ${carried}${where}; this evidence is not clean.`;
}

export type ConfoundInput = {
  companyId: string;
  windowStart: Date;
  windowEnd: Date;
  /**
   * The initiative being measured. Every OTHER initiative with a change in an
   * overlapping release is a confound. Omit it to ask the weaker question
   * "how many initiatives did this window carry at all", which is what a
   * release detail page needs.
   */
  initiativeId?: string | null;
  /** Releases to ignore — used when a release asks about its own window. */
  excludeReleaseIds?: string[];
};

export function releaseService(db: Db) {
  async function getById(id: string): Promise<Release | null> {
    const row = await db
      .select()
      .from(releases)
      .where(eq(releases.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toRelease(row) : null;
  }

  async function requireRelease(id: string): Promise<Release> {
    const release = await getById(id);
    if (!release) throw notFound("Release not found");
    return release;
  }

  async function listArtifacts(releaseId: string): Promise<ReleaseArtifact[]> {
    const rows = await db
      .select()
      .from(releaseArtifacts)
      .where(eq(releaseArtifacts.releaseId, releaseId))
      .orderBy(asc(releaseArtifacts.repo), asc(releaseArtifacts.tag));
    return rows.map(toArtifact);
  }

  /**
   * The changes a release carries, each resolved through to the initiative it
   * serves and the pull requests that delivered it. This is the provenance
   * chain (ticket → pull request → tag) read back out; nothing here is stored
   * twice.
   */
  async function listChanges(release: Release): Promise<ReleaseChange[]> {
    const rows = await db
      .select({
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        githubMirrorRef: issues.githubMirrorRef,
        goalId: issues.goalId,
        attachedAt: releaseChanges.createdAt,
      })
      .from(releaseChanges)
      .innerJoin(issues, eq(issues.id, releaseChanges.issueId))
      .where(eq(releaseChanges.releaseId, release.id))
      // identifier breaks the tie: a single attachChanges call writes every row
      // with the same timestamp, and notes whose section order flips between
      // reads are not a projection of anything.
      .orderBy(asc(releaseChanges.createdAt), asc(issues.identifier), asc(issues.id));

    if (rows.length === 0) return [];

    const goalIndex = await loadGoalIndex(db, release.companyId);
    const prRows = await db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, release.companyId),
          eq(issueWorkProducts.type, "pull_request"),
          inArray(
            issueWorkProducts.issueId,
            rows.map((row) => row.issueId),
          ),
        ),
      );

    const prsByIssue = new Map<string, ReleaseChangePullRequest[]>();
    for (const pr of prRows) {
      const list = prsByIssue.get(pr.issueId) ?? [];
      list.push({
        id: pr.id,
        title: pr.title,
        url: pr.url ?? null,
        externalId: pr.externalId ?? null,
        status: pr.status,
      });
      prsByIssue.set(pr.issueId, list);
    }

    return rows.map((row) => {
      const initiative = resolveInitiative(row.goalId ?? null, goalIndex);
      return {
        issueId: row.issueId,
        identifier: row.identifier ?? null,
        title: row.title,
        status: row.status,
        githubMirrorRef: row.githubMirrorRef ?? null,
        goalId: row.goalId ?? null,
        initiativeId: initiative?.id ?? null,
        initiativeTitle: initiative?.title ?? null,
        pullRequests: prsByIssue.get(row.issueId) ?? [],
      };
    });
  }

  /**
   * THE POINT OF THE WHOLE FEATURE.
   *
   * Given a window, find every release of this product whose own measurement
   * window overlaps it, and group the changes those releases carried by the
   * initiative each change serves. Any initiative other than the subject is a
   * confound: its changes landed in the same window, so a metric movement
   * cannot be attributed to the subject alone.
   */
  async function computeConfoundSet(input: ConfoundInput): Promise<ConfoundSet> {
    const { companyId, windowStart, windowEnd } = input;
    if (windowEnd.getTime() < windowStart.getTime()) {
      throw badRequest("windowEnd must not be before windowStart");
    }
    const subjectWindow = { start: windowStart, end: windowEnd };
    const excluded = new Set(input.excludeReleaseIds ?? []);

    const candidateRows = await db
      .select()
      .from(releases)
      .where(and(eq(releases.companyId, companyId), isNotNull(releases.releasedAt)))
      .orderBy(asc(releases.releasedAt));

    const overlapping = candidateRows
      .map(toRelease)
      .filter((release) => {
        if (excluded.has(release.id)) return false;
        const window = releaseWindow(release);
        return window !== null && windowsOverlap(window, subjectWindow);
      });

    if (overlapping.length === 0) {
      return {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        subjectInitiativeId: input.initiativeId ?? null,
        clean: true,
        initiatives: [],
        confoundingInitiatives: [],
        overlappingReleases: [],
        warning: null,
      };
    }

    const overlappingIds = overlapping.map((release) => release.id);
    const changeRows = await db
      .select({
        releaseId: releaseChanges.releaseId,
        issueId: releaseChanges.issueId,
        goalId: issues.goalId,
      })
      .from(releaseChanges)
      .innerJoin(issues, eq(issues.id, releaseChanges.issueId))
      .where(
        and(
          eq(releaseChanges.companyId, companyId),
          inArray(releaseChanges.releaseId, overlappingIds),
        ),
      );

    const goalIndex = await loadGoalIndex(db, companyId);
    const grouped = new Map<string, ConfoundInitiative>();
    for (const row of changeRows) {
      const initiative = resolveInitiative(row.goalId ?? null, goalIndex);
      const key = initiativeKey(initiative);
      const existing = grouped.get(key) ?? {
        initiativeId: initiative?.id ?? null,
        initiativeTitle: initiative?.title ?? null,
        changeCount: 0,
        releaseIds: [] as string[],
      };
      existing.changeCount += 1;
      if (!existing.releaseIds.includes(row.releaseId)) existing.releaseIds.push(row.releaseId);
      grouped.set(key, existing);
    }

    const initiatives = [...grouped.values()].sort((a, b) => b.changeCount - a.changeCount);
    const subjectId = input.initiativeId ?? null;
    const confounding = subjectId
      ? initiatives.filter((entry) => entry.initiativeId !== subjectId)
      : // With no subject, a window is only "clean" if a single initiative
        // carried everything in it — there is nothing to measure against.
        initiatives.length > 1
        ? initiatives
        : [];

    const labelById = new Map(
      overlapping.map((release) => [release.id, `${release.version} (${release.environment})`]),
    );
    const confoundReleaseLabels = [
      ...new Set(
        confounding.flatMap((entry) =>
          entry.releaseIds.map((id) => labelById.get(id)).filter((label): label is string =>
            Boolean(label),
          ),
        ),
      ),
    ];

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      subjectInitiativeId: subjectId,
      clean: confounding.length === 0,
      initiatives,
      confoundingInitiatives: confounding,
      overlappingReleases: overlapping,
      warning: buildWarning(confounding, confoundReleaseLabels),
    };
  }

  /**
   * The confound picture for a single release, which is two questions at once:
   * how many initiatives this release itself carried, and which OTHER releases
   * overlapped its window. Both are confounds; both go in the same set.
   */
  async function confoundsForRelease(
    release: Release,
    subjectInitiativeId?: string | null,
  ): Promise<ConfoundSet> {
    const window = releaseWindow(release);
    if (!window) {
      // Not released: no window, nothing shipped, nothing to confound.
      const now = release.createdAt.toISOString();
      return {
        windowStart: now,
        windowEnd: now,
        subjectInitiativeId: subjectInitiativeId ?? null,
        clean: true,
        initiatives: [],
        confoundingInitiatives: [],
        overlappingReleases: [],
        warning: null,
      };
    }
    return computeConfoundSet({
      companyId: release.companyId,
      windowStart: window.start,
      windowEnd: window.end,
      initiativeId: subjectInitiativeId ?? null,
    });
  }

  /**
   * Release notes as a PROJECTION of the record. Nothing here is authored: the
   * sections come from tickets grouped by the initiative they serve, the links
   * from the pull requests already recorded as work products, and the evidence
   * from the repository tags. A confound, if there is one, is stated in the
   * notes rather than left for the reader to discover.
   */
  async function buildNotes(release: Release): Promise<ReleaseNotes> {
    const [changes, artifacts, confounds] = await Promise.all([
      listChanges(release),
      listArtifacts(release.id),
      confoundsForRelease(release),
    ]);

    const sectionMap = new Map<string, ReleaseNotesSection>();
    for (const change of changes) {
      const key = change.initiativeId ?? "__unattributed__";
      const section = sectionMap.get(key) ?? {
        initiativeId: change.initiativeId,
        initiativeTitle: change.initiativeTitle,
        entries: [],
      };
      section.entries.push({
        identifier: change.identifier,
        title: change.title,
        githubMirrorRef: change.githubMirrorRef,
        pullRequestUrls: change.pullRequests
          .map((pr) => pr.url)
          .filter((url): url is string => Boolean(url)),
      });
      sectionMap.set(key, section);
    }
    const sections = [...sectionMap.values()];

    const lines: string[] = [];
    const heading = release.name ? `${release.version} — ${release.name}` : release.version;
    lines.push(`# ${heading}`);
    lines.push("");
    const released = release.releasedAt ? release.releasedAt.toISOString() : "not yet released";
    lines.push(`**Environment:** ${release.environment}  `);
    lines.push(`**Status:** ${release.status}${release.closure ? ` · ${release.closure}` : ""}  `);
    lines.push(`**Released:** ${released}`);
    lines.push("");

    if (confounds.warning) {
      lines.push(`> ⚠️ ${confounds.warning}`);
      lines.push("");
    }

    if (sections.length === 0) {
      lines.push("_No changes recorded against this release._");
      lines.push("");
    } else {
      for (const section of sections) {
        lines.push(`## ${section.initiativeTitle ?? "Unattributed"}`);
        lines.push("");
        for (const entry of section.entries) {
          const id = entry.identifier ? `${entry.identifier}: ` : "";
          const refs = [
            entry.githubMirrorRef,
            ...entry.pullRequestUrls,
          ].filter((value): value is string => Boolean(value));
          const suffix = refs.length > 0 ? ` (${refs.join(", ")})` : "";
          lines.push(`- ${id}${entry.title}${suffix}`);
        }
        lines.push("");
      }
    }

    if (artifacts.length > 0) {
      lines.push("## Artifacts");
      lines.push("");
      for (const artifact of artifacts) {
        const sha = artifact.commitSha ? ` @ ${artifact.commitSha.slice(0, 12)}` : "";
        lines.push(`- \`${artifact.repo}\` \`${artifact.tag}\`${sha}`);
      }
      lines.push("");
    }

    return {
      releaseId: release.id,
      version: release.version,
      name: release.name,
      environment: release.environment,
      status: release.status,
      closure: release.closure,
      releasedAt: release.releasedAt ? release.releasedAt.toISOString() : null,
      sections,
      artifacts,
      confoundWarning: confounds.warning,
      markdown: `${lines.join("\n").trimEnd()}\n`,
    };
  }

  async function attachChanges(release: Release, issueIds: string[]): Promise<ReleaseChange[]> {
    if (issueIds.length === 0) return listChanges(release);
    const owned = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, release.companyId), inArray(issues.id, issueIds)));
    const ownedIds = new Set(owned.map((row) => row.id));
    const foreign = issueIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      // Cross-product attachment would silently corrupt the confound set for
      // BOTH products, so it is refused rather than filtered.
      throw badRequest(
        `Issues do not belong to this product: ${foreign.join(", ")}`,
      );
    }
    await db
      .insert(releaseChanges)
      .values(
        [...ownedIds].map((issueId) => ({
          releaseId: release.id,
          issueId,
          companyId: release.companyId,
        })),
      )
      .onConflictDoNothing();
    return listChanges(release);
  }

  return {
    list: async (companyId: string): Promise<Release[]> => {
      const rows = await db
        .select()
        .from(releases)
        .where(eq(releases.companyId, companyId))
        .orderBy(desc(sql`coalesce(${releases.releasedAt}, ${releases.createdAt})`));
      return rows.map(toRelease);
    },

    getById,

    listArtifacts,
    listChanges,
    computeConfoundSet,
    confoundsForRelease,
    buildNotes: async (releaseId: string): Promise<ReleaseNotes> =>
      buildNotes(await requireRelease(releaseId)),

    detail: async (releaseId: string): Promise<ReleaseDetail> => {
      const release = await requireRelease(releaseId);
      const [changes, artifacts, confounds, promotedFromRow, promotedToRows] = await Promise.all([
        listChanges(release),
        listArtifacts(release.id),
        confoundsForRelease(release),
        release.promotedFromReleaseId
          ? db
              .select()
              .from(releases)
              .where(eq(releases.id, release.promotedFromReleaseId))
              .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
        db
          .select()
          .from(releases)
          .where(eq(releases.promotedFromReleaseId, release.id))
          .orderBy(asc(releases.createdAt)),
      ]);
      return {
        release,
        changes,
        artifacts,
        promotedFrom: promotedFromRow ? toRelease(promotedFromRow) : null,
        promotedTo: promotedToRows.map(toRelease),
        confounds,
      };
    },

    create: async (
      companyId: string,
      data: {
        version: string;
        name?: string | null;
        environment: string;
        status?: ReleaseStatus;
        releasedAt?: Date | null;
        observationWindowEndsAt?: Date | null;
        issueIds?: string[];
      },
    ): Promise<Release> => {
      const status = data.status ?? "planned";
      if (status !== "planned" && status !== "building" && !data.releasedAt) {
        throw badRequest("releasedAt is required once a release reaches 'released'");
      }
      const row = await db
        .insert(releases)
        .values({
          companyId,
          version: data.version,
          name: data.name ?? null,
          environment: data.environment,
          status,
          releasedAt: data.releasedAt ?? null,
          observationWindowEndsAt: data.observationWindowEndsAt ?? null,
        })
        .returning()
        .then((rows) => rows[0])
        .catch((error: unknown) => {
          if (hasConstraintName(error, "releases_company_version_environment_uq")) {
            throw conflict(
              `Release ${data.version} already exists for environment ${data.environment}`,
            );
          }
          throw error;
        });
      const release = toRelease(row);
      if (data.issueIds && data.issueIds.length > 0) {
        await attachChanges(release, data.issueIds);
      }
      return release;
    },

    update: async (
      releaseId: string,
      data: {
        name?: string | null;
        status?: ReleaseStatus;
        releasedAt?: Date | null;
        observationWindowEndsAt?: Date | null;
      },
    ): Promise<Release> => {
      const existing = await requireRelease(releaseId);
      if (existing.closure) {
        throw conflict("A closed release cannot be edited; supersede it with a new release");
      }
      const nextStatus = data.status ?? existing.status;
      const nextReleasedAt =
        data.releasedAt !== undefined ? data.releasedAt : existing.releasedAt;
      if ((nextStatus === "released" || nextStatus === "observing") && !nextReleasedAt) {
        throw badRequest("releasedAt is required once a release reaches 'released'");
      }
      const row = await db
        .update(releases)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.releasedAt !== undefined ? { releasedAt: data.releasedAt } : {}),
          ...(data.observationWindowEndsAt !== undefined
            ? { observationWindowEndsAt: data.observationWindowEndsAt }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(releases.id, releaseId))
        .returning()
        .then((rows) => rows[0]);
      return toRelease(row);
    },

    /**
     * Promotion creates a NEW release in the target environment carrying the
     * same changes and the same artifacts, linked back to its source. It is not
     * an update, because each environment needs its own observation window:
     * "shipped to staging on Tuesday" and "shipped to production on Friday" are
     * two different measurement boundaries for the same version.
     */
    promote: async (
      sourceReleaseId: string,
      data: {
        environment: string;
        version?: string;
        name?: string | null;
        status?: ReleaseStatus;
        observationWindowEndsAt?: Date | null;
      },
    ): Promise<Release> => {
      const source = await requireRelease(sourceReleaseId);
      if (source.environment === data.environment) {
        throw badRequest("A release cannot be promoted into its own environment");
      }
      if (source.closure === "rolled_back") {
        throw conflict("A rolled-back release cannot be promoted");
      }
      const version = data.version ?? source.version;
      const row = await db
        .insert(releases)
        .values({
          companyId: source.companyId,
          version,
          name: data.name !== undefined ? data.name : source.name,
          environment: data.environment,
          status: data.status ?? "planned",
          promotedFromReleaseId: source.id,
          observationWindowEndsAt: data.observationWindowEndsAt ?? null,
        })
        .returning()
        .then((rows) => rows[0])
        .catch((error: unknown) => {
          if (hasConstraintName(error, "releases_company_version_environment_uq")) {
            throw conflict(
              `Release ${version} already exists for environment ${data.environment}`,
            );
          }
          throw error;
        });
      const promoted = toRelease(row);

      const sourceChanges = await db
        .select({ issueId: releaseChanges.issueId })
        .from(releaseChanges)
        .where(eq(releaseChanges.releaseId, source.id));
      if (sourceChanges.length > 0) {
        await db
          .insert(releaseChanges)
          .values(
            sourceChanges.map((change) => ({
              releaseId: promoted.id,
              issueId: change.issueId,
              companyId: source.companyId,
            })),
          )
          .onConflictDoNothing();
      }

      const sourceArtifacts = await listArtifacts(source.id);
      if (sourceArtifacts.length > 0) {
        await db
          .insert(releaseArtifacts)
          .values(
            sourceArtifacts.map((artifact) => ({
              releaseId: promoted.id,
              companyId: source.companyId,
              repo: artifact.repo,
              tag: artifact.tag,
              commitSha: artifact.commitSha,
              url: artifact.url,
            })),
          )
          .onConflictDoNothing();
      }

      return promoted;
    },

    /**
     * Closure is terminal and always carries its reason. `status` is left where
     * it was: a release that ended is still a release that reached
     * "observing" — overwriting that would destroy the lifecycle record for the
     * sake of a display convenience.
     */
    close: async (
      releaseId: string,
      data: { closure: ReleaseClosure; closureReason: string },
    ): Promise<Release> => {
      const existing = await requireRelease(releaseId);
      if (existing.closure) {
        throw conflict(`Release is already closed as ${existing.closure}`);
      }
      if (!existing.releasedAt) {
        throw badRequest("A release that never shipped cannot be closed; delete it instead");
      }
      const row = await db
        .update(releases)
        .set({
          closure: data.closure,
          closureReason: data.closureReason,
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(releases.id, releaseId))
        .returning()
        .then((rows) => rows[0]);
      return toRelease(row);
    },

    attachChanges: async (releaseId: string, issueIds: string[]): Promise<ReleaseChange[]> => {
      const release = await requireRelease(releaseId);
      return attachChanges(release, issueIds);
    },

    addArtifact: async (
      releaseId: string,
      data: { repo: string; tag: string; commitSha?: string | null; url?: string | null },
    ): Promise<ReleaseArtifact> => {
      const release = await requireRelease(releaseId);
      const row = await db
        .insert(releaseArtifacts)
        .values({
          releaseId: release.id,
          companyId: release.companyId,
          repo: data.repo,
          tag: data.tag,
          commitSha: data.commitSha ?? null,
          url: data.url ?? null,
        })
        .onConflictDoNothing({
          target: [releaseArtifacts.releaseId, releaseArtifacts.repo, releaseArtifacts.tag],
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) return toArtifact(row);
      const existing = await db
        .select()
        .from(releaseArtifacts)
        .where(
          and(
            eq(releaseArtifacts.releaseId, release.id),
            eq(releaseArtifacts.repo, data.repo),
            eq(releaseArtifacts.tag, data.tag),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw conflict("Artifact could not be recorded");
      return toArtifact(existing);
    },
  };
}

export type ReleaseService = ReturnType<typeof releaseService>;
