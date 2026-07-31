/**
 * Local actor resolution — who APEX records as having caused an effect.
 *
 * The rule (identity spec, apex-docs): **the actor is the credential that
 * performed the effect, never a name someone typed.** A deploy from this
 * machine runs as a specific gcloud account and a commit is authored by a
 * specific git identity; GCP's own audit log and git history will say so
 * independently. Recording anything else produces attribution that cannot be
 * reconciled with the systems that actually changed — which is worst exactly
 * where it matters most, since a local instance mutates real cloud resources.
 *
 * So we never ask the operator to sign in or type a name locally. We resolve
 * from credentials already in use, in priority order:
 *   1. gcloud account  — the identity that acts on GCP (effects leave the box)
 *   2. git user.email  — the identity that authors commits/PRs
 *   3. gh login        — the identity that acts on GitHub
 *
 * Git resolution is REPO-LOCAL when a repo path is supplied: `git config` in a
 * checkout returns that repo's local value before the global one, and people
 * legitimately commit to different repos under different identities (work vs
 * personal). Since APEX is company-scoped and companies bind to repos, a run
 * touching a given checkout should be attributed to that checkout's identity,
 * not the machine default.
 *
 * When NO credential exists — no gcloud, no git, no gh — we stamp the machine's
 * own identity: OS user + host. That is always available, needs no tooling and
 * no network, and "srinivas@Srinivass-MacBook-Pro" is a far better audit record
 * than "unknown". It answers a weaker question (where this originated, not
 * under whose authority), which is exactly right for the case where no
 * authority was presented.
 *
 * We deliberately do NOT use a MAC address as the machine id: this laptop
 * exposes five interfaces with different addresses, the Thunderbolt bridge one
 * is locally-administered (software-assigned, mutable), and macOS randomises
 * the Wi-Fi address per network — so "the MAC" is neither well-defined nor
 * stable. Hostname is readable and stable enough; hardware UUID is available
 * if machine identity ever needs to resist forgery.
 *
 * In enterprise-auth mode the session identity supersedes all of this; agents
 * carry their own principal plus the human they acted on behalf of.
 */
import os from "node:os";

import { run } from "../apex/exec.js";

const PROBE_TIMEOUT_MS = 4_000;
/** Credentials change rarely; re-probing per request would be silly. */
const TTL_MS = 10 * 60_000;

export interface ResolvedActor {
  /** Display name — best available human name. */
  name: string;
  /** Primary email — the strongest cross-checkable identifier we have. */
  email: string | null;
  /** Which credential each part came from, so the record is auditable. */
  sources: { gcloud?: string; git?: string; github?: string };
  /** Where this originated — always resolvable, independent of credentials.
   *  A different question from "who": machine provenance, not authority. */
  origin: { user: string; host: string };
  /** True when no CREDENTIAL resolved and the actor fell back to machine
   *  identity — surfaced so the record is never mistaken for an authority. */
  unresolved: boolean;
}

const cache = new Map<string, { at: number; actor: ResolvedActor }>();

async function probe(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  const res = await run(cmd, args, PROBE_TIMEOUT_MS, cwd);
  if (res.status !== "ok") return null;
  const v = res.stdout.trim();
  return v && v !== "(unset)" ? v : null;
}

export async function resolveLocalActor(repoPath?: string): Promise<ResolvedActor> {
  const key = repoPath ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.actor;

  const [gcloudAccount, gitEmail, gitName, ghLogin] = await Promise.all([
    probe("gcloud", ["config", "get-value", "account"]),
    probe("git", ["config", "--get", "user.email"], repoPath),
    probe("git", ["config", "--get", "user.name"], repoPath),
    probe("gh", ["api", "user", "--jq", ".login"]),
  ]);

  const sources: ResolvedActor["sources"] = {};
  if (gcloudAccount) sources.gcloud = gcloudAccount;
  if (gitEmail) sources.git = gitEmail;
  if (ghLogin) sources.github = ghLogin;

  // Machine identity — no tooling, no network, always present.
  const originUser = os.userInfo().username;
  const originHost = os.hostname().replace(/\.local$/i, "");
  const origin = { user: originUser, host: originHost };

  const email = gcloudAccount ?? gitEmail ?? null;
  const unresolved = !email && !ghLogin;
  const name = gitName ?? ghLogin ?? email ?? `${originUser}@${originHost}`;
  const actor: ResolvedActor = {
    name,
    email,
    sources,
    origin,
    unresolved,
  };
  cache.set(key, { at: Date.now(), actor });
  return actor;
}

/** Actor id for span attributes and labels: the email when we have one
 *  (cross-checkable against cloud audit), else the GitHub login, else the
 *  machine identity — never a fabricated placeholder. */
export function actorId(actor: ResolvedActor): string {
  return actor.email ?? actor.sources.github ?? `${actor.origin.user}@${actor.origin.host}`;
}

export function clearActorCache(): void {
  cache.clear();
}
