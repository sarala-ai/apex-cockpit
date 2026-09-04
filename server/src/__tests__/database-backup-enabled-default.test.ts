import { describe, expect, it } from "vitest";
import { resolveDatabaseBackupEnabled } from "../config.js";

describe("resolveDatabaseBackupEnabled", () => {
  it("defaults off in authenticated (hosted) mode — Cloud SQL backups cover it", () => {
    expect(resolveDatabaseBackupEnabled("authenticated", undefined, undefined)).toBe(false);
  });

  it("defaults on in local_trusted mode", () => {
    expect(resolveDatabaseBackupEnabled("local_trusted", undefined, undefined)).toBe(true);
  });

  it("an explicit env var wins over the deployment-mode default in either direction", () => {
    expect(resolveDatabaseBackupEnabled("authenticated", "true", undefined)).toBe(true);
    expect(resolveDatabaseBackupEnabled("local_trusted", "false", undefined)).toBe(false);
  });

  it("a config-file setting wins over the deployment-mode default when no env var is set", () => {
    expect(resolveDatabaseBackupEnabled("authenticated", undefined, true)).toBe(true);
    expect(resolveDatabaseBackupEnabled("local_trusted", undefined, false)).toBe(false);
  });
});
