import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse } from "@playwright/test";

/**
 * E2E: apex-tower onboarding wizard shell.
 *
 * Drives the wizard (`/{issuePrefix}/setup`) against the throwaway e2e server. The
 * detector `GET /setup/state` is STUBBED per-test (via page.route) so the wizard's
 * checklist / active-step / complete logic is deterministic — no live gcloud, no
 * gateway, no Google consent. (Playwright is the dev-test stand-in only; external
 * Google/GCP is mocked, per docs/APEX_TOWER_ONBOARDING_WIZARD.md.)
 *
 * Company-scoped URL + fresh-`ui/dist` webServer conventions per playwright.config.ts.
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
  companies: { count: 1, ids: ["c-1"] },
  scoping: { orgBound: true, companyBound: true },
  oauthClient: { configured: true },
  gateway: { reachable: true },
  mcpServers: { registered: ["gworkspace"] },
};

const FRESH = {
  auth: { gcloud: "missing", gh: "ok", adc: "missing" },
  org: { present: false },
  companies: { count: 0, ids: [] },
  scoping: { orgBound: false, companyBound: false },
  oauthClient: { configured: false },
  gateway: { reachable: false },
  mcpServers: { registered: [] },
};

async function gotoWizard(page: import("@playwright/test").Page, state: unknown) {
  const board = await pwRequest.newContext({ baseURL: BASE_URL });
  const company = await createCompany(board, `Wizard ${Date.now()}`);
  await board.dispose();

  await page.route("**/api/setup/state**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) }),
  );

  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/setup`);
  await expect(page.getByTestId("apex-setup-wizard")).toBeVisible({ timeout: 30_000 });
}

test.describe("APEX setup wizard shell", () => {
  test.setTimeout(120_000);

  test("renders the checklist and reflects a FRESH (incomplete) state", async ({ page }) => {
    await gotoWizard(page, FRESH);
    // First incomplete required step (auth) is current; a later one is pending.
    await expect(page.getByTestId("wizard-step-auth")).toHaveAttribute("data-status", "current");
    await expect(page.getByTestId("wizard-step-gateway")).toHaveAttribute("data-status", "pending");
    // Not complete.
    await expect(page.getByTestId("wizard-complete")).toHaveCount(0);
    // Active step's body (the reauth banner) is expanded by default.
    await expect(page.getByTestId("wizard-step-auth").getByText(/Google Cloud|GitHub|expired|sign|re-authenticate/i).first()).toBeVisible();
  });

  test("shows 'setup complete' when all prerequisites pass", async ({ page }) => {
    await gotoWizard(page, COMPLETE);
    await expect(page.getByTestId("wizard-complete")).toBeVisible();
    // Every required step reads done.
    for (const key of ["auth", "org", "scoping", "oauthClient", "gateway", "mcpServers", "connect"]) {
      await expect(page.getByTestId(`wizard-step-${key}`)).toHaveAttribute("data-status", "done");
    }
  });

  test("a guided (not-yet-built) step exposes guide + re-check", async ({ page }) => {
    await gotoWizard(page, FRESH);
    // Open the OAuth-client step (a GuidedStep) and assert the guide + re-check render.
    await page.getByTestId("wizard-step-oauthClient").getByRole("button").first().click();
    const body = page.getByTestId("wizard-step-oauthClient").getByTestId("wizard-guided-step");
    await expect(body).toBeVisible();
    await expect(body.getByRole("button", { name: /re-check/i })).toBeVisible();
  });
});
