import { expect, test } from "@playwright/test";
import { launchDesktopApp, makeUserDataDir, seedConfig } from "./helpers/launch";

// Authenticated product-validator tier: runs the desktop app against a real
// deployed cockpit and a real board token, via the APEX_DESKTOP_TEST_BOARD_TOKEN
// test seam (desktop/src/main.ts readToken()) — no browser-approval ceremony,
// no Google SSO. Skips cleanly when the env isn't set (it won't be in CI); run
// it deliberately before a release against staging/prod. See release-gate.md
// for what this tier does and doesn't prove.

const COCKPIT_URL = process.env.APEX_DESKTOP_TEST_COCKPIT_URL;
const BOARD_TOKEN = process.env.APEX_DESKTOP_TEST_BOARD_TOKEN;

test.describe("desktop authenticated", () => {
  test.skip(
    !COCKPIT_URL || !BOARD_TOKEN,
    "requires APEX_DESKTOP_TEST_COCKPIT_URL and APEX_DESKTOP_TEST_BOARD_TOKEN",
  );

  test("signs in via the board-token seam, reaches /setup, and reports the workstation", async () => {
    const userDataDir = makeUserDataDir();
    seedConfig(userDataDir, { mode: "remote", cockpitUrl: COCKPIT_URL! });
    const { app } = await launchDesktopApp({
      userDataDir,
      env: { APEX_DESKTOP_TEST_BOARD_TOKEN: BOARD_TOKEN! },
    });
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      const cockpitOrigin = new URL(COCKPIT_URL!).origin;
      expect(window.url().startsWith(cockpitOrigin)).toBe(true);

      // ---- /setup is reachable and renders its steps -----------------------
      await window.goto(`${COCKPIT_URL}/setup`);
      // CloudAccessGate resolves the session through /api/auth/get-session,
      // which the desktop's injected Bearer satisfies; a redirect to /auth
      // means that injection regressed.
      await expect(
        window,
        "reached /auth instead of /setup: the desktop Bearer injection did not authenticate the session",
      ).not.toHaveURL(/\/auth/, { timeout: 15_000 });
      await expect(window.getByTestId("apex-setup-wizard")).toBeVisible({ timeout: 20_000 });

      // ---- status bar shows the gcloud/GitHub/ADC items ---------------------
      await expect(window.getByTestId("setup-status-bar")).toBeVisible({ timeout: 20_000 });
      for (const key of ["gcloud", "github", "adc"]) {
        await expect(window.getByTestId(`setup-status-${key}`)).toBeVisible();
      }

      // ---- the launch-time workstation report actually reached the cockpit --
      // (source = "desktop" per the PUT this app sent at startup; the GET
      // response only echoes reportedAt, which is the concrete, checkable
      // signal that the report round-tripped.)
      const report = await window.evaluate(() =>
        fetch("/api/setup/workstation-report", { headers: { accept: "application/json" } }).then((r) =>
          r.json(),
        ),
      );
      expect(report.reportedAt, "expected a workstation report submitted at app launch").toBeTruthy();
      const ageMs = Date.now() - new Date(report.reportedAt as string).getTime();
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThan(5 * 60 * 1000);

      // ---- Claude session step shows the inline ceremony start button -------
      // Only renders when window.apexDesktop.claudeConnect is present (true
      // inside this Electron window) AND an org/company exists on this
      // account — the gated tier assumes the target account already has one.
      const claudeStep = window.getByTestId("claude-session-step");
      await claudeStep.scrollIntoViewIfNeeded();
      await expect(claudeStep).toBeVisible({ timeout: 20_000 });
      await expect(window.getByTestId("claude-connect-start")).toBeVisible({ timeout: 20_000 });
    } finally {
      await app.close();
    }
  });
});
