import { expect, test, type Page } from "@playwright/test";

// Deployment smoke for the setup wizard + status bar — the surfaces whose bugs
// (unscrollable standalone /setup, missing Claude step, false identity gate)
// were only ever caught by hand. Point it at a deployed cockpit with
// PAPERCLIP_RELEASE_SMOKE_BASE_URL and a signed-in operator's email/password
// (or run against a local instance).

const ADMIN_EMAIL =
  process.env.PAPERCLIP_RELEASE_SMOKE_EMAIL ??
  process.env.SMOKE_ADMIN_EMAIL ??
  "smoke-admin@paperclip.local";
const ADMIN_PASSWORD =
  process.env.PAPERCLIP_RELEASE_SMOKE_PASSWORD ??
  process.env.SMOKE_ADMIN_PASSWORD ??
  "paperclip-smoke-password";

async function signIn(page: Page) {
  await page.goto("/");
  if (/\/auth/.test(page.url())) {
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
  }
}

test.describe("Setup wizard deployment smoke", () => {
  test("standalone /setup renders every step, is scrollable, and shows the Claude step", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/setup");

    // Header renders (the wizard mounted, not a blank/error page).
    await expect(page.getByText(/set up apex/i)).toBeVisible({ timeout: 20_000 });

    // The Claude subscription step exists — its absence was a real regression.
    const claudeStep = page.getByText(/connect claude subscription/i).first();
    await expect(claudeStep).toBeVisible({ timeout: 15_000 });

    // The standalone mount must scroll: the last step should reach the viewport.
    // (The bug: body{overflow:hidden} + no scroll container on this route.)
    await claudeStep.scrollIntoViewIfNeeded();
    await expect(claudeStep).toBeInViewport();

    // A representative later step is present (proves the full list rendered).
    await expect(page.getByText(/per-tool governance/i)).toBeVisible();
  });

  test("the Claude step is not blocked by a machine-identity gate", async ({ page }) => {
    await signIn(page);
    await page.goto("/setup");

    // Expand the Claude step and assert it is actionable, not showing the
    // "finish Connect gcloud + GitHub first" gate (that gate wrongly probed
    // the SERVER's identity on a cloud cockpit).
    const claudeStep = page.getByText(/connect claude subscription/i).first();
    await claudeStep.scrollIntoViewIfNeeded();
    await claudeStep.click();
    await expect(
      page.getByText(/finish .?Connect gcloud . GitHub.? .*to unlock this step/i),
    ).toHaveCount(0);
  });

  test("the status bar shows the Claude indicator", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard");
    // Bottom status bar carries per-prerequisite chips incl. Claude.
    await expect(page.getByText(/^Claude$/).first()).toBeVisible({ timeout: 20_000 });
  });
});
