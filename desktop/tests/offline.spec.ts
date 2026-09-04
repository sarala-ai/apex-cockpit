import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { launchDesktopApp, makeUserDataDir, seedConfig } from "./helpers/launch";

// Offline product-validator tier: no network, no stored credential. Proves the
// app boots to a real sign-in screen (never a blank/crashed window), that
// config on-disk behavior matches what main.ts documents (defaults on first
// read, hand edits honored), and that the preload bridge exposes the surface
// the cockpit renderer depends on — all reachable with the app fully signed
// out, so no test account or network access is required.

test.describe("desktop offline", () => {
  test("launches to the sign-in view with its sign-in affordance", async () => {
    const { app } = await launchDesktopApp();
    try {
      const window = await app.firstWindow();
      await expect(window).toHaveTitle(/sign in/i);
      expect(window.url()).toContain("signin.html");
      await expect(window.getByRole("button", { name: /sign in with apex/i })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("config file is created with defaults on first read", async () => {
    const userDataDir = makeUserDataDir();
    const configFile = path.join(userDataDir, "apex-desktop-config.json");
    expect(fs.existsSync(configFile)).toBe(false);

    const { app } = await launchDesktopApp({ userDataDir });
    try {
      const window = await app.firstWindow();
      // getConfig() is the first thing that reads config on disk (the
      // sign-in path never touches it); it lazily writes defaults on a miss.
      const config = await window.evaluate(() => (window as any).apexDesktop.getConfig());
      expect(config).toEqual({
        mode: "remote",
        cockpitUrl: "https://apex-cockpit-5ixbpif2cq-el.a.run.app",
      });

      expect(fs.existsSync(configFile)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      expect(onDisk).toEqual(config);
    } finally {
      await app.close();
    }
  });

  test("a hand-edited config file is honored on next launch", async () => {
    const userDataDir = makeUserDataDir();
    seedConfig(userDataDir, { mode: "local", cockpitUrl: "http://127.0.0.1:3232" });

    const { app } = await launchDesktopApp({ userDataDir });
    try {
      const window = await app.firstWindow();
      const config = await window.evaluate(() => (window as any).apexDesktop.getConfig());
      expect(config).toEqual({ mode: "local", cockpitUrl: "http://127.0.0.1:3232" });
    } finally {
      await app.close();
    }
  });

  test("preload bridge exposes the expected surface on the sign-in page", async () => {
    const { app } = await launchDesktopApp();
    try {
      const window = await app.firstWindow();
      const surface = await window.evaluate(() => {
        const api = (window as any).apexDesktop;
        return {
          hasGetConfig: typeof api?.getConfig === "function",
          hasAuth: typeof api?.auth === "object" && api.auth !== null,
          hasToken: typeof api?.token === "object" && api.token !== null,
          hasCloudAuth: typeof api?.cloudAuth === "object" && api.cloudAuth !== null,
          claudeConnectMethods: api?.claudeConnect ? Object.keys(api.claudeConnect) : [],
          hasWorkstationReport: typeof api?.workstation?.report === "function",
          hasRunner: typeof api?.runner === "object" && api.runner !== null,
        };
      });
      expect(surface.hasGetConfig).toBe(true);
      expect(surface.hasAuth).toBe(true);
      expect(surface.hasToken).toBe(true);
      expect(surface.hasCloudAuth).toBe(true);
      expect(surface.claudeConnectMethods).toEqual(
        expect.arrayContaining(["start", "submitCode", "cancel", "onState"]),
      );
      expect(surface.hasWorkstationReport).toBe(true);
      expect(surface.hasRunner).toBe(true);
    } finally {
      await app.close();
    }
  });

  // token.set's refusal path requires safeStorage.isEncryptionAvailable() to
  // report false, which depends on the OS keychain state Electron sees at
  // runtime — not something this suite can force from the outside. Skipped
  // rather than faked; see release-gate.md.
  test.skip("token.set refuses when OS encryption is unavailable — not testable here", () => {});

  test("claudeConnect.start({}) with neither orgId nor companyId fails", async () => {
    const { app } = await launchDesktopApp();
    try {
      const window = await app.firstWindow();
      const result = await window.evaluate(() => (window as any).apexDesktop.claudeConnect.start({}));
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test("workstation.report() while signed out fails", async () => {
    const { app } = await launchDesktopApp();
    try {
      const window = await app.firstWindow();
      const result = await window.evaluate(() => (window as any).apexDesktop.workstation.report());
      expect(result.ok).toBe(false);
    } finally {
      await app.close();
    }
  });
});
