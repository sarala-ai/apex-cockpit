/**
 * The one audience every cockpit-issued principal JWT carries — operator,
 * cockpit-system and gateway-federation alike. The gateway trusts cockpit as
 * an IdP for exactly this audience, and cockpit accepts its own tokens under
 * it too (the gateway forwards an operator's token back to cockpit-mcp
 * verbatim), so there is one principal token kind, not one per consumer.
 *
 * Lives in its own dependency-free module: the verifier and the actor
 * middleware need the value in every deployment mode, while better-auth
 * itself is only loaded on authenticated instances.
 */
export const APEX_PRINCIPAL_AUDIENCE = "apex-gateway";
