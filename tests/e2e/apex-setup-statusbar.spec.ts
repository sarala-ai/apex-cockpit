import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse } from "@playwright/test";

/**
 * E2E: apex-tower persistent setup status bar (SetupStatusBar).
 *
 * The bar is mounted globally (App shell), polls the STUBBED `GET /setup/state`
 * detector, and renders live, color-coded indicators + a dismissible startup
 * prompt when setup is incomplete. Same stub/company conventions as
 * apex-setup-wizard.spec.ts — no live gcloud/gateway/Google.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function expectOk(res: APIResponse, label: string) {
  if (!res.ok()) throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
}

async function createCompany(board: APIRequestContext, name: string) {
  const res = await board.post("/api/companies", { data: { name } });
  await expectOk(res, `create company ${name}`);
  return (await res.json()) as { id: string; name: string; issuePrefix: string };
}

const COMPLETE = {
  auth: { gcloud: "ok", gh: "ok", adc: "ok" },
  org: { present: true, id: "org-1" },
  membership: { present: true, role: "owner", status: "active" },
  companies: { count: 1, ids: ["c-1"] },
  scoping: { orgProjectsBound: true, orgReposBound: true, companyProjectsBound: true, companyReposBound: true },
  orgGithub: { appInstalled: true, wifConfigured: true },
  oauthClient: { configured: true },
  gateway: { reachable: true },
  mcpServers: { registered: ["gworkspace"] },
};

const FRESH = {
  auth: { gcloud: "missing", gh: "ok", adc: "missing" },
  org: { present: false },
  membership: { present: false },
  companies: { count: 0, ids: [] },
  scoping: { orgProjectsBound: false, orgReposBound: false, companyProjectsBound: false, companyReposBound: false },
  orgGithub: { appInstalled: false, wifConfigured: false },
  oauthClient: { configured: false },
  gateway: { reachable: false },
  mcpServers: { registered: [] },
};

/** Land on a company dashboard (any normal page) with the detector stubbed, so
 *  the globally-mounted status bar renders. */
async function gotoWithState(page: import("@playwright/test").Page, state: unknown) {
  const board = await pwRequest.newContext({ baseURL: BASE_URL });
  const company = await createCompany(board, `Bar ${Date.now()}`);
  await board.dispose();

  await page.route("**/api/setup/state**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) }),
  );

  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/dashboard`);
  await expect(page.getByTestId("setup-status-bar")).toBeVisible({ timeout: 30_000 });
}

test.describe("APEX setup status bar", () => {
  test.setTimeout(120_000);

  test("renders all indicators and reflects a FRESH (incomplete) state", async ({ page }) => {
    await gotoWithState(page, FRESH);
    const bar = page.getByTestId("setup-status-bar");
    await expect(bar).toHaveAttribute("data-complete", "0");

    // The dashboard route renders inside Layout (with the left sidebar), so the
    // bar must be offset to start at the sidebar's right edge — not lay on top
    // of it — via the --app-sidebar-width var SidebarShell publishes.
    const sidebarWidth = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width").trim(),
    );
    expect(sidebarWidth).not.toBe("");
    expect(sidebarWidth).not.toBe("0px");
    const barLeft = await bar.evaluate((el) => getComputedStyle(el).left);
    expect(barLeft).toBe(sidebarWidth);

    // The sidebar's bottom account-menu control must be fully clear of the bar
    // (not clipped/overlapped) — the bar's left edge starts exactly where the
    // sidebar ends, so their boxes never overlap on the x-axis.
    const accountTrigger = page.getByRole("button", { name: "Open account menu" });
    await expect(accountTrigger).toBeVisible();
    const [accountBox, barBox] = await Promise.all([accountTrigger.boundingBox(), bar.boundingBox()]);
    expect(accountBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    if (accountBox && barBox) {
      expect(accountBox.x + accountBox.width).toBeLessThanOrEqual(barBox.x + 1);
    }

    // Every indicator present.
    for (const key of ["gcloud", "github", "adc", "org", "oauth", "gateway", "mcp"]) {
      await expect(page.getByTestId(`setup-status-${key}`)).toBeVisible();
    }
    // gcloud missing → bad; github ok → ok; gateway unreachable → warn.
    await expect(page.getByTestId("setup-status-gcloud")).toHaveAttribute("data-tone", "bad");
    await expect(page.getByTestId("setup-status-github")).toHaveAttribute("data-tone", "ok");
    await expect(page.getByTestId("setup-status-gateway")).toHaveAttribute("data-tone", "warn");
    // MCP muted at zero.
    await expect(page.getByTestId("setup-status-mcp")).toHaveAttribute("data-tone", "muted");
    // Summary shows an amber "Setup: n/m" (not the ✓ state).
    await expect(page.getByTestId("setup-status-summary")).toContainText(/Setup:\s*\d+\/\d+/);
  });

  test("reads all-green + Setup ✓ when complete, and shows no startup prompt", async ({ page }) => {
    await gotoWithState(page, COMPLETE);
    const bar = page.getByTestId("setup-status-bar");
    await expect(bar).toHaveAttribute("data-complete", "1");
    await expect(page.getByTestId("setup-status-summary")).toContainText("Setup ✓");
    await expect(page.getByTestId("setup-status-gcloud")).toHaveAttribute("data-tone", "ok");
    await expect(page.getByTestId("setup-status-mcp")).toHaveAttribute("data-tone", "ok");
    // Complete → the nag never appears.
    await expect(page.getByTestId("setup-startup-prompt")).toHaveCount(0);
  });

  test("startup prompt appears when incomplete and can be dismissed for the session", async ({ page }) => {
    await gotoWithState(page, FRESH);
    const prompt = page.getByTestId("setup-startup-prompt");
    await expect(prompt).toBeVisible();
    await page.getByTestId("setup-startup-dismiss").click();
    await expect(prompt).toHaveCount(0);
    // Dismissal persists across navigation (sessionStorage), bar still present.
    await page.reload();
    await expect(page.getByTestId("setup-status-bar")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("setup-startup-prompt")).toHaveCount(0);
  });

  test("clicking an indicator routes to the setup wizard", async ({ page }) => {
    await gotoWithState(page, FRESH);
    await page.getByTestId("setup-status-gcloud").click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByTestId("apex-setup-wizard")).toBeVisible({ timeout: 30_000 });
  });
});
