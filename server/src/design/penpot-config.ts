/**
 * One place that answers "which Penpot, as whom" — shared by the board
 * renderer (penpot-render.ts) and the server-side access-token minter
 * (secrets/penpot-mint.ts).
 *
 * The password deliberately has NO default. It used to fall back to the
 * compose profile's standing dev password, which meant a misconfigured
 * deployment did not fail — it quietly authenticated as the dev account
 * against whatever APEX_PENPOT_URL pointed at, and the operator found out from
 * the wrong data rather than from an error. A missing credential is a
 * configuration fault and says so.
 */

export const PENPOT_ENV_KEYS = {
  url: "APEX_PENPOT_URL",
  email: "APEX_PENPOT_EMAIL",
  password: "APEX_PENPOT_PASSWORD",
  accessToken: "APEX_PENPOT_ACCESS_TOKEN",
} as const;

export class PenpotConfigError extends Error {
  readonly code = "penpot_config_missing";
  constructor(message: string) {
    super(message);
    this.name = "PenpotConfigError";
  }
}

export function penpotBaseUrl(): string {
  return (process.env[PENPOT_ENV_KEYS.url] ?? "http://localhost:9001").replace(/\/$/, "");
}

/**
 * The access token, if one is configured. Optional by design: reading Penpot
 * works with either credential, so an unset token falls back to the password
 * rather than failing.
 *
 * Prefer this over the password wherever it works. Penpot draws a hard line
 * between the two, measured against 2.16: a token authenticates data-plane
 * RPCs (`get-profile` → 200) but is refused for the token lifecycle itself
 * (`create-access-token` and `get-access-tokens` → 401 authentication-required).
 * That is a bootstrap boundary, not a missing scope — it is what stops a
 * leaked token from minting its own successors, so revoking one actually ends
 * it. The consequence for us: MINTING genuinely needs the password and nothing
 * can remove that, while everything else should never see it.
 */
export function penpotAccessToken(): string | null {
  return process.env[PENPOT_ENV_KEYS.accessToken]?.trim() || null;
}

/**
 * Resolve the service-account credentials, or throw a configuration error
 * naming the env var to set. Resolved lazily (per call, not at module load) so
 * importing either consumer never throws and a `.env` reload takes effect.
 */
export function penpotCredentials(): { email: string; password: string } {
  const email = process.env[PENPOT_ENV_KEYS.email]?.trim() || "apex-dev@penpot.local";
  const password = process.env[PENPOT_ENV_KEYS.password]?.trim();
  if (!password) {
    throw new PenpotConfigError(
      `${PENPOT_ENV_KEYS.password} is not set — Penpot login is unavailable. ` +
        `Set it to the password of the ${email} account on ${penpotBaseUrl()}.`,
    );
  }
  return { email, password };
}
