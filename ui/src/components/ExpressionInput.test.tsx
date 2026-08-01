// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpressionInput, isReferenceLikeExpression, type ExpressionReference } from "./ExpressionInput";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const REFERENCES: ExpressionReference[] = [
  { label: "Build step → image tag", value: "${steps.build.image_tag}" },
  { label: "Deploy step → service URL", value: "${steps.deploy.service_url}" },
];

describe("isReferenceLikeExpression", () => {
  it("recognizes ${...} as reference-like", () => {
    expect(isReferenceLikeExpression("${steps.build.image_tag}")).toBe(true);
  });

  it("rejects plain literals", () => {
    expect(isReferenceLikeExpression("gcr.io/my-project/app:latest")).toBe(false);
    expect(isReferenceLikeExpression("")).toBe(false);
  });
});

describe("ExpressionInput", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("defaults to literal mode for a plain string value and renders a text input", async () => {
    await act(async () => {
      root.render(<ExpressionInput value="hello" onChange={() => {}} references={REFERENCES} />);
    });
    const input = container.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("hello");
    expect(container.querySelector("select")).toBeNull();
  });

  it("defaults to reference mode when the initial value looks like a reference expression", async () => {
    await act(async () => {
      root.render(
        <ExpressionInput value="${steps.build.image_tag}" onChange={() => {}} references={REFERENCES} />,
      );
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("${steps.build.image_tag}");
  });

  it("calls onChange with the raw typed string in literal mode", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<ExpressionInput value="" onChange={onChange} references={REFERENCES} />);
    });
    const input = container.querySelector("input[type='text']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "gcr.io/foo:latest");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("gcr.io/foo:latest");
  });

  it("switches to reference mode via the toggle and lists the given references", async () => {
    await act(async () => {
      root.render(<ExpressionInput value="" onChange={() => {}} references={REFERENCES} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const referenceToggle = buttons.find((button) => button.textContent?.includes("Reference"))!;
    await act(async () => {
      referenceToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const optionLabels = Array.from(select.querySelectorAll("option")).map((option) => option.textContent);
    expect(optionLabels).toContain("Build step → image tag");
    expect(optionLabels).toContain("Deploy step → service URL");
  });

  it("stores the reference's raw expression string when one is picked from the select", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<ExpressionInput value="${steps.build.image_tag}" onChange={onChange} references={REFERENCES} />);
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "${steps.deploy.service_url}");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("${steps.deploy.service_url}");
  });

  it("disables the reference toggle when no references are supplied", async () => {
    await act(async () => {
      root.render(<ExpressionInput value="" onChange={() => {}} references={[]} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const referenceToggle = buttons.find((button) => button.textContent?.includes("Reference"))!;
    expect(referenceToggle.disabled).toBe(true);
  });

  it("switching back to literal mode preserves the raw string value in the text input", async () => {
    await act(async () => {
      root.render(<ExpressionInput value="${steps.build.image_tag}" onChange={() => {}} references={REFERENCES} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const literalToggle = buttons.find((button) => button.textContent?.includes("Literal"))!;
    await act(async () => {
      literalToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = container.querySelector("input[type='text']") as HTMLInputElement;
    expect(input.value).toBe("${steps.build.image_tag}");
  });
});
