import { describe, expect, it } from "vitest";
import { SECRET_FIELD_NAME_PATTERN } from "../redaction.ts";
import { SENSITIVE_ENV_KEY_RE } from "../services/secrets.ts";

/**
 * Regression guard for a real divergence: the read-side redaction list has
 * always matched a bare `token`, while the persistence-side list did not. The
 * result was a name that LOOKED handled — redacted in every API response —
 * while sitting in plaintext in adapter_config, invisible to strict mode and
 * skipped by the inline-env migration. One list, or the same bug returns.
 */
describe("sensitive env key detection", () => {
  const redactionRe = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");

  const sensitiveKeys = [
    "APEX_GATEWAY_TOKEN",
    "GITHUB_TOKEN",
    "PENPOT_PASSWORD",
    // The two names the Penpot mint path touches: the service-account password
    // it reads and the credential it writes. Both must be sensitive on the
    // storage side too, not just on display.
    "APEX_PENPOT_PASSWORD",
    "PENPOT_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "SOME_SECRET",
    "DB_CONNECTIONSTRING",
  ];

  it.each(sensitiveKeys)("treats %s as sensitive for storage as well as display", (key) => {
    expect(redactionRe.test(key)).toBe(true);
    expect(SENSITIVE_ENV_KEY_RE.test(key)).toBe(true);
  });

  it.each(["PENPOT_USER", "NODE_ENV", "APEX_PROJECT_ID"])(
    "leaves the non-secret key %s alone",
    (key) => {
      expect(SENSITIVE_ENV_KEY_RE.test(key)).toBe(false);
    },
  );
});
