/**
 * Contract tests for the cockpit MCP secret-provisioning tools.
 *
 * The load-bearing assertion is the negative one: the minted value must not
 * appear ANYWHERE in what a tool hands back — not in a field, not nested, not
 * in an error message, not in the audit row. Everything else here (gating,
 * rotation, identity) exists to keep that property reachable.
 */
import { describe, expect, it, vi } from "vitest";
import type { LogActivityInput } from "../services/activity-log.ts";
import type { CockpitMcpJwtClaims } from "../mcp/cockpit-mcp-jwt.ts";
import { mintCockpitMcpJwt } from "../mcp/cockpit-mcp-jwt.ts";
import {
  CAP_BOARD_READ,
  CAP_SECRETS_WRITE,
  CapabilityDeniedError,
  RUN_TOKEN_FORBIDDEN_CAPABILITIES,
} from "../mcp/capabilities.ts";
import {
  listSecretDefinitions,
  provisionSecret,
  SecretsToolError,
  SECRETS_LIST_DEFINITIONS_TOOL,
  SECRETS_PROVISION_TOOL,
  type SecretsPort,
  type SecretsToolsDeps,
  type UserSecretValueView,
} from "../mcp/secrets-tools.ts";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "operator-1";
const DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";

/** Stands in for a real minted Penpot token. If this string ever shows up in a
 *  tool result, the design has failed. */
const MINTED_VALUE = "eyJhbGciOiJIUzI1NiJ9.leaked-if-you-see-me.signature";
const MINTED_ID = "44444444-4444-4444-8444-444444444444";

function userClaims(capabilities: string[]): CockpitMcpJwtClaims {
  return {
    sub: USER_ID,
    token_kind: "user",
    company_id: COMPANY_ID,
    run_id: null,
    user_id: USER_ID,
    adapter_type: null,
    granted_capabilities: capabilities,
    iat: 0,
    exp: 0,
    iss: "paperclip-test",
    aud: "cockpit-mcp",
    instance_id: "test",
  };
}

function runClaims(capabilities: string[]): CockpitMcpJwtClaims {
  return {
    ...userClaims(capabilities),
    sub: "agent-1",
    token_kind: "run",
    run_id: "run-1",
    user_id: null,
    adapter_type: "local_trusted",
  };
}

const DEFINITION = {
  id: DEFINITION_ID,
  key: "PENPOT_ACCESS_TOKEN",
  name: "Penpot access token",
  description: "Design Engineer's Penpot credential",
  status: "active",
  provider: "local_encrypted",
  usageGuidance: "Injected as PENPOT_ACCESS_TOKEN",
};

const OTHER_DEFINITION = {
  id: "55555555-5555-4555-8555-555555555555",
  key: "SOME_MANUAL_TOKEN",
  name: "Manual token",
  description: null,
  status: "active",
  provider: "local_encrypted",
  usageGuidance: null,
};

function storedValue(overrides: Partial<UserSecretValueView> = {}): UserSecretValueView {
  return {
    id: SECRET_ID,
    userSecretDefinitionId: DEFINITION_ID,
    status: "active",
    latestVersion: 1,
    provider: "local_encrypted",
    ...overrides,
  };
}

/**
 * Test double for services/secrets.ts. Records the value it was asked to store
 * so a test can prove the value reached the STORE while never reaching the
 * caller.
 */
function fakeSecrets(existing: UserSecretValueView | null): SecretsPort & {
  created: Array<{ definitionKey: string; value: string }>;
  rotated: Array<{ secretId: string; value: string }>;
} {
  const created: Array<{ definitionKey: string; value: string }> = [];
  const rotated: Array<{ secretId: string; value: string }> = [];
  return {
    created,
    rotated,
    listCurrentUserSecretValues: async () => [
      { definition: DEFINITION, secret: existing },
      { definition: OTHER_DEFINITION, secret: null },
    ],
    createCurrentUserSecretValue: async (_companyId, _ownerUserId, input) => {
      created.push({ definitionKey: input.definitionKey, value: input.value });
      return storedValue({ latestVersion: 1 });
    },
    rotateCurrentUserSecretValue: async (_companyId, _ownerUserId, secretId, input) => {
      rotated.push({ secretId, value: input.value });
      return storedValue({ latestVersion: (existing?.latestVersion ?? 1) + 1 });
    },
  };
}

function deps(
  claims: CockpitMcpJwtClaims,
  existing: UserSecretValueView | null = null,
): SecretsToolsDeps & {
  secrets: ReturnType<typeof fakeSecrets>;
  activity: LogActivityInput[];
} {
  const secrets = fakeSecrets(existing);
  const activity: LogActivityInput[] = [];
  return {
    claims,
    secrets,
    activity,
    recordActivity: async (input) => {
      activity.push(input);
      return undefined;
    },
    mint: vi.fn(async () => ({
      value: MINTED_VALUE,
      credentialId: MINTED_ID,
      expiresAt: null,
    })),
  };
}

// ─── secrets_provision: the value never leaves the server ─────────────────────

describe("secrets_provision returns metadata only", () => {
  it("stores the minted value and returns no trace of it", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]));
    const result = await provisionSecret(d, {
      companyId: COMPANY_ID,
      definitionKey: "PENPOT_ACCESS_TOKEN",
    });

    // The exact contract.
    expect(result).toEqual({
      key: "PENPOT_ACCESS_TOKEN",
      definitionId: DEFINITION_ID,
      version: 1,
      status: "active",
      action: "created",
      credentialId: MINTED_ID,
      expiresAt: null,
    });

    // No field — at any depth — holds the value.
    expect(JSON.stringify(result)).not.toContain(MINTED_VALUE);
    for (const value of Object.values(result)) {
      expect(value).not.toBe(MINTED_VALUE);
    }

    // …but the store did receive it.
    expect(d.secrets.created).toEqual([
      { definitionKey: "PENPOT_ACCESS_TOKEN", value: MINTED_VALUE },
    ]);
  });

  it("writes the same audit action the REST route writes, without the value", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]));
    await provisionSecret(d, { companyId: COMPANY_ID, definitionKey: "PENPOT_ACCESS_TOKEN" });

    expect(d.activity).toHaveLength(1);
    const row = d.activity[0]!;
    expect(row.action).toBe("user_secret_value.created");
    expect(row.entityType).toBe("secret");
    expect(row.entityId).toBe(SECRET_ID);
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe(USER_ID);
    expect(row.details).toMatchObject({ mintedBy: "penpot", via: "mcp:secrets_provision" });
    expect(JSON.stringify(row)).not.toContain(MINTED_VALUE);
  });

  it("rotates instead of erroring when a value already exists", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]), storedValue({ latestVersion: 3 }));
    const result = await provisionSecret(d, {
      companyId: COMPANY_ID,
      definitionKey: "PENPOT_ACCESS_TOKEN",
    });

    expect(result.action).toBe("rotated");
    expect(result.version).toBe(4);
    expect(d.secrets.created).toHaveLength(0);
    expect(d.secrets.rotated).toEqual([{ secretId: SECRET_ID, value: MINTED_VALUE }]);
    expect(d.activity[0]!.action).toBe("user_secret_value.rotated");
    expect(JSON.stringify(result)).not.toContain(MINTED_VALUE);
  });

  it("defaults to a non-expiring credential and passes an explicit expiry through", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]));
    await provisionSecret(d, { companyId: COMPANY_ID, definitionKey: "PENPOT_ACCESS_TOKEN" });
    expect(d.mint).toHaveBeenCalledWith("penpot", expect.not.objectContaining({ expiresAt: expect.anything() }));

    const d2 = deps(userClaims([CAP_SECRETS_WRITE]));
    await provisionSecret(d2, {
      companyId: COMPANY_ID,
      definitionKey: "PENPOT_ACCESS_TOKEN",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(d2.mint).toHaveBeenCalledWith(
      "penpot",
      expect.objectContaining({ expiresAt: "2027-01-01T00:00:00.000Z" }),
    );
  });

  it("reports an orphaned credential by id (not by value) when the store write fails", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]));
    d.secrets.createCurrentUserSecretValue = async () => {
      throw new Error("encryption key unavailable");
    };
    const err = await provisionSecret(d, {
      companyId: COMPANY_ID,
      definitionKey: "PENPOT_ACCESS_TOKEN",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SecretsToolError);
    expect((err as SecretsToolError).code).toBe("store_write_failed");
    expect((err as Error).message).toContain(MINTED_ID);
    expect((err as Error).message).toContain("revoke");
    expect((err as Error).message).not.toContain(MINTED_VALUE);
    expect(d.activity).toHaveLength(0);
  });

  it("names the available keys when the definition does not exist", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]));
    const err = await provisionSecret(d, {
      companyId: COMPANY_ID,
      definitionKey: "NOPE",
    }).catch((e: unknown) => e);
    expect((err as SecretsToolError).code).toBe("definition_not_found");
    expect((err as Error).message).toContain("PENPOT_ACCESS_TOKEN");
    expect(d.mint).not.toHaveBeenCalled();
  });

  it("refuses a definition with no server-side minter rather than guessing", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]));
    const err = await provisionSecret(d, {
      companyId: COMPANY_ID,
      definitionKey: "SOME_MANUAL_TOKEN",
    }).catch((e: unknown) => e);
    expect((err as SecretsToolError).code).toBe("definition_not_found");
    expect(d.mint).not.toHaveBeenCalled();
  });
});

// ─── secrets_list_definitions ─────────────────────────────────────────────────

describe("secrets_list_definitions", () => {
  it("returns coverage metadata and never a value", async () => {
    const d = deps(userClaims([CAP_SECRETS_WRITE]), storedValue({ latestVersion: 2 }));
    const result = await listSecretDefinitions(d, { companyId: COMPANY_ID });

    expect(result.definitions).toEqual([
      {
        key: "PENPOT_ACCESS_TOKEN",
        name: "Penpot access token",
        description: "Design Engineer's Penpot credential",
        status: "active",
        provider: "local_encrypted",
        usageGuidance: "Injected as PENPOT_ACCESS_TOKEN",
        hasValue: true,
        valueStatus: "active",
        version: 2,
        mintable: true,
      },
      {
        key: "SOME_MANUAL_TOKEN",
        name: "Manual token",
        description: null,
        status: "active",
        provider: "local_encrypted",
        usageGuidance: null,
        hasValue: false,
        valueStatus: null,
        version: null,
        mintable: false,
      },
    ]);
    // Whitelisted fields only — nothing named like a value, at any depth.
    expect(JSON.stringify(result)).not.toMatch(/"(value|token|secret|password)"\s*:/);
  });
});

// ─── Capability + identity gating ─────────────────────────────────────────────

describe("capability gating", () => {
  const cases: Array<[string, (d: SecretsToolsDeps) => Promise<unknown>]> = [
    [SECRETS_LIST_DEFINITIONS_TOOL, (d) => listSecretDefinitions(d, { companyId: COMPANY_ID })],
    [
      SECRETS_PROVISION_TOOL,
      (d) => provisionSecret(d, { companyId: COMPANY_ID, definitionKey: "PENPOT_ACCESS_TOKEN" }),
    ],
  ];

  it.each(cases)("%s without secrets:write throws the standard capability error", async (tool, call) => {
    const d = deps(userClaims([CAP_BOARD_READ]));
    const err = await call(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityDeniedError);
    expect((err as Error).message).toBe(`capability ${CAP_SECRETS_WRITE} required for tool ${tool}`);
    expect(d.mint).not.toHaveBeenCalled();
  });

  it.each(cases)("%s rejects a run-scoped token even if it carries the capability", async (_tool, call) => {
    const d = deps(runClaims([CAP_SECRETS_WRITE]));
    const err = await call(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsToolError);
    expect((err as SecretsToolError).code).toBe("operator_identity_required");
  });

  it.each(cases)("%s refuses a companyId the session is not scoped to", async (_tool, call) => {
    const d = deps({
      ...userClaims([CAP_SECRETS_WRITE]),
      company_id: "99999999-9999-4999-8999-999999999999",
    });
    const err = await call(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsToolError);
    expect((err as SecretsToolError).code).toBe("company_mismatch");
    expect(d.mint).not.toHaveBeenCalled();
  });
});

// ─── Run tokens can never carry secrets:write ─────────────────────────────────

describe("run-token capability stripping", () => {
  it("drops secrets:write at mint time however it was asked for", () => {
    const savedSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "mcp-secrets-tools-test-secret-32-chars!!";
    try {
      const token = mintCockpitMcpJwt({
        agentId: "agent-1",
        companyId: COMPANY_ID,
        runId: "run-1",
        adapterType: "local_trusted",
        grantedCapabilities: ["board:read", "board:write", CAP_SECRETS_WRITE],
      });
      expect(token).toBeTruthy();
      const claims = JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8"));
      expect(claims.granted_capabilities).toEqual(["board:read", "board:write"]);
    } finally {
      if (savedSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = savedSecret;
    }
  });

  it("keeps secrets:write on the forbidden list", () => {
    expect(RUN_TOKEN_FORBIDDEN_CAPABILITIES).toContain(CAP_SECRETS_WRITE);
  });
});
