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
 * In enterprise-auth mode the session identity supersedes all of this; agents
 * carry their own principal plus the human they acted on behalf of.
 */
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
  /** True when nothing could be resolved — surfaced, never silently faked. */
  unresolved: boolean;
}

let cached: { at: number; actor: ResolvedActor } | null = null;

async function probe(cmd: string, args: string[]): Promise<string | null> {
  const res = await run(cmd, args, PROBE_TIMEOUT_MS);
  if (res.status !== "ok") return null;
  const v = res.stdout.trim();
  return v && v !== "(unset)" ? v : null;
}

export async function resolveLocalActor(): Promise<ResolvedActor> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.actor;

  const [gcloudAccount, gitEmail, gitName, ghLogin] = await Promise.all([
    probe("gcloud", ["config", "get-value", "account"]),
    probe("git", ["config", "--get", "user.email"]),
    probe("git", ["config", "--get", "user.name"]),
    probe("gh", ["api", "user", "--jq", ".login"]),
  ]);

  const sources: ResolvedActor["sources"] = {};
  if (gcloudAccount) sources.gcloud = gcloudAccount;
  if (gitEmail) sources.git = gitEmail;
  if (ghLogin) sources.github = ghLogin;

  const email = gcloudAccount ?? gitEmail ?? null;
  const name = gitName ?? ghLogin ?? email ?? "unknown";
  const actor: ResolvedActor = {
    name,
    email,
    sources,
    unresolved: !email && !ghLogin,
  };
  cached = { at: Date.now(), actor };
  return actor;
}

/** Stable, human-readable actor id for span attributes and labels — the email
 *  when we have one (cross-checkable against cloud audit), else the GitHub
 *  login, else an explicit unknown rather than a plausible-looking fake. */
export function actorId(actor: ResolvedActor): string {
  return actor.email ?? actor.sources.github ?? "unknown";
}

export function clearActorCache(): void {
  cached = null;
}
