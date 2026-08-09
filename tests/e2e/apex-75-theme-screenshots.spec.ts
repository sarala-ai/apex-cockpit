import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * APEX-75 — both-mode audit evidence.
 *
 * Boots a throwaway local_trusted instance (see playwright.config.ts
 * webServer), creates a company, and captures one representative page per
 * nav plane in both themes: Work /issues, Product /design, Operations
 * /observe, AI Governance /gateway, Settings /company/settings, plus
 * /dashboard. The 12 shots are copied into the repo's screenshots/ dir as
 * APEX-75-{light|dark}-{page}.png and committed as PR evidence — the
 * "no unreadable contrast" judgment is the reviewer's, not this spec's.
 */

const SHOT_DIR = path.join(__dirname, "test-results", "apex-75-theme-shots");

const PAGES = [
  { name: "dashboard", path: "/dashboard" },
  { name: "issues", path: "/issues" },
  { name: "design", path: "/design" },
  { name: "observe", path: "/observe" },
  { name: "gateway", path: "/gateway" },
  { name: "settings", path: "/company/settings" },
];

test("captures the five nav planes plus dashboard in both themes", async ({ page }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const res = await page.request.post("/api/companies", {
    data: { name: "APEX-75 Theme QA" },
  });
  expect(res.ok()).toBe(true);
  // Board routes live under /:companyPrefix — an unprefixed /dashboard would
  // resolve "dashboard" as a company prefix and land on the not-found page.
  const { issuePrefix } = (await res.json()) as { issuePrefix: string };
  expect(issuePrefix).toBeTruthy();

  for (const theme of ["dark", "light"] as const) {
    // Registered before each navigation in this pass; the pre-paint script in
    // ui/index.html reads this key, so every page paints in `theme` directly.
    await page.addInitScript((t) => {
      window.localStorage.setItem("paperclip.theme", t);
    }, theme);

    for (const p of PAGES) {
      await page.goto(`/${issuePrefix}${p.path}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1_000);
      await page.screenshot({
        path: path.join(SHOT_DIR, `APEX-75-${theme}-${p.name}.png`),
      });
    }
  }
});
