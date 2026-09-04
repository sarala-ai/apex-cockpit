/**
 * cockpit-mcp registers itself with the APEX gateway exactly once at boot
 * (app.ts, fire-and-forget — see the comment there). If the gateway is down
 * or restarting at that moment, that attempt fails and is never retried, so
 * cockpit-mcp stays unregistered until the next deploy pass. This is the
 * retry: it re-attempts registration on a timer, stops once the registry
 * read confirms cockpit-mcp is registered and reachable, and resumes
 * automatically if a later registry read no longer finds it (e.g. the
 * gateway's own state was reset).
 */
import { startPeriodicJob } from "../lib/periodic-job.js";
import type { GatewayClient } from "../gateway/gateway-client.js";
import { cockpitSystemGatewayClient } from "../gateway/system-credential.js";
import {
  registerCockpitMcpWithGateway,
  COCKPIT_MCP_GATEWAY_NAME,
  type CockpitMcpUrlInput,
  type CockpitMcpRegistrationResult,
} from "./router.js";
import { recordCockpitMcpRegistrationAttempt } from "./registration-state.js";

export interface CockpitMcpRegistrationSweepDeps {
  client?: GatewayClient;
  log?: (line: string) => void;
}

export interface CockpitMcpRegistrationSweepResult {
  /** false when the registry already confirms cockpit-mcp — no attempt was made this tick. */
  attempted: boolean;
  result: CockpitMcpRegistrationResult | null;
}

export function cockpitMcpRegistrationSweep(
  input: Omit<CockpitMcpUrlInput, "explicitUrl">,
  deps: CockpitMcpRegistrationSweepDeps = {},
) {
  const client = deps.client ?? cockpitSystemGatewayClient();
  const log = deps.log ?? ((line: string) => console.log(`[cockpit-mcp-registration] ${line}`));

  /** The stop condition: cockpit-mcp present in the registry AND the gateway
   *  reports it reachable — not just "a write once succeeded". */
  async function verifiedRegistered(): Promise<boolean> {
    const existing = await client.readGateways();
    if (!existing.ok) return false;
    const entry = existing.value.find((g) => g.name === COCKPIT_MCP_GATEWAY_NAME);
    return entry != null && entry.reachable !== false;
  }

  async function sweep(): Promise<CockpitMcpRegistrationSweepResult> {
    if (await verifiedRegistered()) {
      return { attempted: false, result: null };
    }
    const result = await registerCockpitMcpWithGateway(input, client);
    recordCockpitMcpRegistrationAttempt(result);
    log(`attempt outcome=${result.outcome} url=${result.mcpUrl} — ${result.message}`);
    return { attempted: true, result };
  }

  return { sweep };
}

const SWEEP_ENV_VAR = "APEX_MCP_REGISTRATION_SWEEP_SEC";

export function startCockpitMcpRegistrationSweep(
  input: Omit<CockpitMcpUrlInput, "explicitUrl">,
  deps: CockpitMcpRegistrationSweepDeps & { intervalMs?: number } = {},
): () => void {
  const fromEnv = Number(process.env[SWEEP_ENV_VAR] ?? "300");
  const intervalMs = deps.intervalMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * 1000 : 300_000);
  const job = cockpitMcpRegistrationSweep(input, deps);
  return startPeriodicJob({
    name: "cockpit-mcp-registration",
    envVar: SWEEP_ENV_VAR,
    defaultHours: 0,
    intervalMs,
    initialDelayMs: Math.min(intervalMs, 30_000),
    run: () => job.sweep(),
  });
}
