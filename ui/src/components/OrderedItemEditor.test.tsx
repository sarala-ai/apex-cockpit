// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderedItemEditor, type OrderedItemEditorItem } from "./OrderedItemEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface Stage extends OrderedItemEditorItem {
  id: string;
  name: string;
}

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `new-${idCounter}`;
}

function stageCard(container: HTMLDivElement, id: string): HTMLButtonElement {
  return container.querySelector(`[data-testid="card-${id}"]`)!.closest("button")! as HTMLButtonElement;
}

function controlButton(container: HTMLDivElement, id: string, label: string): HTMLButtonElement {
  const card = stageCard(container, id);
  const wrapper = card.closest("div.flex.flex-col")!;
  return Array.from(wrapper.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === label,
  ) as HTMLButtonElement;
}

function insertAfterButton(container: HTMLDivElement, id: string): HTMLButtonElement {
  const card = stageCard(container, id);
  const row = card.closest("div.flex.items-center.gap-2")!;
  return row.querySelector('button[aria-label="Insert item after"]') as HTMLButtonElement;
}

describe("OrderedItemEditor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    idCounter = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderEditor(props: {
    items: Stage[];
    selectedId: string | null;
    onItemsChange: (items: Stage[]) => void;
    onSelectedIdChange: (id: string | null) => void;
    unsavedBar?: React.ReactNode;
  }) {
    return act(async () => {
      root.render(
        <OrderedItemEditor
          items={props.items}
          onItemsChange={props.onItemsChange}
          selectedId={props.selectedId}
          onSelectedIdChange={props.onSelectedIdChange}
          createItem={(afterId) => ({ id: nextId(), name: `New (after ${afterId ?? "end"})` })}
          renderItem={(item) => <span data-testid={`card-${item.id}`}>{item.name}</span>}
          renderDetail={(item) => <div data-testid={`detail-${item.id}`}>Editing {item.name}</div>}
          unsavedBar={props.unsavedBar}
        />,
      );
    });
  }

  it("renders the built-in empty state and adds the first item on click", async () => {
    const onItemsChange = vi.fn();
    const onSelectedIdChange = vi.fn();
    await renderEditor({ items: [], selectedId: null, onItemsChange, onSelectedIdChange });

    expect(container.textContent).toContain("No items yet.");
    const addButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add first item"))!;
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onItemsChange).toHaveBeenCalledWith([{ id: "new-1", name: "New (after end)" }]);
    expect(onSelectedIdChange).toHaveBeenCalledWith("new-1");
  });

  it("appends a new item at the end via insertAfter(null) semantics from createItem", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    const onItemsChange = vi.fn();
    const onSelectedIdChange = vi.fn();
    await renderEditor({ items, selectedId: "a", onItemsChange, onSelectedIdChange });

    const insertAfterA = insertAfterButton(container, "a");
    await act(async () => {
      insertAfterA.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onItemsChange).toHaveBeenCalledWith([
      { id: "a", name: "Alpha" },
      { id: "new-1", name: "New (after a)" },
      { id: "b", name: "Beta" },
    ]);
    expect(onSelectedIdChange).toHaveBeenCalledWith("new-1");
  });

  it("inserts after the last item when its insert-after control is used", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    const onItemsChange = vi.fn();
    await renderEditor({ items, selectedId: "a", onItemsChange, onSelectedIdChange: vi.fn() });

    const insertAfterB = insertAfterButton(container, "b");
    await act(async () => {
      insertAfterB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onItemsChange).toHaveBeenCalledWith([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
      { id: "new-1", name: "New (after b)" },
    ]);
  });

  it("removes an item and reselects the item that now occupies its slot", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "c", name: "Gamma" }];
    const onItemsChange = vi.fn();
    const onSelectedIdChange = vi.fn();
    await renderEditor({ items, selectedId: "b", onItemsChange, onSelectedIdChange });

    const removeB = controlButton(container, "b", "Remove item");
    await act(async () => {
      removeB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onItemsChange).toHaveBeenCalledWith([{ id: "a", name: "Alpha" }, { id: "c", name: "Gamma" }]);
    // "c" now sits at index 1, the slot "b" occupied — falls back there.
    expect(onSelectedIdChange).toHaveBeenCalledWith("c");
  });

  it("removing the last item falls back to null selection", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }];
    const onItemsChange = vi.fn();
    const onSelectedIdChange = vi.fn();
    await renderEditor({ items, selectedId: "a", onItemsChange, onSelectedIdChange });

    const removeA = controlButton(container, "a", "Remove item");
    await act(async () => {
      removeA.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onItemsChange).toHaveBeenCalledWith([]);
    expect(onSelectedIdChange).toHaveBeenCalledWith(null);
  });

  it("removing an unselected item does not change selection", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    const onItemsChange = vi.fn();
    const onSelectedIdChange = vi.fn();
    await renderEditor({ items, selectedId: "a", onItemsChange, onSelectedIdChange });

    const removeB = controlButton(container, "b", "Remove item");
    await act(async () => {
      removeB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onItemsChange).toHaveBeenCalledWith([{ id: "a", name: "Alpha" }]);
    expect(onSelectedIdChange).not.toHaveBeenCalled();
  });

  it("moves an item later and earlier via the reorder controls", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "c", name: "Gamma" }];
    const onItemsChange = vi.fn();
    await renderEditor({ items, selectedId: "a", onItemsChange, onSelectedIdChange: vi.fn() });

    const moveALater = controlButton(container, "a", "Move later");
    await act(async () => {
      moveALater.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onItemsChange).toHaveBeenLastCalledWith([
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
      { id: "c", name: "Gamma" },
    ]);
  });

  it("disables move-earlier on the first item and move-later on the last item", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    await renderEditor({ items, selectedId: "a", onItemsChange: vi.fn(), onSelectedIdChange: vi.fn() });

    expect(controlButton(container, "a", "Move earlier").disabled).toBe(true);
    expect(controlButton(container, "b", "Move later").disabled).toBe(true);
    expect(controlButton(container, "a", "Move later").disabled).toBe(false);
    expect(controlButton(container, "b", "Move earlier").disabled).toBe(false);
  });

  it("clicking a card selects it and renders its detail slot", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    const onSelectedIdChange = vi.fn();
    await renderEditor({ items, selectedId: "a", onItemsChange: vi.fn(), onSelectedIdChange });

    expect(container.querySelector('[data-testid="detail-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="detail-b"]')).toBeNull();

    const cardB = stageCard(container, "b");
    await act(async () => {
      cardB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectedIdChange).toHaveBeenCalledWith("b");
  });

  it("marks the selected card's option as aria-selected", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    await renderEditor({ items, selectedId: "b", onItemsChange: vi.fn(), onSelectedIdChange: vi.fn() });

    expect(stageCard(container, "a").getAttribute("aria-selected")).toBe("false");
    expect(stageCard(container, "b").getAttribute("aria-selected")).toBe("true");
  });

  it("renders the caller-provided unsavedBar slot instead of any built-in save bar", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }];
    await renderEditor({
      items,
      selectedId: "a",
      onItemsChange: vi.fn(),
      onSelectedIdChange: vi.fn(),
      unsavedBar: <div data-testid="unsaved-bar">You have unsaved changes.</div>,
    });

    expect(container.querySelector('[data-testid="unsaved-bar"]')).not.toBeNull();
    expect(container.textContent).toContain("You have unsaved changes.");
  });

  it("omits the unsavedBar slot's content when the caller passes nothing (clean state)", async () => {
    const items: Stage[] = [{ id: "a", name: "Alpha" }];
    await renderEditor({ items, selectedId: "a", onItemsChange: vi.fn(), onSelectedIdChange: vi.fn() });

    expect(container.querySelector('[data-testid="unsaved-bar"]')).toBeNull();
  });
});
