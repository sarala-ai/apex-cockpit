/**
 * Transit+json decoding and Penpot mint-error classification.
 *
 * The regression these guard: a hand-rolled "does this look like JSON?" check
 * failed to recognise transit, printed the raw body to prove it, and leaked a
 * live access token into a transcript. So the parser must handle the real shape
 * exactly, must FAIL LOUDLY (never partially) on anything else, and no error
 * message anywhere in the mint path may contain the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransitMap, requireTransitString, TransitParseError } from "../secrets/transit-json.ts";
import { mintPenpotAccessToken, PenpotMintError } from "../secrets/penpot-mint.ts";
import { PenpotConfigError, penpotCredentials } from "../design/penpot-config.ts";

// A token-shaped string that must never appear in an error message or result.
const FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake-penpot-token-payload.signature";
const FAKE_TOKEN_ID = "0e6f4c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";

/** The exact body shape Penpot 2.16 returns from create-access-token. */
function penpotCreateTokenBody(extra: unknown[] = []): unknown[] {
  return [
    "^ ",
    "~:id",
    `~u${FAKE_TOKEN_ID}`,
    "~:name",
    "apex-cockpit",
    "~:token",
    FAKE_TOKEN,
    "~:created-at",
    "~t2026-08-11T09:00:00.000Z",
    ...extra,
  ];
}

describe("transit map parsing", () => {
  it("decodes the exact create-access-token shape Penpot returns", () => {
    const map = parseTransitMap(penpotCreateTokenBody());
    expect(map).toEqual({
      id: FAKE_TOKEN_ID,
      name: "apex-cockpit",
      token: FAKE_TOKEN,
      "created-at": "2026-08-11T09:00:00.000Z",
    });
  });

  it("decodes login-with-password style maps with keyword values", () => {
    const map = parseTransitMap(["^ ", "~:id", "~uabc", "~:auth-backend", "~:penpot", "~:is-active", true]);
    expect(map).toEqual({ id: "abc", "auth-backend": "penpot", "is-active": true });
  });

  it("unescapes a literal tilde and leaves unknown tags intact", () => {
    const map = parseTransitMap(["^ ", "~:a", "~~literal", "~:b", "~Zunknown"]);
    expect(map).toEqual({ a: "~literal", b: "~Zunknown" });
  });

  it.each([
    ["plain JSON object", { token: FAKE_TOKEN }, "transit_not_a_map"],
    ["array without the map marker", ["~:token", FAKE_TOKEN], "transit_not_a_map"],
    ["a bare string", "not transit at all", "transit_not_a_map"],
    ["null", null, "transit_not_a_map"],
    ["odd entry count", ["^ ", "~:token", FAKE_TOKEN, "~:dangling"], "transit_odd_entries"],
    ["non-keyword key", ["^ ", "token", FAKE_TOKEN], "transit_bad_key"],
    ["non-string key", ["^ ", 7, FAKE_TOKEN], "transit_bad_key"],
    ["cache reference key", ["^ ", "^0", FAKE_TOKEN], "transit_unsupported_cache_ref"],
  ])("rejects %s with a classified error and no partial result", (_label, body, code) => {
    let thrown: unknown;
    try {
      parseTransitMap(body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TransitParseError);
    expect((thrown as TransitParseError).code).toBe(code);
    // The message describes the SHAPE, never the content.
    expect((thrown as TransitParseError).message).not.toContain(FAKE_TOKEN);
  });

  it("requireTransitString refuses a missing or empty field instead of returning undefined", () => {
    const map = parseTransitMap(["^ ", "~:name", "apex-cockpit", "~:token", ""]);
    expect(() => requireTransitString(map, "token")).toThrow(TransitParseError);
    expect(() => requireTransitString(map, "id")).toThrow(/missing a usable "id" field/);
  });
});

describe("penpot credentials", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("errors with the env var name when the password is unset (no dev fallback)", () => {
    delete process.env.APEX_PENPOT_PASSWORD;
    expect(() => penpotCredentials()).toThrow(PenpotConfigError);
    expect(() => penpotCredentials()).toThrow(/APEX_PENPOT_PASSWORD is not set/);
  });

  it("treats a whitespace-only password as unset", () => {
    process.env.APEX_PENPOT_PASSWORD = "   ";
    expect(() => penpotCredentials()).toThrow(PenpotConfigError);
  });
});

describe("penpot access-token minting", () => {
  const saved = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.APEX_PENPOT_URL = "http://penpot.test:9001";
    process.env.APEX_PENPOT_EMAIL = "apex-dev@penpot.local";
    process.env.APEX_PENPOT_PASSWORD = "test-password";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  function loginOk() {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "set-cookie": "auth-token=session-value; Path=/; HttpOnly" }),
      json: async () => ({ id: "profile-1" }),
    } as unknown as Response;
  }

  function jsonResponse(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
    } as unknown as Response;
  }

  it("mints a non-expiring token by default and sends no expiration key", async () => {
    fetchMock.mockResolvedValueOnce(loginOk());
    fetchMock.mockResolvedValueOnce(jsonResponse(200, penpotCreateTokenBody()));

    const minted = await mintPenpotAccessToken({ tokenName: "apex-cockpit" });
    expect(minted.value).toBe(FAKE_TOKEN);
    expect(minted.credentialId).toBe(FAKE_TOKEN_ID);
    expect(minted.expiresAt).toBeNull();

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("http://penpot.test:9001/api/rpc/command/create-access-token");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "apex-cockpit" });
    expect((init as RequestInit).headers).toMatchObject({ Cookie: "auth-token=session-value" });
  });

  it("passes expires-at through and reports the expiry Penpot echoes back", async () => {
    fetchMock.mockResolvedValueOnce(loginOk());
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, penpotCreateTokenBody(["~:expires-at", "~t2027-01-01T00:00:00.000Z"])),
    );

    const minted = await mintPenpotAccessToken({
      tokenName: "apex-cockpit",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(minted.expiresAt).toBe("2027-01-01T00:00:00.000Z");
    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body["expires-at"]).toBe("2027-01-01T00:00:00.000Z");
  });

  it("classifies a rejected login and names the env vars to check", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, {}));
    const err = await mintPenpotAccessToken({ tokenName: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PenpotMintError);
    expect((err as PenpotMintError).code).toBe("penpot_login_failed");
    expect((err as Error).message).toMatch(/APEX_PENPOT_EMAIL\/APEX_PENPOT_PASSWORD/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never reached create-access-token
  });

  it("classifies a login that returns no session cookie", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "profile-1" }));
    await expect(mintPenpotAccessToken({ tokenName: "x" })).rejects.toMatchObject({
      code: "penpot_login_failed",
    });
  });

  it("classifies a non-200 from create-access-token as an API problem, not credentials", async () => {
    fetchMock.mockResolvedValueOnce(loginOk());
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const err = await mintPenpotAccessToken({ tokenName: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PenpotMintError);
    expect((err as PenpotMintError).code).toBe("penpot_mint_failed");
    expect((err as Error).message).toMatch(/HTTP 500/);
  });

  it("classifies an undecodable body WITHOUT echoing it", async () => {
    fetchMock.mockResolvedValueOnce(loginOk());
    // Plain JSON instead of transit — the exact mismatch that caused the leak.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: FAKE_TOKEN }));
    const err = await mintPenpotAccessToken({ tokenName: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PenpotMintError);
    expect((err as PenpotMintError).code).toBe("penpot_response_malformed");
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
  });

  it("refuses a decodable map with no token field rather than returning a partial", async () => {
    fetchMock.mockResolvedValueOnce(loginOk());
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ["^ ", "~:id", `~u${FAKE_TOKEN_ID}`]));
    await expect(mintPenpotAccessToken({ tokenName: "x" })).rejects.toMatchObject({
      code: "penpot_response_malformed",
    });
  });

  it("classifies an unreachable instance against APEX_PENPOT_URL", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(mintPenpotAccessToken({ tokenName: "x" })).rejects.toMatchObject({
      code: "penpot_unreachable",
    });
  });

  it("surfaces the config error before any network call when the password is unset", async () => {
    delete process.env.APEX_PENPOT_PASSWORD;
    await expect(mintPenpotAccessToken({ tokenName: "x" })).rejects.toBeInstanceOf(PenpotConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
