/**
 * The gateway credential for a call the cockpit makes on someone's behalf:
 * that person's own principal JWT. A human in the request means their token;
 * the cockpit carries no process identity of its own toward the gateway.
 *
 * The minters are process-level closures over the better-auth instance,
 * wired once at bootstrap, while the callers are built per module or per
 * request — so, like the heartbeat's gateway-token minter, they register
 * here. Unregistered (local_trusted mode, tests) every client falls back to
 * APEX_GATEWAY_TOKEN, which is the local-gateway contract.
 */
import type { Request } from "express";
import { GatewayClient } from "./gateway-client.js";

export interface OperatorTokenMinters {
  /** Mints the signed-in operator's principal JWT for an HTTP request. */
  forRequest?: (req: Request) => Promise<string | null>;
  /** Mints a principal JWT for a known user id (request-less call sites
   *  that still act for a person, e.g. a service handed the actor's id). */
  forUser?: (userId: string) => Promise<string | null>;
}

let registered: OperatorTokenMinters = {};

export function registerOperatorTokenMinters(minters: OperatorTokenMinters): void {
  registered = minters;
}

/** The person a request acts for: the board actor, or the user an agent
 *  run is attributed to. Null for an unattributed (or absent) actor. */
export function operatorUserId(req: Request): string | null {
  const actor = req.actor;
  if (!actor) return null;
  if (actor.type === "board") return actor.userId ?? null;
  return actor.onBehalfOfUserId ?? null;
}

function operatorTokenSource(userId: string, mint: () => Promise<string | null>): () => Promise<string | null> {
  return async () => {
    const token = await mint();
    // The request names a person, so answering as nobody would misattribute
    // the call: surface this as `credential_unavailable`, never fall through
    // to the env token.
    if (!token) throw new Error(`no operator principal JWT for user ${userId}`);
    return token;
  };
}

/**
 * The gateway client for one HTTP request. The operator's own token when the
 * request acts for a person and a minter is wired; otherwise the env-token
 * client (local/unauthenticated gateways). `mint` overrides the registered
 * request minter — the seam tests and the observe routes inject through.
 */
export function gatewayClientForRequest(req: Request, mint = registered.forRequest): GatewayClient {
  const userId = operatorUserId(req);
  if (!userId || !mint) return new GatewayClient(null);
  return new GatewayClient(operatorTokenSource(userId, () => mint(req)));
}

/** As `gatewayClientForRequest`, for call sites that hold a user id rather
 *  than the request. */
export function gatewayClientForUser(userId: string | null, mint = registered.forUser): GatewayClient {
  if (!userId || !mint) return new GatewayClient(null);
  return new GatewayClient(operatorTokenSource(userId, () => mint(userId)));
}

/** The operator's principal JWT for a request, or null when the request
 *  acts for nobody / no minter is wired. For routes that must refuse rather
 *  than fall back (OAuth consent). */
export async function mintOperatorTokenFor(req: Request, mint = registered.forRequest): Promise<string | null> {
  if (!operatorUserId(req) || !mint) return null;
  return mint(req);
}
