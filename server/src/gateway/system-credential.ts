import { GatewayClient } from "./gateway-client.js";

/**
 * @deprecated Env-token client, not an identity: every gateway call is made
 * as the person the request acts for (operator-gateway-client.ts). Kept only
 * for apex-setup-state.ts and services/org-facts.ts; delete it with their
 * last import.
 */
export function cockpitSystemGatewayClient(): GatewayClient {
  return new GatewayClient(null);
}
