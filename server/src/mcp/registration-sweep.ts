/**
 * cockpit-mcp registers itself with the APEX gateway exactly once at boot
 * (app.ts, fire-and-forget — see the comment there). If the gateway is down
 * or restarting at that moment, that attempt fails and is never retried, so
 * cockpit-mcp stays unregistered until the next deploy pass. This is the
 * retry: it re-attempts registration on a timer, stops once the registry
 * read confirms cockpit-mcp is registered and reachable, and resumes
 * automatically if a later registry read no longer finds it (e.g. the
 * gateway's own state was reset).
 *
 * It is also the credential refresher. The gateway holds a short-lived
 * gateway-federation token (auth/mint-system-jwt.ts) as cockpit-mcp's
 * upstream credential and cannot renew it, so once registered the sweep
 * re-points the registration with a fresh token before the stored one
 * expires — see `federationCredentialPolicy`.
 */
import { startPeriodicJob } from "../lib/periodic-job.js";
import type { GatewayClient } from "../gateway/gateway-client.js";
import { cockpitSystemGatewayClient } from "../gateway/system-credential.js";
import { gatewayFederationToken } from "./federation-credential.js";
import type { TokenSource } from "../auth/mint-system-jwt.js";
import {
  registerCockpitMcpWithGateway,
  COCKPIT_MCP_GATEWAY_NAME,
  type CockpitMcpUrlInput,
  type CockpitMcpRegistrationResult,
} from "./router.js";
import { recordCockpitMcpRegistrationAttempt } from "./registration-state.js";

const SWEEP_ENV_VAR = "APEX_MCP_REGISTRATION_SWEEP_SEC";
const DEFAULT_SWEEP_MS = 300_000;

/** The sweep interval this process runs on (APEX_MCP_REGISTRATION_SWEEP_SEC,
 *  default 300s). Exported so the federation token's lifetime is derived from
 *  the same number the refresh rule uses. */
export function cockpitMcpRegistrationSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env[SWEEP_ENV_VAR] ?? "300");
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * 1000 : DEFAULT_SWEEP_MS;
}

/**
 * The lifetime/refresh contract between the federation token and this sweep.
 * The stored token must outlive the sweep's ability to replace it:
 *
 *   lifetime  = 3 × interval + margin   (what mintGatewayFederationJwt is asked for)
 *   refresh   when remaining < 2 × interval
 *
 * A token written at tick 0 is left alone at tick 1 (remaining 2I+margin),
 * refreshed at tick 2 (remaining I+margin), and if THAT tick fails (gateway
 * down) it is still valid at tick 3 (remaining = margin) for one more try.
 * One missed tick is survivable; two are not, and the gateway's own health
 * check then marks cockpit-mcp unreachable, which the registration branch
 * below repairs with a fresh token on the next tick anyway. A fresh process
 * has no record of what the gateway holds and refreshes on its first tick.
 * The cached token source (createCachedTokenSource) must hand out a token
 * with at least 2 × interval remaining, so its refresh margin is that.
 */
export function federationCredentialPolicy(intervalMs: number, marginMs = 60_000) {
  return {
    lifetimeSeconds: Math.ceil((3 * intervalMs + marginMs) / 1000),
    refreshBelowMs: 2 * intervalMs,
    tokenSourceRefreshMarginMs: 2 * intervalMs,
  };
}

export interface CockpitMcpRegistrationSweepDeps {
  client?: GatewayClient;
  federationToken?: TokenSource;
  log?: (line: string) => void;
  now?: () => number;
}

export interface CockpitMcpRegistrationSweepResult {
  /** false when the registry already confirms cockpit-mcp and its stored
   *  credential is fresh — no attempt was made this tick. */
  attempted: boolean;
  result: CockpitMcpRegistrationResult | null;
}

export function cockpitMcpRegistrationSweep(
  input: Omit<CockpitMcpUrlInput, "explicitUrl">,
  deps: CockpitMcpRegistrationSweepDeps = {},
  intervalMs: number = cockpitMcpRegistrationSweepIntervalMs(),
) {
  const client = deps.client ?? cockpitSystemGatewayClient();
  const log = deps.log ?? ((line: string) => console.log(`[cockpit-mcp-registration] ${line}`));
  const now = deps.now ?? Date.now;
  const policy = federationCredentialPolicy(intervalMs);

  const federationToken = deps.federationToken ?? gatewayFederationToken;

  /** What this process knows about the federation credential the gateway
   *  holds: nothing yet (a fresh process refreshes on its first tick), none
   *  in play (no signer on this instance — the registry read alone decides),
   *  or the expiry of the one it last stored. */
  let credential: { kind: "unknown" } | { kind: "none" } | { kind: "stored"; expiresAt: number | null } = { kind: "unknown" };

  /** The stop condition: cockpit-mcp present in the registry AND the gateway
   *  reports it reachable — not just "a write once succeeded". */
  async function verifiedRegistered(): Promise<boolean> {
    const existing = await client.readGateways();
    if (!existing.ok) return false;
    const entry = existing.value.find((g) => g.name === COCKPIT_MCP_GATEWAY_NAME);
    return entry != null && entry.reachable !== false;
  }

  async function credentialRefreshDue(): Promise<boolean> {
    if (credential.kind === "none") return false;
    if (credential.kind === "unknown") {
      if (!(await federationToken())) {
        credential = { kind: "none" };
        return false;
      }
      return true;
    }
    return credential.expiresAt === null || credential.expiresAt - now() < policy.refreshBelowMs;
  }

  async function attempt(): Promise<CockpitMcpRegistrationSweepResult> {
    const result = await registerCockpitMcpWithGateway(input, client, { federationToken, refreshCredential: true });
    recordCockpitMcpRegistrationAttempt(result);
    if (result.credentialExpiresAt !== undefined) {
      credential = { kind: "stored", expiresAt: result.credentialExpiresAt };
    }
    log(`attempt outcome=${result.outcome} url=${result.mcpUrl} — ${result.message}`);
    return { attempted: true, result };
  }

  async function sweep(): Promise<CockpitMcpRegistrationSweepResult> {
    if (!(await verifiedRegistered())) {
      return attempt();
    }
    if (!(await credentialRefreshDue())) {
      return { attempted: false, result: null };
    }
    return attempt();
  }

  return { sweep, policy };
}

export function startCockpitMcpRegistrationSweep(
  input: Omit<CockpitMcpUrlInput, "explicitUrl">,
  deps: CockpitMcpRegistrationSweepDeps & { intervalMs?: number } = {},
): () => void {
  const intervalMs = deps.intervalMs ?? cockpitMcpRegistrationSweepIntervalMs();
  const job = cockpitMcpRegistrationSweep(input, deps, intervalMs);
  return startPeriodicJob({
    name: "cockpit-mcp-registration",
    envVar: SWEEP_ENV_VAR,
    defaultHours: 0,
    intervalMs,
    initialDelayMs: Math.min(intervalMs, 30_000),
    run: () => job.sweep(),
  });
}
