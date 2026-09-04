import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentJwtSecretStatus } from "../startup-banner.js";

describe("resolveAgentJwtSecretStatus", () => {
  const originalAgentSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  let missingEnvFilePath: string;

  beforeEach(() => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    missingEnvFilePath = join(mkdtempSync(join(tmpdir(), "startup-banner-")), ".env.missing");
  });

  afterEach(() => {
    if (originalAgentSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalAgentSecret;
    if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
  });

  it("passes on PAPERCLIP_AGENT_JWT_SECRET", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-secret";
    expect(resolveAgentJwtSecretStatus(missingEnvFilePath, "local_trusted")).toEqual({
      status: "pass",
      message: "set",
    });
  });

  it("passes on the BETTER_AUTH_SECRET fallback every consumer already uses", () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret";
    expect(resolveAgentJwtSecretStatus(missingEnvFilePath, "local_trusted")).toEqual({
      status: "pass",
      message: "set",
    });
  });

  it("includes the onboard command in local_trusted mode when both secrets are missing", () => {
    expect(resolveAgentJwtSecretStatus(missingEnvFilePath, "local_trusted")).toEqual({
      status: "warn",
      message: "missing (run `pnpm paperclipai onboard`)",
    });
  });

  it("drops the onboard command in authenticated (hosted) mode", () => {
    expect(resolveAgentJwtSecretStatus(missingEnvFilePath, "authenticated")).toEqual({
      status: "warn",
      message: "missing",
    });
  });

  it("still warns unloaded when the fallback secret is only in the env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-banner-"));
    const envFilePath = join(dir, ".env");
    writeFileSync(envFilePath, "BETTER_AUTH_SECRET=from-file\n");
    try {
      expect(resolveAgentJwtSecretStatus(envFilePath, "local_trusted")).toEqual({
        status: "warn",
        message: `found in ${envFilePath} but not loaded`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
