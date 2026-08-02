// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConfoundSet, Release, ReleaseDetail as ReleaseDetailData, ReleaseNotes } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Releases, observationWindowOpen } from "./Releases";
import { ReleaseDetail } from "./ReleaseDetail";

const mockReleasesApi = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  notes: vi.fn(),
  confounds: vi.fn(),
}));

vi.mock("../api/releases", () => ({ releasesApi: mockReleasesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

const setBreadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <a href={to} {...(rest as any)}>
      {children as never}
    </a>
  ),
  useParams: () => ({ releaseId: "release-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    id: "release-1",
    companyId: "company-1",
    version: "1.0.0",
    name: null,
    status: "observing",
    closure: null,
    closureReason: null,
    environment: "prod",
    promotedFromReleaseId: null,
    releasedAt: new Date("2026-08-01T00:00:00.000Z"),
    observationWindowEndsAt: new Date("2099-08-08T00:00:00.000Z"),
    closedAt: null,
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function cleanConfounds(): ConfoundSet {
  return {
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-08T00:00:00.000Z",
    subjectInitiativeId: null,
    clean: true,
    initiatives: [],
    confoundingInitiatives: [],
    overlappingReleases: [],
    warning: null,
  };
}

function uncleanConfounds(): ConfoundSet {
  return {
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-08T00:00:00.000Z",
    subjectInitiativeId: "initiative-1",
    clean: false,
    initiatives: [],
    confoundingInitiatives: [
      {
        initiativeId: "initiative-2",
        initiativeTitle: "Onboarding rewrite",
        changeCount: 2,
        releaseIds: ["release-1"],
      },
    ],
    overlappingReleases: [],
    warning:
      "This measurement window also carried Onboarding rewrite in release 1.0.0 (prod); this evidence is not clean.",
  };
}

function detail(overrides: Partial<ReleaseDetailData> = {}): ReleaseDetailData {
  return {
    release: release(),
    changes: [],
    artifacts: [],
    promotedFrom: null,
    promotedTo: [],
    confounds: cleanConfounds(),
    ...overrides,
  };
}

function notes(overrides: Partial<ReleaseNotes> = {}): ReleaseNotes {
  return {
    releaseId: "release-1",
    version: "1.0.0",
    name: null,
    environment: "prod",
    status: "observing",
    closure: null,
    releasedAt: "2026-08-01T00:00:00.000Z",
    sections: [],
    artifacts: [],
    confoundWarning: null,
    markdown: "# 1.0.0\n\n_No changes recorded against this release._\n",
    ...overrides,
  };
}

describe("observationWindowOpen", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");

  it("is open while the declared window has not elapsed", () => {
    expect(
      observationWindowOpen(
        release({ observationWindowEndsAt: new Date("2026-08-08T00:00:00.000Z") }),
        now,
      ),
    ).toBe(true);
  });

  it("is closed once the window has elapsed", () => {
    expect(
      observationWindowOpen(
        release({ observationWindowEndsAt: new Date("2026-08-02T00:00:00.000Z") }),
        now,
      ),
    ).toBe(false);
  });

  it("is closed for an unreleased release", () => {
    expect(observationWindowOpen(release({ releasedAt: null }), now)).toBe(false);
  });

  it("is closed once the release itself is closed", () => {
    expect(observationWindowOpen(release({ closure: "stable" }), now)).toBe(false);
  });
});

describe("Releases list", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Releases />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("explains what a release is for when there are none", async () => {
    mockReleasesApi.list.mockResolvedValue([]);
    const root = await render();
    expect(container.textContent).toContain("No releases yet");
    expect(container.textContent).toContain("measurement boundary");
    await act(async () => root.unmount());
  });

  it("lists releases with status, environment and an open observation window", async () => {
    mockReleasesApi.list.mockResolvedValue([
      release(),
      release({
        id: "release-0",
        version: "0.9.0",
        environment: "staging",
        status: "released",
        closure: "rolled_back",
        observationWindowEndsAt: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ]);
    const root = await render();

    expect(container.querySelectorAll('[data-testid="release-row"]')).toHaveLength(2);
    expect(container.textContent).toContain("1.0.0");
    expect(container.textContent).toContain("prod");
    expect(container.textContent).toContain("observing");
    expect(container.textContent).toContain("rolled back");
    expect(container.querySelector('[data-testid="observation-open"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});

describe("Release detail", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockReleasesApi.notes.mockResolvedValue(notes());
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ReleaseDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("states the confound plainly when the window carried other initiatives", async () => {
    mockReleasesApi.detail.mockResolvedValue(detail({ confounds: uncleanConfounds() }));
    const root = await render();

    const warning = container.querySelector('[data-testid="confound-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("this evidence is not clean");
    expect(warning?.textContent).toContain("Onboarding rewrite");
    expect(warning?.textContent).toContain("2 changes");
    await act(async () => root.unmount());
  });

  it("says so when the window is clean rather than staying silent", async () => {
    mockReleasesApi.detail.mockResolvedValue(detail());
    const root = await render();
    expect(container.querySelector('[data-testid="confound-clean"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="confound-warning"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("groups changes by initiative and shows the artifact tags", async () => {
    mockReleasesApi.detail.mockResolvedValue(
      detail({
        changes: [
          {
            issueId: "issue-1",
            identifier: "FIN-11",
            title: "New welcome screen",
            status: "done",
            githubMirrorRef: "sarala-ai/finpilot#11",
            goalId: "goal-1",
            initiativeId: "initiative-1",
            initiativeTitle: "Onboarding rewrite",
            pullRequests: [
              {
                id: "wp-1",
                title: "Welcome screen",
                url: "https://github.com/sarala-ai/finpilot/pull/40",
                externalId: "40",
                status: "merged",
              },
            ],
          },
          {
            issueId: "issue-2",
            identifier: "FIN-12",
            title: "Rerank results",
            status: "done",
            githubMirrorRef: null,
            goalId: "goal-2",
            initiativeId: "initiative-2",
            initiativeTitle: "Search relevance",
            pullRequests: [],
          },
        ],
        artifacts: [
          {
            id: "artifact-1",
            releaseId: "release-1",
            companyId: "company-1",
            repo: "sarala-ai/finpilot",
            tag: "v1.0.0",
            commitSha: "0123456789abcdef",
            url: null,
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ],
      }),
    );
    const root = await render();

    expect(container.querySelectorAll('[data-testid="initiative-group"]')).toHaveLength(2);
    expect(container.textContent).toContain("Onboarding rewrite");
    expect(container.textContent).toContain("Search relevance");
    expect(container.textContent).toContain("FIN-11");
    const artifact = container.querySelector('[data-testid="release-artifact"]');
    expect(artifact?.textContent).toContain("sarala-ai/finpilot");
    expect(artifact?.textContent).toContain("v1.0.0");
    expect(artifact?.textContent).toContain("0123456789ab");
    await act(async () => root.unmount());
  });

  it("renders the generated notes rather than an editor", async () => {
    mockReleasesApi.detail.mockResolvedValue(detail());
    mockReleasesApi.notes.mockResolvedValue(
      notes({ markdown: "# 1.0.0\n\n## Onboarding rewrite\n\n- FIN-11: New welcome screen\n" }),
    );
    const root = await render();
    const pre = container.querySelector('[data-testid="release-notes"]');
    expect(pre?.textContent).toContain("## Onboarding rewrite");
    expect(container.textContent).toContain("never hand-authored");
    await act(async () => root.unmount());
  });

  it("shows an empty change set without inventing content", async () => {
    mockReleasesApi.detail.mockResolvedValue(detail());
    const root = await render();
    expect(container.querySelectorAll('[data-testid="initiative-group"]')).toHaveLength(0);
    expect(container.textContent).toContain("No changes recorded against this release.");
    expect(container.textContent).toContain("No repository tags recorded");
    await act(async () => root.unmount());
  });
});
