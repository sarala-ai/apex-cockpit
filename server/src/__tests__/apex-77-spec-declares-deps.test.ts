/**
 * APEX-77 — T2 integration test: gate approval writes blocker edges from
 * the spec's `dependencies` YAML front matter field.
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
import {
  loadSpecDependencyValidationError,
  writeSpecDependencyEdges,
} from "../apex/pipeline/gate-bridge.js";

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

  it("inserts a blocks row when the spec front matter names an existing ticket", async () => {
    const body = [
      "---",
      "dependencies: [APEX-26]",
      "---",
      "",
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

  // A declared dependency that cannot become an edge is a FALSE ASSURANCE: the
  // ticket reads as blocked while dispatch treats it as runnable. The gate
  // validator rejects these before approval; if one somehow reaches the writer,
  // it must fail loudly rather than write a partial blocker set.
  it("refuses to write when the spec front matter names an unknown identifier", async () => {
    const body = [
      "---",
      "dependencies: [APEX-9999]",
      "---",
      "",
      "# My Spec",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-9999",
      "",
    ].join("\n");

    const { companyId, caseId } = await makeFixture(body);

    await expect(writeSpecDependencyEdges(db, companyId, caseId)).rejects.toThrow(
      /do not resolve to issues \(APEX-9999\)/,
    );

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

  it("inserts no row when front matter has no dependencies field", async () => {
    const body = [
      "---",
      "title: My Spec",
      "---",
      "",
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

  it("refuses to write a dependency that would form a cycle", async () => {
    const body = [
      "---",
      "dependencies: [APEX-26]",
      "---",
      "",
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

    // A cycle-forming edge cannot be written, so the declaration would silently
    // not exist. Fail loudly instead of dropping it.
    await expect(writeSpecDependencyEdges(db, companyId, caseId)).rejects.toThrow(
      /would form a blocker cycle/,
    );

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
    // Still 0 — nothing was written, and the caller was told.
    expect(rows).toHaveLength(0);
  });

  // The gate validator is the mechanism that stops any of the above from ever
  // reaching the writer: a spec whose declared dependencies cannot all become
  // edges must not pass spec_review.
  describe("gate validation blocks approval before any edge is written", () => {
    it("rejects an unknown identifier with an operator-facing reason", async () => {
      const body = [
        "---",
        "dependencies: [APEX-9999]",
        "---",
        "",
        "# My Spec",
        "",
        "## Dependencies",
        "",
        "- Blocked by: APEX-9999",
        "",
      ].join("\n");

      const { companyId, caseId } = await makeFixture(body);

      const error = await loadSpecDependencyValidationError(db, companyId, caseId);
      expect(error).toMatch(/APEX-9999/);
      expect(error).toMatch(/do not exist|does not exist/);
    });

    it("rejects a dependency that would form a cycle", async () => {
      const body = [
        "---",
        "dependencies: [APEX-26]",
        "---",
        "",
        "# My Spec",
        "",
        "## Dependencies",
        "",
        "- Blocked by: APEX-26",
        "",
      ].join("\n");

      const { companyId, specIssueId, blockerIssueId, caseId } = await makeFixture(body);
      await db.insert(issueRelations).values({
        companyId,
        issueId: specIssueId,
        relatedIssueId: blockerIssueId,
        type: "blocks",
      });

      const error = await loadSpecDependencyValidationError(db, companyId, caseId);
      expect(error).toMatch(/blocker cycle/);
      expect(error).toMatch(/APEX-26/);
    });

    it("passes a spec whose declared dependency resolves cleanly", async () => {
      const body = [
        "---",
        "dependencies: [APEX-26]",
        "---",
        "",
        "# My Spec",
        "",
        "## Dependencies",
        "",
        "- Blocked by: APEX-26",
        "",
      ].join("\n");

      const { companyId, caseId } = await makeFixture(body);

      await expect(
        loadSpecDependencyValidationError(db, companyId, caseId),
      ).resolves.toBeNull();
    });
  });
});
