/**
 * Non-human service markers that show up in `userId` / `responsibleUserId`
 * fields as an artifact of internal bookkeeping (bundle seeding, plugin
 * reconciliation, etc). These are NOT accounts — there is no row for them in
 * the users table, they have no memberships, and they can never be an
 * authorization "responsible user".
 *
 * `"local-board"` is deliberately excluded: in local_trusted mode it IS a
 * materialized user row (the implicit board admin), so it is a legitimate,
 * resolvable responsible user rather than a service marker. See
 * `NON_HUMAN_SENTINEL_AUTHOR_USER_IDS` in services/issues.ts for that
 * distinction as it applies to comment authorship.
 *
 * When any of these values would otherwise be carried verbatim into a
 * `responsibleUserId` column, callers must treat it as "no value" and fall
 * through to the resolution ladder (ticket responsibleUserId -> ticket
 * createdByUserId -> company defaultResponsibleUserId -> oldest owner
 * membership) instead. See PAP: APEX-15 / routine-responsible-user.
 */
export const SERVICE_ACTOR_USER_ID_MARKERS = new Set<string>(["built-in-bundles"]);

/**
 * True when `userId` is a real, potentially-resolvable user id — i.e. it is
 * non-empty and is not one of the synthetic service markers above. Does NOT
 * check that the id actually exists or has an active membership; callers
 * that need that guarantee should still go through authorization's
 * responsible-user snapshot.
 */
export function isUsableResponsibleUserId(userId: string | null | undefined): userId is string {
  const trimmed = userId?.trim();
  if (!trimmed) return false;
  return !SERVICE_ACTOR_USER_ID_MARKERS.has(trimmed);
}

/** Returns `userId` when usable, otherwise `null` so callers can fall through a resolution ladder. */
export function usableResponsibleUserIdOrNull(userId: string | null | undefined): string | null {
  return isUsableResponsibleUserId(userId) ? userId.trim() : null;
}
