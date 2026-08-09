// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "./NewIssueDialog";

const dialogState = vi.hoisted(() => ({
  newIssueOpen: true,
  newIssueDefaults: {} as Record<string, unknown>,
  closeNewIssue: vi.fn(),
}));

const dialogContentState = vi.hoisted(() => ({
  onEscapeKeyDown: null as null | ((event: KeyboardEvent) => void),
  onPointerDownOutside: null as null | ((event: {
    detail: { originalEvent: { target: EventTarget | null } };
    preventDefault: () => void;
  }) => void),
}));

const companyState = vi.hoisted(() => ({
  companies: [
    {
      id: "company-1",
      name: "Paperclip",
      status: "active",
      brandColor: "#123456",
      issuePrefix: "PAP",
    },
  ],
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    brandColor: "#123456",
    issuePrefix: "PAP",
  },
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
  upsertDocument: vi.fn(),
  uploadAttachment: vi.fn(),
  ticketTypes: vi.fn(),
}));

/** The four types as the live board serves them: three seeded processes, and
 *  chore reported as processless BY DESIGN rather than simply absent. */
const TICKET_TYPE_OPTIONS = [
  {
    ticketType: "chore",
    pipelineId: null,
    pipelineKey: null,
    pipelineName: null,
    processlessByDesign: true,
    commissionsRepoWritingAgent: false,
  },
  {
    ticketType: "bug",
    pipelineId: "pipeline-bug",
    pipelineKey: "bug",
    pipelineName: "Bug",
    processlessByDesign: false,
    commissionsRepoWritingAgent: true,
  },
  {
    ticketType: "design-change",
    pipelineId: "pipeline-design",
    pipelineKey: "design-change",
    pipelineName: "Design change",
    processlessByDesign: false,
    commissionsRepoWritingAgent: true,
  },
  {
    ticketType: "feature",
    pipelineId: "pipeline-feature",
    pipelineKey: "feature",
    pipelineName: "Feature",
    processlessByDesign: false,
    commissionsRepoWritingAgent: true,
  },
];

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  adapterModels: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockMissingUserSecretsBannerRender = vi.hoisted(() => vi.fn());

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => toastState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../pages/secrets/MissingUserSecretsBanner", async () => {
  const React = await import("react");
  return {
    MissingUserSecretsBanner: (props: { definitionKeys?: string[] }) => {
      mockMissingUserSecretsBannerRender(props);
      return React.createElement(
        "div",
        { "data-testid": "missing-user-secrets-banner" },
        props.definitionKeys?.join(",") ?? "",
      );
    },
  };
});

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  assigneeValueFromSelection: ({
    assigneeAgentId,
    assigneeUserId,
  }: {
    assigneeAgentId?: string;
    assigneeUserId?: string;
  }) => assigneeAgentId ? `agent:${assigneeAgentId}` : assigneeUserId ? `user:${assigneeUserId}` : "",
  currentUserAssigneeOption: () => [],
  parseAssigneeValue: (value: string) => ({
    assigneeAgentId: value.startsWith("agent:") ? value.slice("agent:".length) : null,
    assigneeUserId: value.startsWith("user:") ? value.slice("user:".length) : null,
  }),
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      { value: string; onChange?: (value: string) => void; placeholder?: string }
    >(function MarkdownEditorMock({ value, onChange, placeholder }, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
      }));
      return (
        <textarea
          aria-label={placeholder ?? "Description"}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    }),
  };
});

vi.mock("./InlineEntitySelector", async () => {
  const React = await import("react");
  return {
    InlineEntitySelector: React.forwardRef<
      HTMLButtonElement,
      {
        value: string;
        placeholder?: string;
        renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
      }
    >(function InlineEntitySelectorMock({ value, placeholder, renderTriggerValue }, ref) {
      return (
        <button ref={ref} type="button">
          {(renderTriggerValue?.(value ? { id: value, label: value } : null) ?? value) || placeholder}
        </button>
      );
    }),
  };
});

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    onEscapeKeyDown,
    onPointerDownOutside,
    ...props
  }: ComponentProps<"div"> & {
    showCloseButton?: boolean;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onPointerDownOutside?: (event: unknown) => void;
  }) => {
    dialogContentState.onEscapeKeyDown = onEscapeKeyDown ?? null;
    dialogContentState.onPointerDownOutside = onPointerDownOutside as typeof dialogContentState.onPointerDownOutside;
    return <div {...props}>{children}</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/toggle-switch", () => ({
  ToggleSwitch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: () => void }) => (
    <button type="button" aria-pressed={checked} onClick={onCheckedChange}>toggle</button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, disablePortal }: { children: ReactNode; disablePortal?: boolean }) => (
    <div data-disable-portal={String(Boolean(disablePortal))}>{children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function typeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText",
      }),
    );
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewIssueDialog />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("NewIssueDialog", () => {
  let container: HTMLDivElement;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newIssueOpen = true;
    dialogState.newIssueDefaults = {};
    dialogState.closeNewIssue.mockReset();
    dialogContentState.onEscapeKeyDown = null;
    dialogContentState.onPointerDownOutside = null;
    toastState.pushToast.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.upsertDocument.mockReset();
    mockIssuesApi.uploadAttachment.mockReset();
    mockIssuesApi.ticketTypes.mockReset();
    mockIssuesApi.ticketTypes.mockResolvedValue(TICKET_TYPE_OPTIONS);
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
      },
    ]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/uploads/asset.png" });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockMissingUserSecretsBannerRender.mockReset();
    localStorage.clear();
    mockIssuesApi.create.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-2",
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver!;
    document.body.innerHTML = "";
  });

  it("shows sub-issue context only when opened from a sub-issue action", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New sub-task");
    expect(container.textContent).toContain("Sub-task of");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Parent issue");
    expect(container.textContent).toContain("Create Sub-Task");

    act(() => root.unmount());

    dialogState.newIssueDefaults = {};
    const rerendered = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.textContent).toContain("Create Task");
    expect(container.textContent).not.toContain("Sub-task of");

    act(() => rerendered.root.unmount());
  });

  it("submits parent and goal context for sub-issues", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1", {
        projectId: "project-1",
        projectWorkspaceId: undefined,
        reuseEligible: true,
      });
    });
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Task"));
    expect(submitButton).not.toBeUndefined();
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Child issue",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
        executionWorkspaceId: "workspace-1",
        workMode: "standard",
      }),
    );

    act(() => root.unmount());
  });

  it("does not show user-secret warnings when the draft will not run an env binding that needs them", async () => {
    const { root } = renderDialog(container);
    await flush();

    expect(mockMissingUserSecretsBannerRender).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("scopes user-secret warnings to selected runnable agent and project env bindings", async () => {
    dialogState.newIssueDefaults = {
      title: "Run with scoped secrets",
      assigneeAgentId: "agent-1",
      projectId: "project-1",
    };
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "CodexCoder",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            AGENT_TOKEN: { type: "user_secret_ref", key: "agent_token", required: true },
            OPTIONAL_TOKEN: { type: "user_secret_ref", key: "optional_token", required: false },
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        env: {
          PROJECT_TOKEN: { type: "user_secret_ref", key: "project_token", required: true },
        },
      },
    ]);

    const { root } = renderDialog(container);
    await waitForAssertion(() => {
      expect(mockMissingUserSecretsBannerRender).toHaveBeenCalledWith(
        expect.objectContaining({
          definitionKeys: ["agent_token", "project_token"],
        }),
      );
    });

    expect(container.textContent).toContain("agent_token,project_token");

    act(() => root.unmount());
  });

  it("restores the planning mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Planned from defaults",
      workMode: "planning",
    };

    const { root } = renderDialog(container);
    await flush();

    const planningButton = container.querySelector('[data-issue-work-mode="planning"]');
    expect(planningButton?.className).toContain("bg-accent");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Planned from defaults",
        workMode: "planning",
      }),
    );

    act(() => root.unmount());
  });

  it("restores ask mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Question from defaults",
      workMode: "ask",
    };

    const { root } = renderDialog(container);
    await flush();

    const askButton = container.querySelector('[data-issue-work-mode="ask"]');
    expect(askButton?.className).toContain("bg-accent");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Question from defaults",
        workMode: "ask",
      }),
    );

    act(() => root.unmount());
  });

  it("applies project and execution workspace defaults for normal new issues", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        workspaces: [
          {
            id: "project-workspace-1",
            name: "Primary",
            isPrimary: true,
          },
          {
            id: "project-workspace-2",
            name: "Isolated checkout",
            isPrimary: false,
          },
        ],
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "PAP-100",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-100",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: "project-workspace-2",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      title: "Follow-up issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-2",
      executionWorkspaceId: "workspace-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.textContent).not.toContain("New sub-task");
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Reusing PAP-100");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Follow-up issue",
        projectId: "project-1",
        projectWorkspaceId: "project-workspace-2",
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
        },
      }),
    );

    act(() => root.unmount());
  });

  it("keeps the reusable workspace search popover inside the modal", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        workspaces: [
          {
            id: "project-workspace-1",
            name: "Primary",
            isPrimary: true,
          },
        ],
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "PAP-11446-on-mobile-the-agent-chat",
        mode: "isolated_workspace",
        status: "active",
        branchName: "PAP-11446-on-mobile-the-agent-chat",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: "project-workspace-1",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      title: "Follow-up issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
    };

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      const workspaceInput = container.querySelector('input[placeholder="Search workspaces..."]');
      expect(workspaceInput?.closest("[data-disable-portal]")?.getAttribute("data-disable-portal")).toBe("true");
    });

    act(() => root.unmount());
  });

  it("submits the latest locally typed title and description", async () => {
    let resolveProjects: (projects: Array<{
      id: string;
      name: string;
      description: string | null;
      archivedAt: string | null;
      color: string;
    }>) => void = () => undefined;
    mockProjectsApi.list.mockReturnValue(new Promise((resolve) => {
      resolveProjects = resolve;
    }));

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    await typeTextareaValue(titleInput!, "Typed issue");
    await typeTextareaValue(descriptionInput!, "Typed description");

    await act(async () => {
      resolveProjects([
        {
          id: "project-1",
          name: "Alpha",
          description: null,
          archivedAt: null,
          color: "#445566",
        },
      ]);
      await Promise.resolve();
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Typed issue",
        description: "Typed description",
        workMode: "standard",
      }),
    );

    act(() => root.unmount());
  });

  it("submits Chinese, Japanese, and Hindi issue text without normalization", async () => {
    const title = "验证中文任务";
    const description = [
      "请用中文回复。",
      "日本語: 次の手順を書いてください。",
      "हिन्दी: कृपया स्थिति बताएं।",
    ].join("\n");

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    await typeTextareaValue(titleInput!, title);
    await typeTextareaValue(descriptionInput!, description);

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title,
        description,
        workMode: "standard",
      }),
    );

    act(() => root.unmount());
  });

  it("submits planning work mode when planning is selected", async () => {
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Plan this first");

    const planningButton = container.querySelector('[data-issue-work-mode="planning"]');
    expect(planningButton).not.toBeNull();
    await act(async () => {
      planningButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Plan this first",
        workMode: "planning",
      }),
    );

    act(() => root.unmount());
  });

  it("submits ask work mode when ask is selected", async () => {
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Answer this first");

    const askButton = container.querySelector('[data-issue-work-mode="ask"]');
    expect(askButton).not.toBeNull();
    await act(async () => {
      askButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Answer this first",
        workMode: "ask",
      }),
    );

    act(() => root.unmount());
  });

  it("cycles work modes with cmd-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("ask");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    act(() => root.unmount());
  });

  it("cycles work modes when iOS reports cmd-period as Escape", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");
    expect(dialogContentState.onEscapeKeyDown).not.toBeNull();

    const commandPeriodAsEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      metaKey: true,
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(commandPeriodAsEscape);
    });

    expect(commandPeriodAsEscape.defaultPrevented).toBe(true);
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");
    expect(dialogState.closeNewIssue).not.toHaveBeenCalled();

    const plainEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(plainEscape);
    });

    expect(plainEscape.defaultPrevented).toBe(false);
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    const controlEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Escape",
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(controlEscape);
    });

    expect(controlEscape.defaultPrevented).toBe(false);
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    act(() => root.unmount());
  });

  it("cycles work modes with ctrl-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        ctrlKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    act(() => root.unmount());
  });

  it("submits the parent assignee when a sub-issue opens with inherited defaults", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      goalId: "goal-1",
      assigneeAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Child issue",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
        assigneeAgentId: "agent-1",
      }),
    );

    act(() => root.unmount());
  });

  it("keeps the mobile dialog bounded with an internal flexible scroll region", async () => {
    const { root } = renderDialog(container);
    await flush();

    const dialogContent = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("max-h-(--new-issue-dialog-height)"),
    );
    expect(dialogContent?.className).toContain("h-(--new-issue-dialog-height)");
    expect(dialogContent?.className).toContain("overflow-hidden");
    expect(dialogContent?.getAttribute("style")).toContain("env(safe-area-inset-top)");
    expect(dialogContent?.getAttribute("style")).toContain("env(safe-area-inset-bottom)");

    const titleInput = container.querySelector('textarea[placeholder="Task title"]');
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]');
    const bodyScrollRegion = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("overscroll-contain"),
    );
    expect(bodyScrollRegion?.className).toContain("flex-1");
    expect(bodyScrollRegion?.className).toContain("overflow-y-auto");
    expect(bodyScrollRegion?.contains(titleInput ?? null)).toBe(true);
    expect(bodyScrollRegion?.contains(descriptionInput ?? null)).toBe(true);

    act(() => root.unmount());
  });

  it("keeps priority under the mobile overflow menu", async () => {
    const { root } = renderDialog(container);
    await flush();

    const priorityChip = container.querySelector('[data-testid="new-issue-priority-chip"]');
    expect(priorityChip?.className).toContain("hidden");
    expect(priorityChip?.className).toContain("sm:inline-flex");

    const highPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(highPriorityOption?.textContent).toContain("High");

    await act(async () => {
      highPriorityOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedHighPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(selectedHighPriorityOption?.className).toContain("bg-accent");

    act(() => root.unmount());
  });

  it("allows editor autocomplete portal pointer events inside the modal", async () => {
    const { root } = renderDialog(container);
    await flush();

    const menu = document.createElement("div");
    menu.setAttribute("data-paperclip-floating-ui", "");
    const option = document.createElement("button");
    menu.appendChild(option);
    document.body.appendChild(menu);
    const preventDefault = vi.fn();

    dialogContentState.onPointerDownOutside?.({
      detail: { originalEvent: { target: option } },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("warns when a sub-issue stops matching the parent workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
      {
        id: "workspace-2",
        name: "Other workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-2",
        cwd: "/tmp/workspace-2",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:01:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      parentExecutionWorkspaceLabel: "Parent workspace",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();
    await flush();

    expect(container.textContent).not.toContain("will no longer use the parent task workspace");

    const selects = Array.from(container.querySelectorAll("select"));
    const modeSelect = selects[0] as HTMLSelectElement | undefined;
    expect(modeSelect).not.toBeUndefined();

    await act(async () => {
      modeSelect!.value = "shared_workspace";
      modeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("will no longer use the parent task workspace");
    expect(container.textContent).toContain("Parent workspace");

    act(() => root.unmount());
  });

  it("reveals the watchdog editor from the overflow menu", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableTaskWatchdogs: true,
    });

    const { root } = renderDialog(container);
    await flush();

    // The watchdog row is hidden until the menu item is toggled on.
    expect(container.querySelector('textarea[placeholder^="What should the watchdog"]')).toBeNull();

    const watchdogMenuItem = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Watchdog");
    expect(watchdogMenuItem).not.toBeUndefined();

    await act(async () => {
      watchdogMenuItem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Set watchdog");
    expect(container.querySelector('textarea[placeholder^="What should the watchdog"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("submits the configured watchdog from a restored draft", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableTaskWatchdogs: true,
    });
    localStorage.setItem(
      "paperclip:issue-draft",
      JSON.stringify({
        title: "Watched task",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeValue: "",
        reviewerValue: "",
        approverValue: "",
        watchdogAgentId: "agent-9",
        watchdogInstructions: "Keep it moving",
        projectId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        workMode: "standard",
      }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("Keep it moving");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Watched task",
        watchdog: { agentId: "agent-9", instructions: "Keep it moving" },
      }),
    );

    act(() => root.unmount());
  });

  describe("graduated work-mode labels and status hues", () => {
    function workModeOption(value: string) {
      return container.querySelector(`[data-issue-work-mode="${value}"]`);
    }

    function statusOptionIconClass(label: string, description?: string) {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) => {
        const text = candidate.textContent ?? "";
        return (
          candidate.querySelector("svg") !== null &&
          text.includes(label) &&
          (description === undefined || text.includes(description))
        );
      });
      return button?.querySelector("svg")?.getAttribute("class") ?? "";
    }

    it("uses agent-mode labels and brand status hues by default", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(workModeOption("standard")?.textContent).toContain("Agent mode");
      });

      expect(workModeOption("standard")?.textContent).toContain("Agent mode");
      expect(workModeOption("ask")?.textContent).toContain("Ask mode");
      expect(workModeOption("planning")?.textContent).toContain("Plan mode");

      expect(statusOptionIconClass("Todo", "Executable - assignee will be woken")).toContain("text-amber-600");
      expect(statusOptionIconClass("In Progress")).toContain("text-blue-600");

      act(() => root.unmount());
    });
  });

  // -------------------------------------------------------------------------
  // GAP 1 — a ticket can now enter a lifecycle.
  // -------------------------------------------------------------------------
  describe("ticket type", () => {
    function typeOptionButton(ticketType: string) {
      return container.querySelector<HTMLButtonElement>(
        `[data-issue-ticket-type-option="${ticketType}"]`,
      );
    }

    it("offers every type the board serves, plus an explicit no-type", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(typeOptionButton("bug")).not.toBeNull();
      });

      expect(typeOptionButton("none")?.textContent).toContain("No type");
      expect(typeOptionButton("chore")?.textContent).toContain("Chore");
      expect(typeOptionButton("bug")?.textContent).toContain("Bug");
      expect(typeOptionButton("design-change")?.textContent).toContain("Design change");
      expect(typeOptionButton("feature")?.textContent).toContain("Feature");

      act(() => root.unmount());
    });

    it("defaults to NO type — it never guesses a process for you", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(typeOptionButton("bug")).not.toBeNull();
      });

      expect(
        container.querySelector("[data-testid='new-issue-ticket-type-chip']")
          ?.getAttribute("data-issue-ticket-type"),
      ).toBe("none");

      act(() => root.unmount());
    });

    it("names the process a type runs, and says chore has none BY DESIGN", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(typeOptionButton("bug")).not.toBeNull();
      });

      expect(typeOptionButton("bug")?.textContent).toContain("Runs the Bug process");
      // The honest handling of chore: shown, selectable, and truthful.
      expect(typeOptionButton("chore")?.textContent).toContain("No process, by design");
      expect(typeOptionButton("chore")?.textContent).toContain("never enters a pipeline");

      act(() => root.unmount());
    });

    it("distinguishes a type whose pipeline is merely missing from chore", async () => {
      mockIssuesApi.ticketTypes.mockResolvedValue([
        { ...TICKET_TYPE_OPTIONS[0] },
        {
          ticketType: "bug",
          pipelineId: null,
          pipelineKey: null,
          pipelineName: null,
          processlessByDesign: false,
          commissionsRepoWritingAgent: false,
        },
      ]);
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(typeOptionButton("bug")).not.toBeNull();
      });

      expect(typeOptionButton("bug")?.textContent).toContain("No process on this board yet");
      expect(typeOptionButton("bug")?.textContent).not.toContain("by design");

      act(() => root.unmount());
    });

    it("sends the chosen type so the server can start the process", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(typeOptionButton("chore")).not.toBeNull();
      });

      await act(async () => {
        typeOptionButton("chore")!.click();
      });
      await flush();

      const title = container.querySelector<HTMLTextAreaElement>("textarea[placeholder='Task title']")!;
      await typeTextareaValue(title, "Rotate the deploy key");
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Create Task"))!
          .click();
      });
      await flush();

      await waitForAssertion(() => {
        expect(mockIssuesApi.create).toHaveBeenCalled();
      });
      expect(mockIssuesApi.create.mock.calls[0]![1]).toMatchObject({ ticketType: "chore" });

      act(() => root.unmount());
    });

    it("omits ticketType entirely when the author declared none", async () => {
      const { root } = renderDialog(container);
      await flush();

      const title = container.querySelector<HTMLTextAreaElement>("textarea[placeholder='Task title']")!;
      await typeTextareaValue(title, "A question");
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Create Task"))!
          .click();
      });
      await flush();

      await waitForAssertion(() => {
        expect(mockIssuesApi.create).toHaveBeenCalled();
      });
      // Absent, not "chore". An undeclared type is its own fact.
      expect(mockIssuesApi.create.mock.calls[0]![1]).not.toHaveProperty("ticketType");

      act(() => root.unmount());
    });
  });

  // -------------------------------------------------------------------------
  // GAP 2 — a ticket cannot silently have no codebase.
  // -------------------------------------------------------------------------
  describe("codebase preflight", () => {
    const implementer = {
      id: "agent-implementer",
      name: "Implementer",
      role: "engineering",
      title: "Implementer",
      icon: "wrench",
      adapterType: "claude_local",
      adapterConfig: {
        dangerouslySkipPermissions: false,
        allowedTools: "Read Edit Write Bash Glob Grep",
      },
      permissions: {},
    };
    const specifier = {
      ...implementer,
      id: "agent-specifier",
      name: "Specifier",
      adapterConfig: {
        dangerouslySkipPermissions: false,
        allowedTools: "AskUserQuestion Glob Grep Monitor Read TaskOutput TaskStop ToolSearch",
      },
    };

    function missingNote() {
      return container.querySelector("[data-testid='new-issue-codebase-missing-note']");
    }
    function createButton() {
      return [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Create Task")) as HTMLButtonElement;
    }

    it("warns and REFUSES when a repo-writing assignee has no codebase", async () => {
      mockAgentsApi.list.mockResolvedValue([implementer]);
      mockProjectsApi.list.mockResolvedValue([]);
      dialogState.newIssueDefaults = { assigneeAgentId: "agent-implementer", title: "Fix it" };

      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(missingNote()).not.toBeNull();
      });

      expect(missingNote()!.getAttribute("data-codebase-blocking")).toBe("true");
      expect(missingNote()!.textContent).toContain("Implementer needs a codebase");
      expect(missingNote()!.textContent).toContain("Pick a project with a repository");
      expect(createButton().disabled).toBe(true);

      act(() => root.unmount());
    });

    it("warns without refusing when the ticket is parked in backlog", async () => {
      mockAgentsApi.list.mockResolvedValue([implementer]);
      mockProjectsApi.list.mockResolvedValue([]);
      dialogState.newIssueDefaults = {
        assigneeAgentId: "agent-implementer",
        title: "Fix it later",
        status: "backlog",
      };

      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(missingNote()).not.toBeNull();
      });

      expect(missingNote()!.getAttribute("data-codebase-blocking")).toBe("false");
      expect(missingNote()!.textContent).toContain("parked in Backlog");
      expect(createButton().disabled).toBe(false);

      act(() => root.unmount());
    });

    it("says nothing about a read-only assignee — project stays optional", async () => {
      mockAgentsApi.list.mockResolvedValue([specifier]);
      mockProjectsApi.list.mockResolvedValue([]);
      dialogState.newIssueDefaults = { assigneeAgentId: "agent-specifier", title: "Draft the spec" };

      const { root } = renderDialog(container);
      await flush();
      await flush();

      expect(missingNote()).toBeNull();
      expect(createButton().disabled).toBe(false);

      act(() => root.unmount());
    });

    it("defaults to the single repo-bound project and SAYS it defaulted", async () => {
      mockAgentsApi.list.mockResolvedValue([implementer]);
      mockProjectsApi.list.mockResolvedValue([
        {
          id: "project-1",
          name: "APEX Cockpit",
          description: null,
          archivedAt: null,
          color: "#445566",
          codebase: { repoUrl: "sarala-ai/apex-cockpit" },
        },
        {
          id: "project-2",
          name: "Notes",
          description: null,
          archivedAt: null,
          color: "#112233",
          codebase: { repoUrl: null },
        },
      ]);
      dialogState.newIssueDefaults = { assigneeAgentId: "agent-implementer", title: "Fix it" };

      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(
          container.querySelector("[data-testid='new-issue-codebase-defaulted-note']"),
        ).not.toBeNull();
      });

      const note = container.querySelector("[data-testid='new-issue-codebase-defaulted-note']")!;
      expect(note.textContent).toContain("APEX Cockpit");
      expect(note.textContent).toContain("the only project with a repository bound");
      expect(missingNote()).toBeNull();
      expect(createButton().disabled).toBe(false);

      act(() => root.unmount());
    });

    it("refuses to guess between two repo-bound projects", async () => {
      mockAgentsApi.list.mockResolvedValue([implementer]);
      mockProjectsApi.list.mockResolvedValue([
        {
          id: "project-1",
          name: "APEX Cockpit",
          archivedAt: null,
          description: null,
          color: "#445566",
          codebase: { repoUrl: "sarala-ai/apex-cockpit" },
        },
        {
          id: "project-2",
          name: "Bloom",
          archivedAt: null,
          description: null,
          color: "#112233",
          codebase: { repoUrl: "sarala-ai/bloom" },
        },
      ]);
      dialogState.newIssueDefaults = { assigneeAgentId: "agent-implementer", title: "Fix it" };

      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(missingNote()).not.toBeNull();
      });

      expect(container.querySelector("[data-testid='new-issue-codebase-defaulted-note']")).toBeNull();
      expect(createButton().disabled).toBe(true);

      act(() => root.unmount());
    });

    it("fires on the LIFECYCLE even with no assignee at all", async () => {
      mockAgentsApi.list.mockResolvedValue([]);
      mockProjectsApi.list.mockResolvedValue([]);

      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(
          container.querySelector<HTMLButtonElement>("[data-issue-ticket-type-option='bug']"),
        ).not.toBeNull();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-issue-ticket-type-option='bug']")!
          .click();
      });
      await flush();

      await waitForAssertion(() => {
        expect(missingNote()).not.toBeNull();
      });
      expect(missingNote()!.textContent).toContain("Bug process");

      act(() => root.unmount());
    });

    it("says nothing for a chore, which commissions nobody", async () => {
      mockAgentsApi.list.mockResolvedValue([]);
      mockProjectsApi.list.mockResolvedValue([]);

      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(
          container.querySelector<HTMLButtonElement>("[data-issue-ticket-type-option='chore']"),
        ).not.toBeNull();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-issue-ticket-type-option='chore']")!
          .click();
      });
      await flush();

      expect(missingNote()).toBeNull();

      act(() => root.unmount());
    });
  });

  // -------------------------------------------------------------------------
  // GAP 3 — the mode chip cannot be read as an assignee picker.
  // -------------------------------------------------------------------------
  describe("work mode is labelled as a mode", () => {
    it("prefixes the chip so 'Agent' cannot be read as an assignee", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(container.querySelector("[data-issue-work-mode-chip]")).not.toBeNull();
      });

      const chip = container.querySelector("[data-issue-work-mode-chip]")!;
      expect(chip.textContent).toContain("Mode:");
      expect(chip.textContent).toContain("Agent");
      expect(chip.getAttribute("aria-label")).toContain("Work mode");
      expect(chip.getAttribute("aria-label")).toContain("assignee itself is set above");

      act(() => root.unmount());
    });

    it("says in the menu itself where the assignee is chosen", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(container.textContent).toContain("Work mode");
      });

      expect(container.textContent).toContain("How the assignee works");

      act(() => root.unmount());
    });
  });

  // -------------------------------------------------------------------------
  // APEX-71 — controlled inputs survive re-layout / init re-run
  // The root cause: IssueDescriptionEditor kept a local draftValue and a
  // useEffect that re-synced it from the parent prop.  When the initialization
  // effect re-ran (new initializationKey) it called setIssueText("...", ""),
  // changing the description prop from the draft text back to "".  The sync
  // effect then cleared draftValue, so the textarea went visually blank even
  // though descriptionRef still held the user's text.
  // -------------------------------------------------------------------------
  it("preserves user-typed description visually after a dialog context re-initialization", async () => {
    // Pre-load a draft so the description editor starts with non-empty text.
    localStorage.setItem(
      "paperclip:issue-draft",
      JSON.stringify({
        title: "Saved draft title",
        description: "Saved draft description",
        status: "todo",
        priority: "",
        assigneeValue: "",
        reviewerValue: "",
        approverValue: "",
        projectId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        workMode: "standard",
      }),
    );

    const { root, queryClient } = renderDialog(container);
    await flush();

    const descriptionInput = container.querySelector(
      'textarea[aria-label="Add description..."]',
    ) as HTMLTextAreaElement | null;
    expect(descriptionInput).not.toBeNull();

    // The draft description should appear in the editor on open.
    await waitForAssertion(() => {
      expect(descriptionInput!.value).toBe("Saved draft description");
    });

    // User edits the description.
    await typeTextareaValue(descriptionInput!, "User edited the description");

    // User types a long title — simulating the title-wrap scenario that triggers
    // re-renders in the real browser.
    const titleInput = container.querySelector(
      'textarea[placeholder="Task title"]',
    ) as HTMLTextAreaElement | null;
    await typeTextareaValue(
      titleInput!,
      "A title long enough that it would wrap across two lines in the modal",
    );

    // Simulate a dialog-context update that changes the initialization key
    // (e.g. anchor scroll in the real app can push new newIssueDefaults).
    // This causes the initialization effect to re-run and call setIssueText
    // with a fresh empty description, which previously cleared the editor.
    dialogState.newIssueDefaults = { title: "New task title from context" };
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewIssueDialog />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    // Flush multiple times: the init effect sets description="", which queues a re-render
    // of IssueDescriptionEditor, which then runs the sync useEffect setting draftValue="".
    // Each flush() handles one round; we need several to let all second-order effects settle.
    for (let i = 0; i < 5; i++) await flush();

    // The user's edited description must survive the re-initialization.
    // Before the fix: the sync useEffect in IssueDescriptionEditor cleared draftValue
    // when the description prop was reset to "" by the init effect, so this was "".
    expect(descriptionInput!.value).toBe("User edited the description");

    act(() => root.unmount());
    // Restore defaults for subsequent tests.
    dialogState.newIssueDefaults = {};
  });
});
