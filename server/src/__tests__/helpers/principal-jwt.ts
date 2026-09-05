/**
 * Test-side stand-in for the better-auth jwt plugin: an Ed25519 keypair and
 * a signer producing the exact compact-JWS shape the plugin emits (EdDSA,
 * `kid` in the header), so the cockpit's own verifier is exercised for real
 * rather than mocked.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { createPrincipalJwtVerifier, type PrincipalJwks, type PrincipalJwtVerifier } from "../../auth/verify-principal-jwt.js";

export const TEST_ISSUER = "https://cockpit.example.run.app";

export interface TestPrincipalKey {
  kid: string;
  privateKey: KeyObject;
  jwks: PrincipalJwks;
  verifier: PrincipalJwtVerifier;
}

export function testPrincipalKey(kid = "k1", issuer: string | null = TEST_ISSUER): TestPrincipalKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const jwks: PrincipalJwks = { keys: [{ ...jwk, kid, alg: "EdDSA" }] };
  return { kid, privateKey, jwks, verifier: createPrincipalJwtVerifier({ getJwks: async () => jwks, issuer }) };
}

function b64(v: unknown) {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

export function signPrincipalJwt(
  key: Pick<TestPrincipalKey, "kid" | "privateKey">,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid: key.kid },
): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = cryptoSign(null, Buffer.from(input, "utf8"), key.privateKey).toString("base64url");
  return `${input}.${sig}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Claims as mint-principal-jwt.ts + the plugin produce them for an operator. */
export function operatorClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "user-1",
    email: "op@example.com",
    email_verified: true,
    name: null,
    idp: null,
    instanceAdmin: false,
    companyId: "c1",
    companies: [{ id: "c1", orgId: null, role: "owner", teams: [], scopes: [] }],
    teams: [],
    iss: TEST_ISSUER,
    aud: "apex-gateway",
    iat: nowSec(),
    exp: nowSec() + 600,
    ...overrides,
  };
}

/** Claims as mint-system-jwt.ts buildCockpitSystemClaims produces. */
export function cockpitSystemClaims(overrides: Record<string, unknown> = {}) {
  return operatorClaims({
    sub: "cockpit-system",
    principalKind: "cockpit_system",
    email: "cockpit-system@cockpit.example.run.app",
    instanceAdmin: true,
    companyId: null,
    companies: [],
    ...overrides,
  });
}
