// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepBody } from "./SetupWizard";
import type { SetupState } from "../../api/apex-setup-state";

/** A minimal-but-complete SetupState the gateway/oauthClient/mcpServers step
 *  bodies can render without crashing. Individual fields are overridden per test. */
function baseState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    auth: { gcloud: "ok", gh: "ok", adc: "ok", source: "stale", reportedAt: null, reportAgeMs: null },
    org: { present: true, id: "org-1", posture: "individual" },
    membership: { present: true, role: "owner", status: "active" },
    companies: { count: 1, ids: ["c1"] },
    scoping: { orgProjectsBound: true, orgReposBound: true, companyProjectsBound: true, companyReposBound: true },
    oauthClient: { configured: true, signInClient: "configured", gatewayUpstreams: { total: 1, configured: 1 } },
    gateway: { reachable: true, url: "http://gw.test", authenticated: true, failure: null },
    mcpServers: {
      registered: ["cockpit-mcp"],
      probedAt: "2026-01-01T00:00:00.000Z",
      reachableCount: 1,
      details: [{ name: "cockpit-mcp", enabled: true, reachable: true }],
      cockpitMcp: { registered: true, reachable: true, url: "http://cp/mcp" },
    },
    models: {
      claude: {
        mode: "none",
        installed: false,
        source: "server",
        reportedAt: null,
        subscriptionProviderRegistered: false,
        apiKeyProviderRegistered: false,
      },
      openrouter: { configured: false },
      aliasesRegistered: [],
      bridgeAvailable: true,
    },
    claudeSession: { connected: false, source: null, setAt: null },
    ...overrides,
  } as SetupState;
}

async function renderStepBody(
  container: HTMLDivElement,
  props: { stepKey: "gateway" | "mcpServers"; state: SetupState; done: boolean; authReady: boolean },
): Promise<Root> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <StepBody
          stepKey={props.stepKey}
          state={props.state}
          selectedCompanyId={null}
          orgId={props.state.org.id ?? null}
          orgPresent={props.state.org.present}
          done={props.done}
          authReady={props.authReady}
          onRecheck={() => {}}
          rechecking={false}
        />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("StepBody — identity lock-banner gate", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      container.remove();
    });
    document.body.innerHTML = "";
  });

  it("shows the step's own content, never the lock banner, when the step is already done — even with stale identity", async () => {
    const root = await renderStepBody(container, {
      stepKey: "gateway",
      state: baseState(),
      done: true,
      authReady: false, // identity is stale/not-ready
    });

    expect(container.querySelector('[data-testid="wizard-auth-gate"]')).toBeNull();
    expect(container.textContent).not.toContain("Connect your identity first");
    // The gateway step's own body renders instead.
    expect(container.textContent).toContain("reachable, credential accepted");

    await act(async () => {
      root.unmount();
    });
  });

  it("still shows the lock banner for a NOT-done step that needs live identity", async () => {
    const root = await renderStepBody(container, {
      stepKey: "gateway",
      state: baseState(),
      done: false,
      authReady: false,
    });

    expect(container.querySelector('[data-testid="wizard-auth-gate"]')).not.toBeNull();
    expect(container.textContent).toContain("Connect your identity first");

    await act(async () => {
      root.unmount();
    });
  });

  it("never gates on identity once authReady is true, regardless of done", async () => {
    const root = await renderStepBody(container, {
      stepKey: "gateway",
      state: baseState(),
      done: false,
      authReady: true,
    });

    expect(container.querySelector('[data-testid="wizard-auth-gate"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
