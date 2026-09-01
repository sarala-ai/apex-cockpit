/**
 * Company setup — cloud/account discovery (spec 003 draft).
 *
 * Read-only control-plane queries that back the one-time "connect a company to
 * its Google org + GitHub org" flow: check auth status, and load the existing
 * GCP projects/orgs and GitHub orgs/repos the authed accounts can see. Shells
 * `gcloud`/`gh` (deterministic core, already-authed) — same posture as the
 * ticket source. Nothing here provisions; creation goes through APEX workflows.
 */

import { err, ok, type Result } from '../errors.js';
import { run } from '../exec.js';

export type CloudProvider = 'google';

export interface AuthStatus {
  // `authed` = an account is configured; `live` = its token is currently usable
  // (not expired). A session can be authed-but-not-live once the token lapses,
  // which is the signal the UI uses to prompt an interactive re-auth.
  google: { authed: boolean; account: string | null; live: boolean };
  github: { authed: boolean; user: string | null; live: boolean };
}

export interface GcpProject {
  projectId: string;
  name: string;
  projectNumber: string;
}
export interface GcpOrg {
  id: string; // numeric org id
  displayName: string;
}
export interface GhOrg {
  login: string;
  id: number;
}
export interface GhRepo {
  name: string;
  nameWithOwner: string;
  visibility: string;
  url: string;
}

/**
 * Check whether gcloud and gh are authenticated, and as whom. Never throws.
 *
 * `authed` reflects a configured account; `live` reflects a currently-usable
 * token. For gcloud these differ — `config get-value account` still returns the
 * account after the token expires, so we separately probe `auth print-access-token`
 * (which silently refreshes when a refresh token is valid and only fails on true
 * session expiry). For gh, `api user` hits the network, so its success already
 * means live.
 */
export async function checkAuth(): Promise<AuthStatus> {
  const [gcloudAcct, gcloudToken, ghUser] = await Promise.all([
    run('gcloud', ['config', 'get-value', 'account'], 10000),
    run('gcloud', ['auth', 'print-access-token'], 10000),
    run('gh', ['api', 'user', '--jq', '.login'], 10000),
  ]);

  const account =
    gcloudAcct.status === 'ok' && gcloudAcct.stdout.trim() && gcloudAcct.stdout.trim() !== '(unset)'
      ? gcloudAcct.stdout.trim()
      : null;
  const googleLive = gcloudToken.status === 'ok' && gcloudToken.stdout.trim().length > 0;
  const user = ghUser.status === 'ok' && ghUser.stdout.trim() ? ghUser.stdout.trim() : null;

  return {
    google: { authed: account !== null, account, live: googleLive },
    github: { authed: user !== null, user, live: user !== null },
  };
}

// Note: interactive re-auth is intentionally NOT done server-side in local dev.
// `checkAuth().google.live === false` signals expiry; the UI prompts the operator
// to run `gcloud auth login` (or re-run scripts/run-tower.sh). A future hosted
// deployment replaces that guidance with an in-app OAuth redirect + per-user token
// store behind the same detect→prompt seam.

function parseJson<T>(res: Awaited<ReturnType<typeof run>>, source: string): Result<T> & { source: string } {
  if (res.status === 'missing') {
    return { ...err('tool-missing', 'CLI not installed or not on PATH.'), source: 'unavailable' };
  }
  if (res.status === 'failed') {
    const unauth = /auth|login|credential|reauth|not logged/i.test(res.stderr);
    return {
      ...err(unauth ? 'tool-unauth' : 'tool-failed', unauth
        ? 'Not authenticated — run `gcloud auth login` / `gh auth login`.'
        : res.stderr.trim().slice(0, 200)),
      source: 'unavailable',
    };
  }
  try {
    return { ...ok(JSON.parse(res.stdout) as T), source };
  } catch {
    return { ...err('parse-failed', 'Could not parse CLI JSON output.'), source: 'unavailable' };
  }
}

/** List GCP projects the authed account can see. */
export async function listGcpProjects(): Promise<Result<GcpProject[]> & { source: string }> {
  const res = await run(
    'gcloud',
    ['projects', 'list', '--format=json(projectId,name,projectNumber)', '--sort-by=projectId'],
    20000,
  );
  return parseJson<GcpProject[]>(res, 'gcloud');
}

/** List GCP organizations the authed account can see. */
export async function listGcpOrgs(): Promise<Result<GcpOrg[]> & { source: string }> {
  const res = await run('gcloud', ['organizations', 'list', '--format=json(displayName,name)'], 20000);
  const parsed = parseJson<Array<{ displayName?: string; name?: string }>>(res, 'gcloud');
  if (!parsed.ok) return parsed;
  // gcloud returns name as "organizations/<id>"; normalize to {id, displayName}.
  const orgs = parsed.value.map((o) => ({
    id: (o.name ?? '').split('/').pop() ?? '',
    displayName: o.displayName ?? '',
  }));
  return { ...ok(orgs), source: parsed.source };
}

/** List GitHub orgs the authed user belongs to. */
export async function listGithubOrgs(): Promise<Result<GhOrg[]> & { source: string }> {
  const res = await run('gh', ['api', 'user/orgs', '--jq', '[.[] | {login, id}]'], 15000);
  return parseJson<GhOrg[]>(res, 'gh');
}

/** List repos under a GitHub org (or the authed user if org omitted). */
export async function listGithubRepos(org: string): Promise<Result<GhRepo[]> & { source: string }> {
  const target = org ? [org] : [];
  const res = await run(
    'gh',
    ['repo', 'list', ...target, '--limit', '100', '--json', 'name,nameWithOwner,visibility,url'],
    15000,
  );
  return parseJson<GhRepo[]>(res, 'gh');
}
