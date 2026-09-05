/**
 * Cockpit MCP capability vocabulary and the gate that enforces it.
 *
 * Split out of router.ts (which still re-exports the CAP_* constants for
 * existing importers) because two other modules need to reason about a
 * capability WITHOUT importing the router: cockpit-mcp-jwt.ts, which refuses to
 * mint privileged capabilities into a run token, and mcp/secrets-tools.ts,
 * which raises the same CapabilityDeniedError the router's own handlers raise.
 * Importing router.js from either would close an import cycle through the
 * express Router, so the vocabulary lives here on its own.
 */

export const CAP_BOARD_READ = "board:read";
export const CAP_BOARD_WRITE = "board:write";
export const CAP_DRAFT_WRITE = "draft:write";
/**
 * Mint-and-store a credential server-side (mcp/secrets-tools.ts). Deliberately
 * NOT a member of any default grant: see RUN_TOKEN_FORBIDDEN_CAPABILITIES for
 * why an autonomous run can never hold it, and mcp/oauth.ts for the single
 * opt-in path that issues it to a human operator's session.
 */
export const CAP_SECRETS_WRITE = "secrets:write";

/**
 * Explicitly unveil/re-veil a surface (mcp/router.ts's set_surface_veil tool,
 * over server/src/services/surface-flags.ts). Granted by default to operator
 * principals authenticated at /mcp (they already hold board:write-equivalent
 * control over their own org's nav) and to a dispatched run only when a
 * lifecycle node's `permissions.grantedCapabilities` names it explicitly
 * (run-policy.ts's declaredCapabilities pass-through — this is NOT in
 * RUN_TOKEN_FORBIDDEN_CAPABILITIES, unlike secrets:write, because unveiling a
 * surface reveals nothing sensitive and cannot be used to exfiltrate a
 * credential).
 */
export const CAP_VEIL_WRITE = "veil:write";

/**
 * Capabilities that a RUN-scoped token may never carry, whatever the caller
 * asks for.
 *
 * A dispatched run is an autonomous agent with a transcript. Provisioning is
 * safe from the transcript's point of view — the value never enters a tool
 * result — but "which credentials exist and when they are rotated" is an
 * operator decision, not something an agent should be able to take mid-run
 * because a lifecycle node's YAML said so. Enforced at the mint site rather
 * than at each dispatch call site, so a new dispatch path cannot forget it.
 */
export const RUN_TOKEN_FORBIDDEN_CAPABILITIES: readonly string[] = [CAP_SECRETS_WRITE];

/**
 * Thrown when a tool is invoked without the capability it declares. The message
 * is part of the contract (probes and the e2e suite assert on it verbatim).
 */
export class CapabilityDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly required: string,
  ) {
    super(`capability ${required} required for tool ${tool}`);
    this.name = "CapabilityDeniedError";
  }
}

export function requireCapability(
  claims: { granted_capabilities: string[] },
  cap: string,
  tool: string,
): void {
  if (!claims.granted_capabilities.includes(cap)) {
    throw new CapabilityDeniedError(tool, cap);
  }
}
