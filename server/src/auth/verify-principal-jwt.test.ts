import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPrincipalJwtVerifier, jwtIssuer, type PrincipalJwks } from "./verify-principal-jwt.js";

const ISSUER = "https://cockpit.example.run.app";

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { kid, privateKey, jwk: { ...jwk, kid, alg: "EdDSA" } };
}

function b64(v: unknown) {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

export function signPrincipalJwt(
  privateKey: KeyObject,
  kid: string,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid },
): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = cryptoSign(null, Buffer.from(input, "utf8"), privateKey).toString("base64url");
  return `${input}.${sig}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function operatorPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: "user-1",
    email: "op@example.com",
    email_verified: true,
    instanceAdmin: false,
    companyId: "c1",
    companies: [{ id: "c1", orgId: null, role: "owner", teams: [], scopes: [] }],
    teams: [],
    iss: ISSUER,
    aud: "apex-gateway",
    iat: nowSec(),
    exp: nowSec() + 600,
    ...overrides,
  };
}

describe("createPrincipalJwtVerifier", () => {
  const kp = keypair("k1");
  const jwks: PrincipalJwks = { keys: [kp.jwk] };
  const verifier = createPrincipalJwtVerifier({ getJwks: async () => jwks, issuer: ISSUER });

  it("accepts an operator token and maps it to an operator principal", async () => {
    const result = await verifier.verify(signPrincipalJwt(kp.privateKey, "k1", operatorPayload()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toMatchObject({
      sub: "user-1",
      principalKind: "operator",
      email: "op@example.com",
      companyId: "c1",
      instanceAdmin: false,
      iss: ISSUER,
    });
  });

  it("carries the service principal kinds through", async () => {
    const fed = await verifier.verify(
      signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ sub: "apex-gateway", principalKind: "gateway_federation", email: null, companies: [], companyId: null })),
    );
    expect(fed.ok && fed.principal.principalKind).toBe("gateway_federation");
    const sys = await verifier.verify(
      signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ sub: "cockpit-system", principalKind: "cockpit_system", instanceAdmin: true })),
    );
    expect(sys.ok && sys.principal.principalKind === "cockpit_system" && sys.principal.instanceAdmin).toBe(true);
  });

  it("rejects an expired token", async () => {
    const result = await verifier.verify(signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ exp: nowSec() - 1 })));
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed by a key that is not in the JWKS", async () => {
    const rogue = keypair("k1"); // same kid, different key — the signature must not verify
    const result = await verifier.verify(signPrincipalJwt(rogue.privateKey, "k1", operatorPayload()));
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown kid, refetching the JWKS at most once per floor", async () => {
    const getJwks = vi.fn(async () => jwks);
    const v = createPrincipalJwtVerifier({ getJwks, issuer: ISSUER, unknownKidRefetchMinMs: 60_000 });
    const other = keypair("k2");
    expect(await v.verify(signPrincipalJwt(other.privateKey, "k2", operatorPayload()))).toEqual({ ok: false, reason: "unknown_key" });
    expect(await v.verify(signPrincipalJwt(other.privateKey, "k2", operatorPayload()))).toEqual({ ok: false, reason: "unknown_key" });
    expect(getJwks).toHaveBeenCalledTimes(1);
  });

  it("picks up a rotated key on the next read", async () => {
    let current: PrincipalJwks = { keys: [kp.jwk] };
    let now = 1_000_000_000_000;
    const v = createPrincipalJwtVerifier({ getJwks: async () => current, issuer: ISSUER, now: () => now, unknownKidRefetchMinMs: 1_000 });
    const rotated = keypair("k2");
    const payload = operatorPayload({ exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000) });
    expect(await v.verify(signPrincipalJwt(kp.privateKey, "k1", payload))).toMatchObject({ ok: true });
    current = { keys: [kp.jwk, rotated.jwk] };
    now += 5_000;
    expect(await v.verify(signPrincipalJwt(rotated.privateKey, "k2", payload))).toMatchObject({ ok: true });
  });

  it("rejects the wrong audience and the wrong issuer", async () => {
    expect(await verifier.verify(signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ aud: "cockpit-mcp" })))).toEqual({
      ok: false,
      reason: "wrong_audience",
    });
    expect(await verifier.verify(signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ iss: "https://elsewhere" })))).toEqual({
      ok: false,
      reason: "wrong_issuer",
    });
    // Trailing slash / case differences are not a different issuer.
    expect(await verifier.verify(signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ iss: `${ISSUER}/` })))).toMatchObject({ ok: true });
  });

  it("skips the issuer check when none is configured", async () => {
    const v = createPrincipalJwtVerifier({ getJwks: async () => jwks, issuer: null });
    expect(await v.verify(signPrincipalJwt(kp.privateKey, "k1", operatorPayload({ iss: "http://localhost:3100" })))).toMatchObject({ ok: true });
  });

  it("refuses non-EdDSA tokens and garbage as malformed", async () => {
    expect(await verifier.verify("not.a.jwt.at.all")).toEqual({ ok: false, reason: "malformed" });
    expect(await verifier.verify("garbage")).toEqual({ ok: false, reason: "malformed" });
    const hs = signPrincipalJwt(kp.privateKey, "k1", operatorPayload(), { alg: "HS256", kid: "k1" });
    expect(await verifier.verify(hs)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("jwtIssuer", () => {
  it("reads iss unverified and tolerates junk", () => {
    expect(jwtIssuer(`${b64({ alg: "EdDSA" })}.${b64({ iss: ISSUER })}.sig`)).toBe(ISSUER);
    expect(jwtIssuer("junk")).toBeNull();
  });
});
