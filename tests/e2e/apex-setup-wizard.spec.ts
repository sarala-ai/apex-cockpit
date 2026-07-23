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

/** Create a real Org (no GitHub-org mapping) via the board API. */
async function createOrg(board: APIRequestContext, name: string) {
  const res = await board.post("/api/orgs", { data: { name } });
  await expectOk(res, `create org ${name}`);
  return (await res.json()) as { org: { id: string; name: string; githubOrg: string | null } };
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

// Everything required is done EXCEPT the hardening step (orgGithub). Under the
// default `individual` posture that step is optional → setup still completes.
const INDIVIDUAL_NO_HARDENING = {
  ...COMPLETE,
  org: { present: true, id: "org-1", posture: "individual" },
  orgGithub: { appInstalled: false, wifConfigured: false },
};

// Same, but the org dialed posture up to `enterprise` → the hardening step is now
// REQUIRED, so setup is NOT complete until it's done.
const ENTERPRISE_NEEDS_HARDENING = {
  ...COMPLETE,
  org: { present: true, id: "org-1", posture: "enterprise" },
  orgGithub: { appInstalled: false, wifConfigured: false },
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
    // The active step (auth) drives the help rail — its guidance is shown there
    // (prose lives in the rail now, not stacked in the step row).
    await expect(
      page.getByTestId("wizard-help-rail").getByText(/Google Cloud|GitHub/i).first(),
    ).toBeVisible();
  });

  test("shows 'setup complete' when all prerequisites pass", async ({ page }) => {
    await gotoWizard(page, COMPLETE);
    await expect(page.getByTestId("wizard-complete")).toBeVisible();
    // Every required step across the org→company spine reads done.
    for (const key of [
      "auth",
      "org",
      "companies",
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

    // Org-GitHub step is a guided App + WIF step: the actions render inline, and
    // its WIF guidance (single org pool/provider) shows in the help rail.
    await page.getByTestId("wizard-step-orgGithub").getByRole("button").first().click();
    await expect(page.getByTestId("wizard-step-orgGithub").getByTestId("wizard-guided-step")).toBeVisible();
    await expect(
      page.getByTestId("wizard-help-rail").getByText(/keylessly/i),
    ).toBeVisible();

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

  test("identity completes on gcloud+gh even when ADC is missing (ADC gates provisioning, not identity)", async ({ page }) => {
    // The operator's real case: signed into gcloud + gh but ADC lapsed. Identity
    // must still read done so setup isn't stuck at step 1 — ADC only gates the
    // later cloud-provisioning execution.
    await gotoWizard(page, { ...FRESH, auth: { gcloud: "ok", gh: "ok", adc: "missing" } });
    await expect(page.getByTestId("wizard-step-auth")).toHaveAttribute("data-status", "done");
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

  test("ⓘ info icon focuses the help rail on that step (wide screens)", async ({ page }) => {
    await gotoWizard(page, COMPLETE);
    // Clicking a step's ⓘ shows that step's guidance in the rail without expanding it.
    await page.getByTestId("wizard-help-info-orgGithub").click();
    await expect(
      page.getByTestId("wizard-help-rail").getByText(/keylessly/i),
    ).toBeVisible();
  });

  test("ⓘ info icon opens a popover on narrow screens (rail hidden)", async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 900 });
    await gotoWizard(page, COMPLETE);
    // The rail is hidden below lg; the ⓘ opens the same content in a popover.
    await page.getByTestId("wizard-help-info-sm-orgGithub").click();
    const popover = page.getByTestId("wizard-help-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByText(/keylessly/i)).toBeVisible();
  });

  test("individual posture: the hardening (App+WIF) step is optional and doesn't block completion", async ({ page }) => {
    await gotoWizard(page, INDIVIDUAL_NO_HARDENING);
    // orgGithub is not required under individual → reads "optional", not "current".
    await expect(page.getByTestId("wizard-step-orgGithub")).toHaveAttribute("data-status", "optional");
    // Everything else required is done → setup completes without App/WIF.
    await expect(page.getByTestId("wizard-complete")).toBeVisible();
  });

  test("enterprise posture: the hardening (App+WIF) step becomes required and blocks completion", async ({ page }) => {
    await gotoWizard(page, ENTERPRISE_NEEDS_HARDENING);
    // Now required + not done → it's the current step, and setup is NOT complete.
    await expect(page.getByTestId("wizard-step-orgGithub")).toHaveAttribute("data-status", "current");
    await expect(page.getByTestId("wizard-complete")).toHaveCount(0);
  });

  test("individual posture (default): no GitHub org → informational, not a warning", async ({ page }) => {
    // A freshly created org defaults to individual posture, where personal repos
    // are expected → the missing-GitHub-org state is informational, not a warning.
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    await createOrg(board, `NoGh ${Date.now()}`);
    await board.dispose();

    await gotoWizard(page, INDIVIDUAL_NO_HARDENING);
    await page.getByTestId("wizard-step-orgCloud").getByRole("button").first().click();
    const section = page.getByTestId("wizard-step-orgCloud");
    await expect(section.getByTestId("apex-org-no-github-info")).toBeVisible();
    await expect(section.getByTestId("apex-org-no-github-warning")).toHaveCount(0);
  });

  // OrgScopingSection resolves the org as orgs[0], so operate on the actual first org.
  async function firstOrgId(board: APIRequestContext): Promise<string> {
    let orgs = ((await (await board.get("/api/orgs")).json()) as { orgs: { id: string }[] }).orgs;
    if (orgs.length === 0) {
      await createOrg(board, `Base ${Date.now()}`);
      orgs = ((await (await board.get("/api/orgs")).json()) as { orgs: { id: string }[] }).orgs;
    }
    return orgs[0].id;
  }

  test("creates a company inline in the setup step — associates to org, no Reflection Coach seed", async ({ page }) => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const orgId = await firstOrgId(board);
    // org present + identity ok + zero companies → the "Create companies" step is active.
    const state = {
      auth: { gcloud: "ok", gh: "ok", adc: "ok" },
      org: { present: true, id: orgId, posture: "individual" },
      membership: { present: true, role: "owner", status: "active" },
      companies: { count: 0, ids: [] },
      scoping: { orgProjectsBound: false, orgReposBound: false, companyProjectsBound: false, companyReposBound: false },
      orgGithub: { appInstalled: false, wifConfigured: false },
      oauthClient: { configured: false },
      gateway: { reachable: false },
      mcpServers: { registered: [] },
    };
    await gotoTopLevelSetup(page, state);

    const step = page.getByTestId("wizard-step-companies");
    const name = `AcmeInline${Date.now()}`;
    await step.getByTestId("apex-company-name-input").fill(name);
    await step.getByTestId("apex-company-create").click();

    // Appears live in the step's own company list (no /onboarding).
    await expect(page.getByTestId("apex-companies-list").getByText(name)).toBeVisible({ timeout: 15_000 });

    // Associated to the org, and created WITHOUT a seeded Reflection Coach agent.
    const created = ((await (await board.get(`/api/orgs/${orgId}/companies`)).json()) as {
      companies: { id: string; name: string }[];
    }).companies.find((c) => c.name === name);
    expect(created).toBeTruthy();
    const agentsBody = (await (await board.get(`/api/companies/${created!.id}/agents`)).json()) as unknown;
    const agents = (Array.isArray(agentsBody)
      ? agentsBody
      : ((agentsBody as { agents?: unknown[] }).agents ?? [])) as Array<{ name?: string }>;
    expect(agents.some((a) => /reflection coach/i.test(a.name ?? ""))).toBe(false);
    await board.dispose();
  });

  test("company step: per-company picker when a company exists, and no /companies loop", async ({ page }) => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const orgId = await firstOrgId(board);
    // Ensure the org has ≥1 company (create+associate via the new route).
    await expectOk(
      await board.post(`/api/orgs/${orgId}/companies`, { data: { name: `PickCo${Date.now()}` } }),
      "create+associate company",
    );
    const state = {
      auth: { gcloud: "ok", gh: "ok", adc: "ok" },
      org: { present: true, id: orgId, posture: "individual" },
      membership: { present: true, role: "owner", status: "active" },
      companies: { count: 1, ids: ["x"] },
      scoping: { orgProjectsBound: false, orgReposBound: false, companyProjectsBound: false, companyReposBound: false },
      orgGithub: { appInstalled: false, wifConfigured: false },
      oauthClient: { configured: false },
      gateway: { reachable: false },
      mcpServers: { registered: [] },
    };
    await gotoTopLevelSetup(page, state);
    const step = page.getByTestId("wizard-step-companyCloud");
    await step.getByRole("button").first().click();
    // The per-company picker shows (bind which company), and the old looping
    // "/companies" link is gone.
    await expect(step.getByTestId("apex-company-picker")).toBeVisible({ timeout: 15_000 });
    await expect(step.locator('a[href="/companies"]')).toHaveCount(0);
    await board.dispose();
  });

});
