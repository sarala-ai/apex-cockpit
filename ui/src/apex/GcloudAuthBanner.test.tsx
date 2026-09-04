// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GcloudAuthBanner } from "./GcloudAuthBanner";
import { apexSetupApi, type AuthStatus } from "../api/apex-setup";

vi.mock("../api/apex-setup", async () => {
  const actual = await vi.importActual<typeof import("../api/apex-setup")>("../api/apex-setup");
  return { ...actual, apexSetupApi: { ...actual.apexSetupApi, auth: vi.fn() } };
});

function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    google: { authed: true, account: "me@example.com", live: true },
    github: { authed: true, user: "me", live: true },
    gcloud: "ok",
    gh: "ok",
    adc: "ok",
    source: "server",
    reportedAt: null,
    reportAgeMs: null,
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderBanner(container: HTMLDivElement): Promise<Root> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <GcloudAuthBanner pollMs={60_000} />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return root;
}

describe("GcloudAuthBanner", () => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).apexDesktop;
    vi.restoreAllMocks();
  });

  it("shows a neutral notice — not the amber prompt — when source is 'none'", async () => {
    vi.mocked(apexSetupApi.auth).mockResolvedValue(
      authStatus({
        source: "none",
        google: { authed: false, account: null, live: false },
        github: { authed: false, user: null, live: false },
        gcloud: "missing",
        gh: "missing",
        adc: "missing",
      }),
    );

    const root = await renderBanner(container);

    expect(container.textContent).toContain("Your workstation hasn't reported yet");
    expect(container.textContent).toContain("apex doctor --report");
    expect(container.textContent).not.toContain("Cloud sign-in required");
    expect(container.querySelector(".border-amber-500\\/40")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a 'Sign in to Google Cloud' button that calls cloudAuth.login() when source is 'workstation' and gcloud is expired inside the desktop app", async () => {
    const login = vi.fn().mockResolvedValue({ ok: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).apexDesktop = { cloudAuth: { login } };

    vi.mocked(apexSetupApi.auth).mockResolvedValue(
      authStatus({
        source: "workstation",
        reportedAt: new Date().toISOString(),
        gcloud: "expired",
        google: { authed: true, account: "me@example.com", live: false },
      }),
    );

    const root = await renderBanner(container);

    expect(container.textContent).toContain("Cloud session expired");
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Sign in to Google Cloud",
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(login).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("reported by your workstation");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the stale-report copy and the --cockpit-url re-run command when source is 'stale'", async () => {
    vi.mocked(apexSetupApi.auth).mockResolvedValue(
      authStatus({
        source: "stale",
        reportedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        reportAgeMs: 2 * 24 * 60 * 60 * 1000,
        gcloud: "ok",
        gh: "ok",
      }),
    );

    const root = await renderBanner(container);

    expect(container.textContent).toContain("Your workstation's report is stale");
    expect(container.textContent).toContain("apex doctor --report --cockpit-url");
    expect(container.textContent).toContain(window.location.origin);

    await act(async () => {
      root.unmount();
    });
  });
});
