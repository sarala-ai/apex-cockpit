import type { TokenSource } from "../auth/mint-system-jwt.js";
import { GatewayClient } from "./gateway-client.js";

// The system token source is a process-level dependency, like the gateway
// token minter for heartbeats: the better-auth instance that signs it exists
// once, at bootstrap, while the callers (boot-time self-registration, setup
// probes, model-access) are built per module. Unregistered (local_trusted
// mode, tests) the source yields null and the client falls back to the
// APEX_GATEWAY_TOKEN env, which is the local-gateway contract.
let registered: TokenSource | undefined;

export function registerCockpitSystemTokenSource(source: TokenSource | undefined): void {
  registered = source;
}

export const cockpitSystemToken: TokenSource = async () => (registered ? registered() : null);

/** A gateway client authenticated as the cockpit process itself. */
export function cockpitSystemGatewayClient(): GatewayClient {
  return new GatewayClient(cockpitSystemToken);
}
