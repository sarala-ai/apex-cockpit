// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySlugBreakGlassDialog } from "./CompanySlugBreakGlassDialog";

const mockCompaniesApi = vi.hoisted(() => ({
  slugBreakGlassPreview: vi.fn(),
  slugBreakGlassExecute: vi.fn(),
}));

vi.mock("@/api/companies", () => ({ companiesApi: mockCompaniesApi }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function teardown() {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
}

async function renderNode(node: ReactNode) {
  teardown();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  await flush();
}

async function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("input not found");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

function q<T extends Element = Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function makeConsequences(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company-1",
    currentSlug: "acme",
    proposedSlug: "acme-2",
    envVarsThatChange: [
      { kind: "env_var", current: "APEX_ACME_WORKFLOWS_PATH", next: "APEX_ACME-2_WORKFLOWS_PATH", note: "n/a" },
    ],
    capabilitySyncTargets: [
      { kind: "capability_sync_path", current: "~/.apex/company/acme/", next: "~/.apex/company/acme-2/", note: "n/a" },
    ],
    boundRepoConfigs: [{ repo: "acme/finpilot", note: "stale" }],
    warning: "1 bound repo(s) may carry the old slug in committed config",
    ...overrides,
  };
}

beforeEach(() => {
  mockCompaniesApi.slugBreakGlassPreview.mockResolvedValue({
    preview: true,
    consequences: makeConsequences(),
  });
  mockCompaniesApi.slugBreakGlassExecute.mockResolvedValue({
    preview: false,
    consequences: makeConsequences(),
    company: { id: "company-1", slug: "acme-2" },
    activityId: "activity-1",
  });
});

afterEach(() => {
  teardown();
  vi.clearAllMocks();
});

describe("CompanySlugBreakGlassDialog", () => {
  it("fetches and shows the consequences report before the confirm input appears", async () => {
    await renderNode(
      <CompanySlugBreakGlassDialog
        companyId="company-1"
        currentSlug="acme"
        open
        onOpenChange={() => {}}
      />,
    );

    expect(q("[data-testid='slug-break-glass-confirm-input']")).toBeNull();

    await type(q<HTMLInputElement>("[data-testid='slug-break-glass-new-slug']"), "acme-2");
    await click(q("[data-testid='slug-break-glass-preview-button']"));

    expect(mockCompaniesApi.slugBreakGlassPreview).toHaveBeenCalledWith("company-1", "acme-2");
    expect(q("[data-testid='slug-break-glass-consequences']")).not.toBeNull();
    expect(document.body.textContent).toContain("APEX_ACME_WORKFLOWS_PATH");
    expect(document.body.textContent).toContain("acme/finpilot");
    expect(q("[data-testid='slug-break-glass-confirm-input']")).not.toBeNull();
  });

  it("keeps the confirm button disabled until the CURRENT slug is typed exactly", async () => {
    await renderNode(
      <CompanySlugBreakGlassDialog
        companyId="company-1"
        currentSlug="acme"
        open
        onOpenChange={() => {}}
      />,
    );

    await type(q<HTMLInputElement>("[data-testid='slug-break-glass-new-slug']"), "acme-2");
    await click(q("[data-testid='slug-break-glass-preview-button']"));

    const executeButton = q<HTMLButtonElement>("[data-testid='slug-break-glass-execute-button']");
    expect(executeButton?.disabled).toBe(true);

    await type(q<HTMLInputElement>("[data-testid='slug-break-glass-confirm-input']"), "wrong-slug");
    expect(q<HTMLButtonElement>("[data-testid='slug-break-glass-execute-button']")?.disabled).toBe(true);

    await type(q<HTMLInputElement>("[data-testid='slug-break-glass-confirm-input']"), "acme");
    expect(q<HTMLButtonElement>("[data-testid='slug-break-glass-execute-button']")?.disabled).toBe(false);
  });

  it("executes the change once confirmed and shows the recorded audit entry reference", async () => {
    await renderNode(
      <CompanySlugBreakGlassDialog
        companyId="company-1"
        currentSlug="acme"
        open
        onOpenChange={() => {}}
      />,
    );

    await type(q<HTMLInputElement>("[data-testid='slug-break-glass-new-slug']"), "acme-2");
    await click(q("[data-testid='slug-break-glass-preview-button']"));
    await type(q<HTMLInputElement>("[data-testid='slug-break-glass-confirm-input']"), "acme");
    await click(q("[data-testid='slug-break-glass-execute-button']"));

    expect(mockCompaniesApi.slugBreakGlassExecute).toHaveBeenCalledWith("company-1", "acme-2", "acme");
    expect(document.body.textContent).toContain("activity-1");
    expect(document.body.textContent).toContain("acme-2");
  });
});
