// Pure-function coverage for the wizard's role-aware progress helpers —
// no DOM, no react-query. Exercises the mcpServers "registered AND reachable"
// regression (a registry full of unreachable-but-enabled rows must never read
// as complete) and the pending-step-titles helper the status bar's nudge toast
// derives its copy from (never a hardcoded step list).

import { describe, expect, it } from "vitest";
import { isSetupComplete, pendingStepTitles, setupStepsProgress } from "./SetupWizard";
import type { SetupState } from "../../api/apex-setup-state";

function completeState(): SetupState {
  return {
    auth: { gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null, reportAgeMs: null },
    org: { present: true, id: "org-1", posture: "individual" },
    membership: { present: true, role: "owner", status: "active" },
    companies: { count: 1, ids: ["c1"] },
    scoping: { orgProjectsBound: true, orgReposBound: true, companyProjectsBound: true, companyReposBound: true },
    oauthClient: { configured: true, signInClient: "configured", gatewayUpstreams: { total: 1, configured: 1 } },
    gateway: { reachable: true, url: "http://gw.test", authenticated: true, failure: null },
    mcpServers: {
      registered: ["cockpit-mcp", "github-mcp"],
      probedAt: "2026-09-05T00:00:00.000Z",
      reachableCount: 2,
      details: [
        { name: "cockpit-mcp", enabled: true, reachable: true },
        { name: "github-mcp", enabled: true, reachable: true },
      ],
      cockpitMcp: { registered: true, reachable: true, url: "http://cp/mcp" },
    },
    models: {
      claude: {
        mode: "subscription_local",
        installed: true,
        source: "server",
        reportedAt: null,
        subscriptionProviderRegistered: true,
        apiKeyProviderRegistered: false,
      },
      openrouter: { configured: false },
      aliasesRegistered: ["apex-judge-default"],
      bridgeAvailable: true,
    },
    claudeSession: { connected: true, source: "subscription_token", setAt: null },
  } as SetupState;
}

describe("mcpServers step — registered AND reachable", () => {
  it("is complete when every registered upstream is reachable", () => {
    expect(isSetupComplete(completeState())).toBe(true);
  });

  // Regression: "MCP servers registered — done" while both registered upstreams
  // answer unreachable at the last probe must never read as complete.
  it("is NOT complete when registered upstreams are enabled but unreachable", () => {
    const state = completeState();
    state.mcpServers = {
      registered: ["cockpit-mcp", "github-mcp"],
      probedAt: "2026-09-05T00:00:00.000Z",
      reachableCount: 0,
      details: [
        { name: "cockpit-mcp", enabled: true, reachable: false },
        { name: "github-mcp", enabled: true, reachable: false },
      ],
      cockpitMcp: { registered: true, reachable: false, url: "http://cp/mcp" },
    };
    expect(isSetupComplete(state)).toBe(false);
    const progress = setupStepsProgress(state);
    expect(progress.complete).toBe(false);
    expect(pendingStepTitles(state)).toContain("MCP servers registered");
  });

  it("is NOT complete when the registry read failed, even if a stale registered list is carried", () => {
    const state = completeState();
    state.mcpServers = {
      registered: ["cockpit-mcp"],
      error: "apex-gateway rejected the credential (401)",
      probedAt: null,
      reachableCount: 0,
      details: [],
      cockpitMcp: { registered: false, reachable: null },
    };
    expect(isSetupComplete(state)).toBe(false);
  });
});

describe("pendingStepTitles", () => {
  it("derives from the actual pending required steps, never a hardcoded list", () => {
    const state = completeState();
    state.scoping = { ...state.scoping, orgProjectsBound: false };
    state.models.aliasesRegistered = [];
    const pending = pendingStepTitles(state);
    expect(pending).toEqual(["Org cloud — shared GCP projects", "Models — how judges get paid for and routed"]);
  });

  it("is empty once every required step is done", () => {
    expect(pendingStepTitles(completeState())).toEqual([]);
  });
});
