import { describe, expect, it, vi } from "vitest";
import {
  COCKPIT_SYSTEM_SUBJECT,
  buildCockpitSystemClaims,
  createCachedTokenSource,
  jwtExpiryMs,
  mintCockpitSystemJwt,
} from "./mint-system-jwt.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("buildCockpitSystemClaims", () => {
  it("is a verified, admin, operator-less principal named after the issuer host", () => {
    const claims = buildCockpitSystemClaims("https://apex-cockpit-abc.a.run.app/");
    expect(claims.sub).toBe(COCKPIT_SYSTEM_SUBJECT);
    expect(claims.principalKind).toBe("cockpit_system");
    expect(claims.email).toBe("cockpit-system@apex-cockpit-abc.a.run.app");
    expect(claims.email_verified).toBe(true);
    expect(claims.instanceAdmin).toBe(true);
    expect(claims.idp).toBeNull();
    expect(claims.name).toBeNull();
    expect(claims.companyId).toBeNull();
    expect(claims.companies).toEqual([]);
    expect(claims.teams).toEqual([]);
  });

  it("falls back to localhost without a usable issuer", () => {
    expect(buildCockpitSystemClaims(null).email).toBe("cockpit-system@localhost");
    expect(buildCockpitSystemClaims("not a url").email).toBe("cockpit-system@localhost");
  });
});

describe("mintCockpitSystemJwt", () => {
  it("signs the system claims through the principal signer", async () => {
    const signJWT = vi.fn(async (_input: { body: { payload: Record<string, unknown> } }) => ({ token: "tok" }));
    const token = await mintCockpitSystemJwt({ api: { signJWT } }, "https://cockpit.example");
    expect(token).toBe("tok");
    expect(signJWT.mock.calls[0]![0].body.payload).toMatchObject({
      sub: COCKPIT_SYSTEM_SUBJECT,
      instanceAdmin: true,
      email_verified: true,
    });
  });

  it("throws when the signer returns no token", async () => {
    const signJWT = vi.fn(async () => ({ token: "" }));
    await expect(mintCockpitSystemJwt({ api: { signJWT } }, null)).rejects.toThrow(/no token/);
  });
});

describe("jwtExpiryMs", () => {
  it("reads exp in milliseconds and tolerates malformed tokens", () => {
    expect(jwtExpiryMs(fakeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
    expect(jwtExpiryMs(fakeJwt({}))).toBeNull();
    expect(jwtExpiryMs("garbage")).toBeNull();
  });
});

describe("createCachedTokenSource", () => {
  it("mints once while fresh and re-mints inside the refresh margin", async () => {
    let now = 1_000_000_000_000;
    let n = 0;
    const mint = vi.fn(async () => fakeJwt({ exp: Math.floor(now / 1000) + 900, n: ++n }));
    const source = createCachedTokenSource(mint, { refreshMarginMs: 60_000, now: () => now });

    const first = await source();
    expect(await source()).toBe(first);
    expect(mint).toHaveBeenCalledTimes(1);

    now += 900_000 - 30_000;
    const second = await source();
    expect(second).not.toBe(first);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent mints into one", async () => {
    const mint = vi.fn(async () => fakeJwt({ exp: Math.floor(Date.now() / 1000) + 900 }));
    const source = createCachedTokenSource(mint);
    const [a, b] = await Promise.all([source(), source()]);
    expect(a).toBe(b);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("yields null on a mint failure and retries on the next call", async () => {
    const mint = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("signer down"))
      .mockResolvedValueOnce(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 900 }));
    const source = createCachedTokenSource(mint);
    expect(await source()).toBeNull();
    expect(await source()).toMatch(/^eyJ/);
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
