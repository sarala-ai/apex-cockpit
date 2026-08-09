/**
 * APEX-77 — T2 integration test: gate approval writes blocker edges from
 * the spec's ## Dependencies section.
 *
 * Tests `writeSpecDependencyEdges` directly with an embedded Postgres database.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documents,
  issueDocuments,
  issueRelations,
  issues,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { writeSpecDependencyEdges } from "../apex/pipeline/gate-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping apex-77 spec-declares-deps tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("APEX-77: spec approval writes blocker edges", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex77-spec-deps-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeFixture(specBody: string) {
    const companyId = randomUUID();
    const specIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const pipelineId = randomUUID();
    const stageId = randomUUID();
    const caseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "APEX Test Co",
      issuePrefix: "APEX",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "test-user",
    });

    await db.insert(issues).values([
      {
        id: specIssueId,
        companyId,
        identifier: "APEX-77",
        title: "The spec issue",
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "test-user",
      },
      {
        id: blockerIssueId,
        companyId,
        identifier: "APEX-26",
        title: "The blocker issue",
        status: "todo",
        priority: "medium",
        responsibleUserId: "test-user",
      },
    ]);

    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      key: "test-pipeline",
      name: "Test Pipeline",
      enforceTransitions: false,
    });

    await db.insert(pipelineStages).values({
      id: stageId,
      pipelineId,
      key: "spec_review",
      name: "Spec Review",
      kind: "review",
      position: 1,
    });

    await db.insert(pipelineCases).values({
      id: caseId,
      companyId,
      pipelineId,
      stageId,
      caseKey: `case-${caseId.slice(0, 8)}`,
      title: "Test case",
    });

    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId,
      issueId: specIssueId,
      role: "origin",
    });

    const docId = randomUUID();
    await db.insert(documents).values({
      id: docId,
      companyId,
      title: "Spec",
      latestBody: specBody,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId: specIssueId,
      documentId: docId,
      key: "spec",
    });

    return { companyId, specIssueId, blockerIssueId, caseId };
  }

  it("inserts a blocks row when the spec names an existing ticket", async () => {
    const body = [
      "# My Spec",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
      "## Tasks",
      "",
      "Do things.",
    ].join("\n");

    const { companyId, specIssueId, blockerIssueId, caseId } = await makeFixture(body);

    await writeSpecDependencyEdges(db, companyId, caseId);

    const rows = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.issueId, blockerIssueId),
          eq(issueRelations.relatedIssueId, specIssueId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("inserts no row when the spec names an unknown identifier", async () => {
    const body = [
      "# My Spec",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-9999",
      "",
    ].join("\n");

    const { companyId, caseId } = await makeFixture(body);

    await writeSpecDependencyEdges(db, companyId, caseId);

    const rows = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("inserts no row when the spec says None", async () => {
    const body = [
      "# My Spec",
      "",
      "## Dependencies",
      "",
      "None",
      "",
    ].join("\n");

    const { companyId, caseId } = await makeFixture(body);

    await writeSpecDependencyEdges(db, companyId, caseId);

    const rows = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("skips a dependency that would form a cycle", async () => {
    const body = [
      "# My Spec",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
    ].join("\n");

    const { companyId, specIssueId, blockerIssueId, caseId } = await makeFixture(body);

    // Pre-insert the reverse edge: specIssue blocks blockerIssue
    await db.insert(issueRelations).values({
      companyId,
      issueId: specIssueId,
      relatedIssueId: blockerIssueId,
      type: "blocks",
    });

    // writeSpecDependencyEdges should detect the cycle and not insert the edge
    await writeSpecDependencyEdges(db, companyId, caseId);

    const rows = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.issueId, blockerIssueId),
          eq(issueRelations.relatedIssueId, specIssueId),
        ),
      );
    // Should still be 0 — the cycle-forming edge was skipped
    expect(rows).toHaveLength(0);
  });
});
