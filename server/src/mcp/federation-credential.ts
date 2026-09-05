import type { TokenSource } from "../auth/mint-system-jwt.js";

// The gateway-federation token source is a process-level dependency exactly
// like the system token source (gateway/system-credential.ts): the better-auth
// signer exists once, at bootstrap, while the registration paths (boot-time
// self-registration, the sweep, the manual setup route) are built per module.
// Unregistered (local_trusted mode, tests) the source yields null and
// cockpit-mcp registers without an upstream credential, as before.
let registered: TokenSource | undefined;

export function registerGatewayFederationTokenSource(source: TokenSource | undefined): void {
  registered = source;
}

export const gatewayFederationToken: TokenSource = async () => (registered ? registered() : null);
