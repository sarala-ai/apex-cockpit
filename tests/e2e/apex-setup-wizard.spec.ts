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

// Org exists, actor authed, but is only a pending member (awaiting approval).
const PENDING_MEMBER = {
  auth: { gcloud: "ok", gh: "ok", adc: "ok" },
  org: { present: true, id: "org-1" },
  membership: { present: true, role: "member", status: "pending" },
  companies: { count: 1, ids: ["c-1"] },
  scoping: { orgProjectsBound: true, orgReposBound: true, companyProjectsBound: true, companyReposBound: true },
  orgGithub: { appInstalled: true, wifConfigured: true },
  oauthClient: { configured: false },
  gateway: { reachable: false },
  mcpServers: { registered: [] },
};

// A reviewer: identity connected, but no cloud/repo — cloud steps are skipped.
const REVIEWER = {
  auth: { gcloud: "ok", gh: "ok", adc: "ok" },
  org: { present: true, id: "org-1" },
  membership: { present: true, role: "reviewer", status: "active" },
  companies: { count: 0, ids: [] },
  scoping: { orgProjectsBound: false, orgReposBound: false, companyProjectsBound: false, companyReposBound: false },
  orgGithub: { appInstalled: false, wifConfigured: false },
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

/** Drive the TOP-LEVEL `/setup` route — reachable with zero companies/org (the
 *  identity-first bootstrap entry). No company is selected. */
async function gotoTopLevelSetup(page: import("@playwright/test").Page, state: unknown) {
  await page.route("**/api/setup/state**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) }),
  );
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("paperclip.selectedCompanyId"));
  await page.goto("/setup");
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
    // Every required step across the org→company spine reads done.
    for (const key of [
      "auth",
      "org",
      "orgCloud",
      "orgGithub",
      "companyCloud",
      "companyRepos",
      "oauthClient",
      "gateway",
      "mcpServers",
      "connect",
    ]) {
      await expect(page.getByTestId(`wizard-step-${key}`)).toHaveAttribute("data-status", "done");
    }
  });

  test("renders the cloud-first org→company spine steps with their bodies", async ({ page }) => {
    // Org present + identity green so the org/company cloud steps render their
    // embedded scoping editor (not the "create the org first" gate note).
    await gotoWizard(page, COMPLETE);

    // Org-cloud step embeds the org-scope binding editor.
    await page.getByTestId("wizard-step-orgCloud").getByRole("button").first().click();
    await expect(page.getByTestId("wizard-step-orgCloud").getByTestId("apex-org-section")).toBeVisible();

    // Org-GitHub step is a guided App + WIF step (single org pool/provider copy).
    await page.getByTestId("wizard-step-orgGithub").getByRole("button").first().click();
    const gh = page.getByTestId("wizard-step-orgGithub").getByTestId("wizard-guided-step");
    await expect(gh).toBeVisible();
    await expect(gh.getByText(/Workload Identity Federation/i)).toBeVisible();

    // Company-cloud step embeds the company-scope binding editor.
    await page.getByTestId("wizard-step-companyCloud").getByRole("button").first().click();
    await expect(
      page.getByTestId("wizard-step-companyCloud").getByTestId("apex-org-section"),
    ).toBeVisible();
  });

  test("a guided (not-yet-built) step exposes guide + re-check", async ({ page }) => {
    await gotoWizard(page, FRESH);
    // Identity IS green here so the OAuth-client step is unlocked. Use a state
    // where auth is complete so the gate doesn't shadow the guided body.
    await gotoWizard(page, { ...FRESH, auth: { gcloud: "ok", gh: "ok", adc: "ok" } });
    await page.getByTestId("wizard-step-oauthClient").getByRole("button").first().click();
    const body = page.getByTestId("wizard-step-oauthClient").getByTestId("wizard-guided-step");
    await expect(body).toBeVisible();
    await expect(body.getByRole("button", { name: /re-check/i })).toBeVisible();
  });

  test("empty DB → bootstrap-as-owner branch banner", async ({ page }) => {
    await gotoWizard(page, FRESH);
    const branch = page.getByTestId("wizard-branch");
    await expect(branch).toHaveAttribute("data-branch", "branch-bootstrap-owner");
    await expect(branch.getByText(/org owner/i)).toBeVisible();
  });

  test("identity is a hard gate — downstream steps are blocked until gcloud+gh green", async ({ page }) => {
    // FRESH has gcloud missing → the OAuth-client step body shows the auth gate,
    // not its guide.
    await gotoWizard(page, FRESH);
    await page.getByTestId("wizard-step-oauthClient").getByRole("button").first().click();
    await expect(page.getByTestId("wizard-step-oauthClient").getByTestId("wizard-auth-gate")).toBeVisible();
    await expect(page.getByTestId("wizard-step-oauthClient").getByTestId("wizard-guided-step")).toHaveCount(0);
  });

  test("org exists + pending membership → awaiting-approval branch", async ({ page }) => {
    await gotoWizard(page, PENDING_MEMBER);
    await expect(page.getByTestId("wizard-branch")).toHaveAttribute("data-branch", "branch-awaiting-approval");
  });

  test("reviewer role → cloud steps are skipped, not pending", async ({ page }) => {
    await gotoWizard(page, REVIEWER);
    // Cloud steps drop out of the required set for a reviewer.
    await expect(page.getByTestId("wizard-step-gateway")).toHaveAttribute("data-status", "skipped");
    await expect(page.getByTestId("wizard-step-oauthClient")).toHaveAttribute("data-status", "skipped");
    // Identity (non-cloud) is still done → the wizard reads complete for this role.
    await expect(page.getByTestId("wizard-complete")).toBeVisible();
  });

  test("top-level /setup renders with no company selected", async ({ page }) => {
    await gotoTopLevelSetup(page, FRESH);
    await expect(page.getByTestId("apex-setup-wizard")).toBeVisible();
    await expect(page.getByTestId("wizard-branch")).toHaveAttribute("data-branch", "branch-bootstrap-owner");
  });
});
