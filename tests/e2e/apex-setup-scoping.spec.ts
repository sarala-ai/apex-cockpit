import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse } from "@playwright/test";

/**
 * E2E: APEX-tower setup / scoping (§1 Org → Company → GCP-project + repo scoping).
 *
 * Verifies where the Org/Company/GCP-scoping flow has actually LANDED:
 *   - Companies (Bloom / FinPilot / APEX) create via the fork's companies API.
 *   - The `/setup/*` cloud-discovery routes are wired (shell gcloud/gh).
 *   - The "Cloud (APEX)" section renders on Company Settings with auth status.
 *   - A product (project) is bindable in the Cloud product picker.
 *
 * The `.skip` tests below document the parts that are NOT built yet (a persisted
 * Org entity; org-level and company-level GCP scoping — today binding is at the
 * product/project level via `projects.env`). They are the spec of "done".
 *
 * Runs in local_trusted mode against the throwaway e2e server (see
 * playwright.config.ts). Discovery routes reflect whatever gcloud/gh auth the
 * host has; assertions on them are tolerant (route is wired ⇒ pass), since CI
 * has no gcloud.
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

test.describe("APEX setup — Org / Company / GCP scoping (§1)", () => {
  test.setTimeout(120_000);

  test("companies for Bloom / FinPilot / APEX create via the companies API", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const names = ["Bloom", "FinPilot", "APEX"];
    const created = [];
    for (const name of names) {
      const c = await createCompany(board, `${name} ${Date.now()}`);
      expect(c.id).toBeTruthy();
      created.push(c);
    }
    expect(created).toHaveLength(3);
    await board.dispose();
  });

  test("cloud-discovery routes are wired and respond", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    // Each route must be mounted and return its documented shape. Content depends
    // on host gcloud/gh auth, so we assert the route is wired, not that it's authed.
    const auth = await board.get("/api/setup/auth");
    await expectOk(auth, "GET /setup/auth");
    const authBody = (await auth.json()) as { google?: unknown; github?: unknown };
    expect(authBody).toHaveProperty("google");
    expect(authBody).toHaveProperty("github");

    for (const path of ["/api/setup/gcp/orgs", "/api/setup/github/orgs", "/api/setup/gcp/projects"]) {
      const r = await board.get(path);
      await expectOk(r, `GET ${path}`);
      const body = (await r.json()) as Record<string, unknown>;
      // Shape is `{ <items>: [...], source }` even when discovery is empty/unauthed.
      expect(body).toHaveProperty("source");
    }
    await board.dispose();
  });

  // Company Settings renders the APEX Org/scoping + Cloud sections. The settings
  // route is company-scoped by the company's issuePrefix (`/{PREFIX}/company/settings`),
  // and the throwaway server serves a fresh `ui/dist` (the webServer builds the UI
  // first — see playwright.config.ts). Seed the selected company in localStorage so
  // CompanyContext resolves it deterministically.
  test("Company Settings renders the APEX Org/scoping + Cloud sections", async ({ page }) => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(board, `Cloud UI ${Date.now()}`);
    await board.dispose();

    await page.goto("/");
    await page.evaluate((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);

    // Company-scoped settings URL: `/{issuePrefix}/company/settings`.
    await page.goto(`/${company.issuePrefix}/company/settings`);

    // Org/scoping section (this slice) + the product-level Cloud section both render
    // once a company is selected.
    await expect(page.getByTestId("apex-org-section")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("apex-cloud-section")).toBeVisible();
    await expect(page.getByTestId("apex-auth-google")).toBeVisible();
    await expect(page.getByTestId("apex-auth-github")).toBeVisible();
    await expect(page.getByTestId("apex-product-picker")).toBeVisible();
  });

  // --- NOT BUILT YET — these encode the target scoping model (§1 aspiration) ---

  test("Org 'Sarala' persists as a first-class entity grouping companies", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const orgRes = await board.post("/api/orgs", { data: { name: `Sarala ${Date.now()}` } });
    await expectOk(orgRes, "POST /orgs");
    const { org } = (await orgRes.json()) as { org: { id: string; name: string } };
    expect(org.id).toBeTruthy();

    const listRes = await board.get("/api/orgs");
    await expectOk(listRes, "GET /orgs");
    const listBody = (await listRes.json()) as { orgs: { id: string }[] };
    expect(listBody.orgs.some((o) => o.id === org.id)).toBe(true);

    const company = await createCompany(board, `Bloom ${Date.now()}`);
    const linkRes = await board.post(`/api/orgs/${org.id}/companies`, { data: { companyId: company.id } });
    await expectOk(linkRes, "link company to org");
    const underRes = await board.get(`/api/orgs/${org.id}/companies`);
    await expectOk(underRes, "GET /orgs/:id/companies");
    const underBody = (await underRes.json()) as { companies: { id: string; orgId: string }[] };
    expect(underBody.companies.some((c) => c.id === company.id && c.orgId === org.id)).toBe(true);
    await board.dispose();
  });

  test("GCP projects + repos persist as a COMPANY-level scope binding", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(board, `FinPilot ${Date.now()}`);
    const gcpProjects = ["sarala-finpilot-dev", "sarala-finpilot-prod"];
    const githubRepos = ["sarala-ai/finpilot"];
    const putRes = await board.put(`/api/apex/scope/company/${company.id}/cloud-binding`, {
      data: { gcpProjects, githubRepos },
    });
    await expectOk(putRes, "PUT company cloud-binding");
    const getRes = await board.get(`/api/apex/scope/company/${company.id}/cloud-binding`);
    await expectOk(getRes, "GET company cloud-binding");
    const body = (await getRes.json()) as { gcpProjects: string[]; githubRepos: string[] };
    expect(body.gcpProjects).toEqual(gcpProjects);
    expect(body.githubRepos).toEqual(githubRepos);
    await board.dispose();
  });

  test("GCP projects scope at ORG level (above company)", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const orgRes = await board.post("/api/orgs", { data: { name: `Sarala Org ${Date.now()}` } });
    await expectOk(orgRes, "POST /orgs");
    const { org } = (await orgRes.json()) as { org: { id: string } };
    const gcpProjects = ["sarala-shared-infra"];
    const putRes = await board.put(`/api/apex/scope/org/${org.id}/cloud-binding`, {
      data: { gcpProjects, githubRepos: [] },
    });
    await expectOk(putRes, "PUT org cloud-binding");
    const getRes = await board.get(`/api/apex/scope/org/${org.id}/cloud-binding`);
    await expectOk(getRes, "GET org cloud-binding");
    const body = (await getRes.json()) as { gcpProjects: string[] };
    expect(body.gcpProjects).toEqual(gcpProjects);
    await board.dispose();
  });
});
