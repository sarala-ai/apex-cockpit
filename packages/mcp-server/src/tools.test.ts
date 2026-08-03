import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function getTool(name: string) {
  const tool = createToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paperclip MCP tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds auth headers and run id to mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpdateIssue");
    await tool.execute({
      issueId: "PAP-1135",
      status: "done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("uses default company id for company-scoped list tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ id: "issue-1" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListIssues");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(response.content[0]?.text).toContain("issue-1");
  });

  it("uses default agent id for checkout requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "in_progress" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCheckoutIssue");
    await tool.execute({
      issueId: "PAP-1135",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: "22222222-2222-2222-2222-222222222222",
      expectedStatuses: ["todo", "backlog", "blocked"],
    });
  });

  it("allows create issue requests to omit status so the API applies assignee defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "issue-1", status: "todo" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateIssue");
    await tool.execute({
      title: "Assigned follow-up",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Assigned follow-up",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
      requestDepth: 0,
    });
  });

  it("defaults issue document format to markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ key: "plan", latestRevisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpsertIssueDocument");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      body: "# Updated",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      format: "markdown",
      body: "# Updated",
    });
  });

  it("lists document annotation threads with status and comment options", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([{ id: "thread-1" }]));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListDocumentAnnotations");
    await tool.execute({ issueId: "PAP-1135", key: "spec", status: "open", includeComments: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/issues/PAP-1135/documents/spec/annotations?status=open&includeComments=true",
    );
    expect(init.method).toBe("GET");
  });

  it("gets a single document annotation thread", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "thread-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipGetDocumentAnnotationThread");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      threadId: "55555555-5555-4555-8555-555555555555",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/issues/PAP-1135/documents/plan/annotations/55555555-5555-4555-8555-555555555555",
    );
  });

  it("replies inside a document annotation thread", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "comment-1" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipReplyToDocumentAnnotation");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      threadId: "55555555-5555-4555-8555-555555555555",
      body: "Addressed in revision 3.",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/issues/PAP-1135/documents/plan/annotations/55555555-5555-4555-8555-555555555555/comments",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ body: "Addressed in revision 3." });
  });

  it("resolves and reopens a document annotation thread through the thread patch route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "thread-1", status: "resolved" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSetDocumentAnnotationThreadStatus");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      threadId: "55555555-5555-4555-8555-555555555555",
      status: "resolved",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/issues/PAP-1135/documents/plan/annotations/55555555-5555-4555-8555-555555555555",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ status: "resolved" });
  });

  it("does not expose annotation verbs beyond what the routes already allow agents", async () => {
    const names = new Set(createToolDefinitions(makeClient()).map((tool) => tool.name));
    // Creating a thread requires a human text selection anchor, and deleting
    // threads/comments has no route at all — neither is exposed to agents.
    expect(names.has("paperclipCreateDocumentAnnotationThread")).toBe(false);
    expect(names.has("paperclipDeleteDocumentAnnotationThread")).toBe(false);
    expect(names.has("paperclipDeleteDocumentAnnotationComment")).toBe(false);
  });

  it("rejects annotation thread statuses the API does not accept", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSetDocumentAnnotationThreadStatus");
    const response = await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      threadId: "55555555-5555-4555-8555-555555555555",
      status: "deleted",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.content[0]?.text.toLowerCase()).toContain("error");
  });

  it("controls issue workspace services through the current execution workspace", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [],
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        operation: { id: "operation-1" },
        workspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipControlIssueWorkspaceServices");
    await tool.execute({
      issueId: "PAP-1135",
      action: "restart",
      workspaceCommandId: "web",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(lookupUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/heartbeat-context");
    expect(lookupInit.method).toBe("GET");

    const [controlUrl, controlInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(controlUrl)).toBe(
      "http://localhost:3100/api/execution-workspaces/44444444-4444-4444-8444-444444444444/runtime-services/restart",
    );
    expect(controlInit.method).toBe("POST");
    expect(JSON.parse(String(controlInit.body))).toEqual({
      workspaceCommandId: "web",
    });
  });

  it("waits for an issue workspace runtime service URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              healthStatus: "healthy",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipWaitForIssueWorkspaceService");
    const response = await tool.execute({
      issueId: "PAP-1135",
      serviceName: "web",
      timeoutSeconds: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.content[0]?.text).toContain("http://127.0.0.1:5173");
  });

  it("creates suggest_tasks interactions with the expected issue-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "suggest_tasks" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSuggestTasks");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });
  });

  it("creates request_confirmation interactions with plan target payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_confirmation",
      continuationPolicy: "none",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });
  });

  it("creates request_checkbox_confirmation interactions with checkbox payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_checkbox_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestCheckboxConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_checkbox_confirmation",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });
  });

  it("creates approvals with the expected company-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "approval-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateApproval");
    await tool.execute({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/approvals",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });
  });

  it("rejects invalid generic request paths", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "issues",
    });

    expect(response.content[0]?.text).toContain("path must start with /");
  });

  it("rejects generic request paths that escape /api", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "/../../secret",
    });

    expect(response.content[0]?.text).toContain("must not contain '..'");
  });
  // ── PROPOSALS ──────────────────────────────────────────────────────────────
  // The rules the review model depends on are enforced HERE, at the agent's
  // write path, not merely described in a routine. A tool that accepted a
  // sourceless "confirmed" record would let a reconstruction enter the board's
  // history as recorded fact, which is the one failure the whole surface exists
  // to prevent.

  it("creates a proposal against the default company and passes records through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "proposal-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateProposal");
    const response = await tool.execute({
      kind: "initiatives",
      title: "Reconstructed initiatives, 2025-2026",
      summary: "Reconstructed 12 of ~20 bodies of work; the remainder is unattributed.",
      records: [
        {
          ref: "r1",
          provenance: { kind: "confirmed", source: "specs/022-state/spec.md" },
          fields: { title: "State that survives the run" },
        },
        {
          ref: "r2",
          targetId: "55555555-5555-5555-5555-555555555555",
          provenance: { kind: "inferred", source: "47 commits under server/payments, Mar-May 2026" },
          fields: { title: "Payments reliability" },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/proposals",
    );
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    // Both shapes reach the server: an UPDATE carries targetId, a CREATE does not.
    expect(body.records[0].targetId).toBeUndefined();
    expect(body.records[1].targetId).toBe("55555555-5555-5555-5555-555555555555");
    expect(response.content[0]?.text).toContain("proposal-1");
  });

  it("refuses a confirmed record with no source", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateProposal");
    const response = await tool.execute({
      kind: "initiatives",
      title: "Reconstruction",
      records: [
        { ref: "r1", provenance: { kind: "confirmed" }, fields: { title: "Payments reliability" } },
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.content[0]?.text).toContain("requires a concrete source");
  });

  it("refuses an inferred record with a blank source", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateProposal");
    const response = await tool.execute({
      kind: "initiatives",
      title: "Reconstruction",
      records: [
        { ref: "r1", provenance: { kind: "inferred", source: "   " }, fields: { title: "Payments" } },
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.content[0]?.text).toContain("inferred FROM");
  });

  it("strips the reviewer's own fields from an agent-authored record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "proposal-2" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateProposal");
    await tool.execute({
      kind: "initiatives",
      title: "Reconstruction",
      records: [
        {
          ref: "r1",
          provenance: { kind: "inferred", source: "12 commits, Apr 2026" },
          fields: { title: "Payments reliability" },
          // An agent pre-striking and pre-annotating a row would be writing the
          // review as well as the proposal.
          excluded: true,
          note: "I already decided this one is wrong",
          correctedByUserId: "someone",
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const record = JSON.parse(String(init.body)).records[0];
    expect(record.excluded).toBeUndefined();
    expect(record.note).toBeUndefined();
    expect(record.correctedByUserId).toBeUndefined();
  });

  it("submits a proposal to its single gate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ approvalId: "approval-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSubmitProposal");
    await tool.execute({
      proposalId: "66666666-6666-6666-6666-666666666666",
      note: "12 records, 5 confirmed.",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/proposals/66666666-6666-6666-6666-666666666666/submit",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ note: "12 records, 5 confirmed." });
  });
});
