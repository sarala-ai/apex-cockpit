// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonSchemaForm, type JsonSchemaFieldOverride } from "./JsonSchemaForm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("JsonSchemaForm fieldOverrides", () => {
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

  it("substitutes the control for a targeted top-level field, leaving others untouched", async () => {
    const override: JsonSchemaFieldOverride = (path) => {
      if (path === "/target") return <div data-testid="overridden">custom control</div>;
      return undefined;
    };

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              target: { type: "string" },
              other: { type: "string" },
            },
          }}
          values={{ target: "x", other: "y" }}
          onChange={() => {}}
          fieldOverrides={override}
        />,
      );
    });

    expect(container.querySelector('[data-testid="overridden"]')).not.toBeNull();
    // The overridden field shows no plain text <input> for its own control...
    const inputs = container.querySelectorAll("input[type='text']");
    // ...but "other" still renders its normal StringField input.
    expect(inputs.length).toBe(1);
  });

  it("passes value/onChange/disabled/label through the override context", async () => {
    let seenPath: string | null = null;
    let seenValue: unknown;
    let seenLabel: string | null = null;
    let seenRequired: boolean | null = null;

    const onChange = vi.fn();
    const override: JsonSchemaFieldOverride = (path, _schema, ctx) => {
      seenPath = path;
      seenValue = ctx.value;
      seenLabel = ctx.label;
      seenRequired = ctx.isRequired;
      return (
        <button
          type="button"
          data-testid="ctx-button"
          onClick={() => ctx.onChange("changed")}
        >
          {String(ctx.value)}
        </button>
      );
    };

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            required: ["target"],
            properties: {
              target: { type: "string", title: "Target Field" },
            },
          }}
          values={{ target: "initial" }}
          onChange={onChange}
          fieldOverrides={override}
        />,
      );
    });

    expect(seenPath).toBe("/target");
    expect(seenValue).toBe("initial");
    expect(seenLabel).toBe("Target Field");
    expect(seenRequired).toBe(true);

    const button = container.querySelector('[data-testid="ctx-button"]') as HTMLButtonElement;
    expect(button.textContent).toBe("initial");

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ target: "changed" });
  });

  it("still applies FieldWrapper's label/description/error chrome around the override", async () => {
    const override: JsonSchemaFieldOverride = () => <div data-testid="inner" />;

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              target: { type: "string", title: "Target Field", description: "help text" },
            },
          }}
          values={{ target: "x" }}
          onChange={() => {}}
          errors={{ "/target": "bad value" }}
          fieldOverrides={override}
        />,
      );
    });

    expect(container.textContent).toContain("Target Field");
    expect(container.textContent).toContain("help text");
    expect(container.textContent).toContain("bad value");
    expect(container.querySelector('[data-testid="inner"]')).not.toBeNull();
  });

  it("threads overrides into nested object fields with the correctly-prefixed path", async () => {
    let seenPath: string | null = null;
    const override: JsonSchemaFieldOverride = (path) => {
      if (path === "/nested/inner") {
        seenPath = path;
        return <div data-testid="nested-override" />;
      }
      return undefined;
    };

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              nested: {
                type: "object",
                properties: {
                  inner: { type: "string" },
                },
              },
            },
          }}
          values={{ nested: { inner: "v" } }}
          onChange={() => {}}
          fieldOverrides={override}
        />,
      );
    });

    expect(seenPath).toBe("/nested/inner");
    expect(container.querySelector('[data-testid="nested-override"]')).not.toBeNull();
  });

  it("threads overrides into array item fields with an index-suffixed path", async () => {
    const seenPaths: string[] = [];
    const override: JsonSchemaFieldOverride = (path) => {
      if (path.startsWith("/items/")) {
        seenPaths.push(path);
        return <div data-testid={`item-${path}`} />;
      }
      return undefined;
    };

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "string" },
              },
            },
          }}
          values={{ items: ["a", "b"] }}
          onChange={() => {}}
          fieldOverrides={override}
        />,
      );
    });

    expect(seenPaths).toEqual(["/items/0", "/items/1"]);
  });

  it("falls back to the default renderer when the callback returns undefined", async () => {
    const override: JsonSchemaFieldOverride = () => undefined;

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              target: { type: "string" },
            },
          }}
          values={{ target: "x" }}
          onChange={() => {}}
          fieldOverrides={override}
        />,
      );
    });

    expect(container.querySelector("input[type='text']")).not.toBeNull();
  });
});
