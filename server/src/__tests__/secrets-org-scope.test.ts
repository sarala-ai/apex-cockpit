import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  orgs,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("org-scoped user secrets", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-org-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-org-scope");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companies);
    await db.delete(orgs);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedOrg() {
    return db.insert(orgs).values({ name: `Org ${randomUUID()}` }).returning().then((rows) => rows[0]!.id);
  }

  async function seedCompany(orgId: string | null, name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      orgId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("every company in the org resolves the operator's org-scoped value; other orgs cannot", async () => {
    const orgId = await seedOrg();
    const companyA = await seedCompany(orgId, "A");
    const companyB = await seedCompany(orgId, "B");
    const otherOrgId = await seedOrg();
    const outsider = await seedCompany(otherOrgId, "Outsider");
    const operator = `operator-${randomUUID()}`;
    const svc = secretService(db);

    const definition = await svc.createOrgUserSecretDefinition(orgId, {
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      name: "Claude subscription",
    });
    expect(definition.scope).toBe("org");
    expect(definition.companyId).toBeNull();

    const value = await svc.createCurrentOrgUserSecretValue(orgId, operator, {
      definitionKey: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-org-token",
    });
    expect(value.companyId).toBeNull();
    expect(value.orgId).toBe(orgId);

    for (const companyId of [companyA, companyB]) {
      const resolved = await svc.resolveUserSecretValue(companyId, {
        definitionKey: "CLAUDE_CODE_OAUTH_TOKEN",
        responsibleUserId: operator,
      });
      expect(resolved?.value).toBe("sk-ant-oat01-org-token");
    }

    await expect(
      svc.resolveUserSecretValue(outsider, {
        definitionKey: "CLAUDE_CODE_OAUTH_TOKEN",
        responsibleUserId: operator,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // The company-facing listing surfaces the org slot with the operator's value.
    const listed = await svc.listCurrentUserSecretValues(companyA, operator);
    expect(listed.map((entry) => [entry.definition.key, entry.secret?.id])).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", value.id],
    ]);
  });

  it("a company slot shadows the org slot only for that company", async () => {
    const orgId = await seedOrg();
    const companyA = await seedCompany(orgId, "A");
    const companyB = await seedCompany(orgId, "B");
    const operator = `operator-${randomUUID()}`;
    const svc = secretService(db);

    await svc.createOrgUserSecretDefinition(orgId, { key: "GH_TOKEN", name: "GitHub (org)" });
    await svc.createCurrentOrgUserSecretValue(orgId, operator, { definitionKey: "GH_TOKEN", value: "org-gh" });

    // A same-key company definition cannot be created while the org slot is visible to the company.
    await expect(
      svc.createUserSecretDefinition(companyA, { key: "GH_TOKEN", name: "GitHub (A)", provider: "local_encrypted" }),
    ).rejects.toMatchObject({ status: 409 });

    const fromB = await svc.resolveUserSecretValue(companyB, {
      definitionKey: "GH_TOKEN",
      responsibleUserId: operator,
    });
    expect(fromB?.value).toBe("org-gh");
  });

  it("an owner holds one value per org slot and can rotate it", async () => {
    const orgId = await seedOrg();
    const companyA = await seedCompany(orgId, "A");
    const operator = `operator-${randomUUID()}`;
    const svc = secretService(db);

    await svc.createOrgUserSecretDefinition(orgId, { key: "CLAUDE_CODE_OAUTH_TOKEN", name: "Claude" });
    const first = await svc.createCurrentOrgUserSecretValue(orgId, operator, {
      definitionKey: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "v1",
    });
    await expect(
      svc.createCurrentOrgUserSecretValue(orgId, operator, { definitionKey: "CLAUDE_CODE_OAUTH_TOKEN", value: "v2" }),
    ).rejects.toMatchObject({ status: 409 });

    await svc.rotateCurrentOrgUserSecretValue(orgId, operator, first.id, { value: "v2" });
    const resolved = await svc.resolveUserSecretValue(companyA, {
      definitionKey: "CLAUDE_CODE_OAUTH_TOKEN",
      responsibleUserId: operator,
    });
    expect(resolved?.value).toBe("v2");

    const rows = await db.select().from(companySecrets).where(eq(companySecrets.ownerUserId, operator));
    expect(rows).toHaveLength(1);
  });
});
