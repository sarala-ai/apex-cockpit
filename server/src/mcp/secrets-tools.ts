/**
 * Cockpit MCP secret-provisioning tools.
 *
 * The one architectural rule, and the reason these tools exist:
 *
 *   A tool that RETURNS a secret can leak it. So minting and storing happen in
 *   a single server-side operation and the result carries metadata ONLY.
 *
 * This is structural, not cosmetic. Safety here does not depend on redacting a
 * tool result, on sniffing whether a response "looks malformed", or on the
 * model being well-behaved: the value simply never enters a tool result, an
 * error message or an audit row. (redaction.ts remains a net under the whole
 * server — but a net is what catches the case you missed, not the design.)
 *
 * The provoking incident: an operator minted a Penpot token by hand with curl
 * and stored it with a second curl. Penpot answers in transit+json, a
 * "don't print unless the body looks malformed" guard failed to match the
 * format, the raw body echoed into the transcript, and the token had to be
 * revoked and re-minted. Both curls are now this one tool.
 *
 * Handlers are plain functions over an injected port rather than closures over
 * `db`, so the capability gate and the "no value in the result" contract are
 * unit-testable without a database.
 */
import type { LogActivityInput } from "../services/activity-log.js";
import { CAP_SECRETS_WRITE, requireCapability } from "./capabilities.js";
import type { CockpitMcpJwtClaims } from "./cockpit-mcp-jwt.js";
import type { MintedCredential, PenpotMintSpec } from "../secrets/penpot-mint.js";
import { mintPenpotAccessToken } from "../secrets/penpot-mint.js";

export const SECRETS_LIST_DEFINITIONS_TOOL = "secrets_list_definitions";
export const SECRETS_PROVISION_TOOL = "secrets_provision";

/** Mint providers this server can drive. One member today; the shape is a
 *  discriminated union so adding a second provider is a compile error at every
 *  site that has to care, rather than a silent fallthrough. */
export const MINT_PROVIDERS = ["penpot"] as const;
export type MintProvider = (typeof MINT_PROVIDERS)[number];

/** Classified failure for the provisioning flow itself (as opposed to the
 *  provider's own PenpotMintError or the store's HttpError). */
export type SecretsToolErrorCode =
  | "company_mismatch"
  | "operator_identity_required"
  | "definition_not_found"
  | "store_write_failed";

export class SecretsToolError extends Error {
  constructor(
    public readonly code: SecretsToolErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SecretsToolError";
  }
}

// ─── Ports ────────────────────────────────────────────────────────────────────

/** The subset of services/secrets.ts this module uses. Structural on purpose:
 *  the real secretService(db) satisfies it, and a test double can too. */
export interface UserSecretDefinitionView {
  id: string;
  key: string;
  scope?: string;
  name: string;
  description: string | null;
  status: string;
  provider: string;
  usageGuidance?: string | null;
}

export interface UserSecretValueView {
  id: string;
  /** Nullable in the schema (company-scoped secrets have no definition); always
   *  populated for the user-scoped rows this module touches. */
  userSecretDefinitionId: string | null;
  status: string;
  latestVersion: number;
  provider: string;
}

export interface SecretsPort {
  listCurrentUserSecretValues(
    companyId: string,
    ownerUserId: string,
  ): Promise<Array<{ definition: UserSecretDefinitionView; secret: UserSecretValueView | null }>>;
  createCurrentUserSecretValue(
    companyId: string,
    ownerUserId: string,
    input: { definitionKey: string; value: string },
    actor: { userId: string | null; agentId: string | null },
  ): Promise<UserSecretValueView>;
  rotateCurrentUserSecretValue(
    companyId: string,
    ownerUserId: string,
    secretId: string,
    input: { value: string },
    actor: { userId: string | null; agentId: string | null },
  ): Promise<UserSecretValueView>;
}

export interface SecretsToolsDeps {
  claims: CockpitMcpJwtClaims;
  secrets: SecretsPort;
  recordActivity: (input: LogActivityInput) => Promise<unknown>;
  /** Injected so tests never reach the network. Production wiring is
   *  `defaultMintCredential` below. */
  mint?: (provider: MintProvider, spec: PenpotMintSpec) => Promise<MintedCredential>;
}

export async function defaultMintCredential(
  provider: MintProvider,
  spec: PenpotMintSpec,
): Promise<MintedCredential> {
  switch (provider) {
    case "penpot":
      return mintPenpotAccessToken(spec);
  }
}

// ─── Guards ───────────────────────────────────────────────────────────────────

/**
 * Provisioning writes a USER-scoped secret, so it needs a user to own it — and
 * a run token has none (user_id is null by construction). This is the second,
 * independent lock on the same door as RUN_TOKEN_FORBIDDEN_CAPABILITIES: even
 * if a run token somehow carried secrets:write, it still could not name an
 * owner, and ownership is not something a tool should be able to assert.
 */
function requireOperatorIdentity(claims: CockpitMcpJwtClaims, tool: string): string {
  if (claims.token_kind !== "user" || !claims.user_id) {
    throw new SecretsToolError(
      "operator_identity_required",
      `${tool} writes a user-owned secret and requires a human operator session; ` +
        `this token is run-scoped (no user identity). Provision from the cockpit UI or an ` +
        `operator MCP session instead.`,
    );
  }
  return claims.user_id;
}

function requireOwnCompany(claims: CockpitMcpJwtClaims, companyId: string, tool: string): string {
  if (companyId !== claims.company_id) {
    throw new SecretsToolError(
      "company_mismatch",
      `${tool} was called for company ${companyId} but this session is scoped to ` +
        `${claims.company_id}; re-authenticate against the intended company.`,
    );
  }
  return companyId;
}

// ─── secrets_list_definitions ─────────────────────────────────────────────────

export interface SecretDefinitionSummary {
  key: string;
  /** "org" slots are shared by every company in the org; "company" slots are local. */
  scope: "company" | "org";
  name: string;
  description: string | null;
  status: string;
  provider: string;
  usageGuidance: string | null;
  /** Coverage for the CALLING operator: is a value of theirs currently stored?
   *  Never says anything about the value itself beyond its existence. */
  hasValue: boolean;
  valueStatus: string | null;
  version: number | null;
  /** Whether secrets_provision can mint this one server-side today. */
  mintable: boolean;
}

/**
 * List the company's user-secret definitions plus the caller's own coverage.
 *
 * Fields are enumerated one at a time rather than spread from the row, so a
 * future column on user_secret_definitions or company_secrets cannot become a
 * new field in this response by accident. That whitelist is the whole reason
 * this function is more than a passthrough.
 */
export async function listSecretDefinitions(
  deps: SecretsToolsDeps,
  input: { companyId: string },
): Promise<{ definitions: SecretDefinitionSummary[] }> {
  const tool = SECRETS_LIST_DEFINITIONS_TOOL;
  requireCapability(deps.claims, CAP_SECRETS_WRITE, tool);
  const ownerUserId = requireOperatorIdentity(deps.claims, tool);
  const companyId = requireOwnCompany(deps.claims, input.companyId, tool);

  const rows = await deps.secrets.listCurrentUserSecretValues(companyId, ownerUserId);
  return {
    definitions: rows.map(({ definition, secret }) => ({
      key: definition.key,
      scope: definition.scope === "org" ? "org" : "company",
      name: definition.name,
      description: definition.description ?? null,
      status: definition.status,
      provider: definition.provider,
      usageGuidance: definition.usageGuidance ?? null,
      hasValue: secret != null,
      valueStatus: secret?.status ?? null,
      version: secret?.latestVersion ?? null,
      mintable: mintProviderForDefinitionKey(definition.key) !== null,
    })),
  };
}

/**
 * Which mint provider (if any) can produce a value for a definition.
 *
 * Keyed off the definition KEY rather than the storage `provider` column,
 * because that column names where the value is KEPT (local_encrypted) — not
 * who issues it. Deliberately a small explicit table: "guess the issuer from
 * the name" is how a tool ends up calling the wrong service with real
 * credentials.
 */
export function mintProviderForDefinitionKey(key: string): MintProvider | null {
  if (key === "PENPOT_ACCESS_TOKEN") return "penpot";
  return null;
}

// ─── secrets_provision ────────────────────────────────────────────────────────

export interface ProvisionInput {
  companyId: string;
  definitionKey: string;
  /** Defaults to the provider implied by the definition key. */
  provider?: MintProvider;
  /** Label on the provider side. Defaults to an identifiable cockpit label. */
  tokenName?: string;
  /** ISO-8601. Omitted = non-expiring; see PenpotMintSpec for why that is the
   *  default rather than a short TTL. */
  expiresAt?: string;
}

/**
 * The ONLY thing this tool returns. No `value`, no provider response, no
 * session cookie — and the type says so, so a future edit that adds one has to
 * change the declared contract in the same diff as the test that asserts it.
 */
export interface ProvisionResult {
  key: string;
  definitionId: string;
  version: number;
  status: string;
  /** "created" on first provision, "rotated" when a value already existed —
   *  rotation is the correct answer to "provision again", since
   *  versionSelector "latest" means consumers pick up the new version with no
   *  binding change. */
  action: "created" | "rotated";
  /** Non-sensitive provider-side identifier for the credential, so an operator
   *  can find and revoke this exact token later. */
  credentialId: string;
  expiresAt: string | null;
}

export async function provisionSecret(
  deps: SecretsToolsDeps,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const tool = SECRETS_PROVISION_TOOL;
  requireCapability(deps.claims, CAP_SECRETS_WRITE, tool);
  const ownerUserId = requireOperatorIdentity(deps.claims, tool);
  const companyId = requireOwnCompany(deps.claims, input.companyId, tool);

  const rows = await deps.secrets.listCurrentUserSecretValues(companyId, ownerUserId);
  const match = rows.find((row) => row.definition.key === input.definitionKey);
  if (!match) {
    throw new SecretsToolError(
      "definition_not_found",
      `no active user-secret definition with key "${input.definitionKey}" in company ${companyId} ` +
        `(available: ${rows.map((r) => r.definition.key).join(", ") || "none"}). ` +
        `Create the definition first, then provision.`,
    );
  }

  const provider = input.provider ?? mintProviderForDefinitionKey(match.definition.key);
  if (!provider) {
    throw new SecretsToolError(
      "definition_not_found",
      `definition "${match.definition.key}" has no server-side mint provider. ` +
        `Supported: ${MINT_PROVIDERS.join(", ")}. Pass \`provider\` explicitly if the key is custom.`,
    );
  }

  const mint = deps.mint ?? defaultMintCredential;
  const minted = await mint(provider, {
    tokenName: input.tokenName ?? `apex-cockpit ${match.definition.key} (${new Date().toISOString().slice(0, 10)})`,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });

  // From here the value is live at the provider. If the store write fails we
  // surface that plainly AND name the orphan by its provider-side id, because
  // the token exists whether or not we persisted it and somebody has to go
  // revoke it. Swallowing this would leave a valid credential nobody knows about.
  let stored: UserSecretValueView;
  let action: ProvisionResult["action"];
  try {
    if (match.secret) {
      action = "rotated";
      stored = await deps.secrets.rotateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        match.secret.id,
        { value: minted.value },
        { userId: ownerUserId, agentId: null },
      );
    } else {
      action = "created";
      stored = await deps.secrets.createCurrentUserSecretValue(
        companyId,
        ownerUserId,
        { definitionKey: match.definition.key, value: minted.value },
        { userId: ownerUserId, agentId: null },
      );
    }
  } catch (err) {
    throw new SecretsToolError(
      "store_write_failed",
      `minted a ${provider} credential (provider-side id ${minted.credentialId}) but failed to store it: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The credential is LIVE and orphaned — revoke id ${minted.credentialId} at the provider.`,
      { cause: err },
    );
  }

  // Same audit shape the REST route writes (routes/secrets.ts), so a value that
  // arrived through MCP is indistinguishable in the ledger from one that
  // arrived through the UI — except for the provisioning details below.
  await deps.recordActivity({
    companyId,
    actorType: "user",
    actorId: ownerUserId,
    action: action === "created" ? "user_secret_value.created" : "user_secret_value.rotated",
    entityType: "secret",
    entityId: stored.id,
    details: {
      userSecretDefinitionId: stored.userSecretDefinitionId,
      ownerUserId,
      provider: stored.provider,
      version: stored.latestVersion,
      definitionKey: match.definition.key,
      // Provenance: this value was minted by the server, not pasted by a human.
      mintedBy: provider,
      mintedCredentialId: minted.credentialId,
      mintedExpiresAt: minted.expiresAt,
      via: "mcp:secrets_provision",
    },
  });

  return {
    key: match.definition.key,
    definitionId: match.definition.id,
    version: stored.latestVersion,
    status: stored.status,
    action,
    credentialId: minted.credentialId,
    expiresAt: minted.expiresAt,
  };
}
