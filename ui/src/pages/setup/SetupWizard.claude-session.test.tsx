// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessionStep } from "./SetupWizard";

type ClaudeConnectState = {
  cockpit_approved: boolean;
  cockpit_approval_url?: string | null;
  anthropic_url: string | null;
  attempt_error: string | null;
  delivered: boolean;
  error: string | null;
};

type StateListener = (state: ClaudeConnectState) => void;
type ExitListener = (info: { code: number | null }) => void;

function baseState(overrides: Partial<ClaudeConnectState> = {}): ClaudeConnectState {
  return {
    cockpit_approved: false,
    cockpit_approval_url: null,
    anthropic_url: null,
    attempt_error: null,
    delivered: false,
    error: null,
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderStep(
  container: HTMLDivElement,
  props: {
    orgId?: string | null;
    companyId: string | null;
    done: boolean;
    onRecheck: () => void;
    rechecking: boolean;
  },
): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ClaudeSessionStep
        orgId={props.orgId ?? null}
        companyId={props.companyId}
        done={props.done}
        onRecheck={props.onRecheck}
        rechecking={props.rechecking}
      />,
    );
  });
  await flushReact();
  return root;
}

function click(el: Element | null) {
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ClaudeSessionStep", () => {
  let container: HTMLDivElement;
  let onRecheck: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onRecheck = vi.fn<() => void>();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).apexDesktop;
    vi.restoreAllMocks();
  });

  describe("without a desktop bridge", () => {
    it("falls back to the copy-paste command and hides the inline start button", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      expect(container.textContent).toContain("apex claude connect --cockpit-url");
      expect(container.textContent).toContain("--company-id company-1");
      expect(container.querySelector('[data-testid="claude-connect-start"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    });

    it("prefers --org-id over --company-id in the fallback command when an org is present", async () => {
      const root = await renderStep(container, {
        orgId: "org-1",
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      expect(container.textContent).toContain("--org-id org-1");
      expect(container.textContent).not.toContain("--company-id");

      await act(async () => {
        root.unmount();
      });
    });
  });

  describe("with an inline desktop bridge", () => {
    let start: ReturnType<typeof vi.fn>;
    let submitCode: ReturnType<typeof vi.fn>;
    let cancel: ReturnType<typeof vi.fn>;
    let onStateUnsub: ReturnType<typeof vi.fn>;
    let onExitUnsub: ReturnType<typeof vi.fn>;
    let stateListener: StateListener | null;
    let exitListener: ExitListener | null;

    beforeEach(() => {
      start = vi.fn().mockResolvedValue({ ok: true });
      submitCode = vi.fn().mockResolvedValue({ ok: true });
      cancel = vi.fn().mockResolvedValue({ ok: true });
      onStateUnsub = vi.fn();
      onExitUnsub = vi.fn();
      stateListener = null;
      exitListener = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).apexDesktop = {
        claudeConnect: {
          start,
          submitCode,
          cancel,
          onState: vi.fn((listener: StateListener) => {
            stateListener = listener;
            return onStateUnsub;
          }),
          onExit: vi.fn((listener: ExitListener) => {
            exitListener = listener;
            return onExitUnsub;
          }),
        },
      };
    });

    async function pushState(overrides: Partial<ClaudeConnectState>) {
      expect(stateListener).not.toBeNull();
      await act(async () => {
        stateListener!(baseState(overrides));
      });
      await flushReact();
    }

    it("calls start({ companyId }) when the start button is clicked, and gates the code input on anthropic_url", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      click(container.querySelector('[data-testid="claude-connect-start"]'));
      await flushReact();

      expect(start).toHaveBeenCalledWith({ companyId: "company-1" });

      const input = container.querySelector('[data-testid="claude-connect-code"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.disabled).toBe(true);

      await pushState({
        cockpit_approved: true,
        anthropic_url: "https://claude.ai/oauth/x",
        attempt_error: null,
        delivered: false,
        error: null,
      });

      expect(input.disabled).toBe(false);

      const link = container
        .querySelector('[data-testid="claude-connect-anthropic"]')
        ?.closest("a");
      expect(link?.getAttribute("href")).toBe("https://claude.ai/oauth/x");

      await act(async () => {
        root.unmount();
      });
    });

    it("calls start({ orgId }) instead of companyId when an org is present", async () => {
      const root = await renderStep(container, {
        orgId: "org-1",
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      click(container.querySelector('[data-testid="claude-connect-start"]'));
      await flushReact();

      expect(start).toHaveBeenCalledWith({ orgId: "org-1" });

      await act(async () => {
        root.unmount();
      });
    });

    it("submits the typed code via submitCode", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      click(container.querySelector('[data-testid="claude-connect-start"]'));
      await flushReact();

      await pushState({
        cockpit_approved: true,
        anthropic_url: "https://claude.ai/oauth/x",
      });

      const input = container.querySelector('[data-testid="claude-connect-code"]') as HTMLInputElement;
      expect(input.disabled).toBe(false);

      await act(async () => {
        setInputValue(input, "abc-123");
      });
      await flushReact();

      click(container.querySelector('[data-testid="claude-connect-submit"]'));
      await flushReact();

      expect(submitCode).toHaveBeenCalledWith("abc-123");

      await act(async () => {
        root.unmount();
      });
    });

    it("shows the attempt error text when the state carries one", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      click(container.querySelector('[data-testid="claude-connect-start"]'));
      await flushReact();

      await pushState({
        cockpit_approved: true,
        anthropic_url: "https://claude.ai/oauth/x",
        attempt_error: "That code did not work",
      });

      expect(container.textContent).toContain("That code did not work");

      await act(async () => {
        root.unmount();
      });
    });

    it("shows the delivered marker and calls onRecheck when delivered flips true", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      click(container.querySelector('[data-testid="claude-connect-start"]'));
      await flushReact();

      await pushState({
        cockpit_approved: true,
        anthropic_url: "https://claude.ai/oauth/x",
        delivered: true,
      });

      expect(container.querySelector('[data-testid="claude-connect-delivered"]')).not.toBeNull();
      expect(onRecheck).toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    });

    it("shows the error marker and a Try again button when the state carries a terminal error", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      click(container.querySelector('[data-testid="claude-connect-start"]'));
      await flushReact();

      await pushState({ error: "boom" });

      const errorEl = container.querySelector('[data-testid="claude-connect-error"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl?.textContent).toContain("boom");

      const tryAgain = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Try again",
      );
      expect(tryAgain).toBeTruthy();

      await act(async () => {
        root.unmount();
      });
    });

    it("unsubscribes from onState on unmount", async () => {
      const root = await renderStep(container, {
        companyId: "company-1",
        done: false,
        onRecheck,
        rechecking: false,
      });

      await act(async () => {
        root.unmount();
      });

      expect(onStateUnsub).toHaveBeenCalled();
    });
  });
});
