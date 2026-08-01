import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Generic controlled ordered-list-plus-detail editor, extracted as a PATTERN
 * from PipelineSettings's stage editor (ordered stage cards, insert-after,
 * a selected-stage detail form, and a sticky unsaved-changes bar) — see
 * ui/src/pages/PipelineSettings.tsx for the original. This component keeps
 * ONLY the interaction shape; PipelineSettings's per-stage DB-CRUD
 * persistence (create/delete/reorder mutations hitting the API) does NOT
 * come along. Migrating PipelineSettings itself onto this component is a
 * later, separate task — it is not done in this change.
 *
 * Fully in-memory / controlled: the caller owns `items` and `selectedId` as
 * state; this component computes the next array for add/insertAfter/remove/
 * reorder and hands it back via `onItemsChange` (never mutates in place), and
 * separately reports selection changes via `onSelectedIdChange`. It has no
 * opinion on persistence, dirty-tracking, or save — the "unsaved changes bar"
 * is a plain render slot (`unsavedBar`) the caller fills with whatever it
 * wants shown, driven by whatever dirty-comparison logic the caller already
 * has (e.g. comparing `items` against a last-saved snapshot).
 */
export interface OrderedItemEditorItem {
  id: string;
}

export interface OrderedItemEditorProps<T extends OrderedItemEditorItem> {
  /** The ordered items, in display order. */
  items: T[];
  /** Called with the full next array whenever add/insertAfter/remove/reorder
   *  changes it. Never called for selection-only changes. */
  onItemsChange: (items: T[]) => void;
  /** Currently selected item's id, or null if nothing is selected. */
  selectedId: string | null;
  /** Called whenever the selection changes — including the editor's own
   *  follow-selection behavior after add/remove. */
  onSelectedIdChange: (id: string | null) => void;
  /** Factory for a new item. `afterId` is the id of the item being inserted
   *  after, or null when adding at the end (or as the very first item). The
   *  caller decides the new item's id/name/defaults; this component only
   *  decides where it lands in the array. */
  createItem: (afterId: string | null) => T;
  /** Renders a list item's card content (label, badges, etc). */
  renderItem: (item: T, index: number, isSelected: boolean) => ReactNode;
  /** Renders the selected item's detail form. Not called when nothing is
   *  selected (e.g. an empty list). */
  renderDetail: (item: T, index: number) => ReactNode;
  /** Rendered instead of the list+detail split when `items` is empty. If
   *  omitted, a minimal built-in empty state with an "Add first item" button
   *  is used. */
  emptyState?: ReactNode;
  /** Unsaved-changes bar slot — rendered below the detail area. The caller
   *  computes its own dirty state and passes whatever it wants shown (or
   *  nothing, when clean). */
  unsavedBar?: ReactNode;
  /** Per-item override for whether the remove control is shown. Defaults to
   *  always removable. */
  canRemove?: (item: T) => boolean;
  /** Per-item override for whether the "insert after" control is shown.
   *  Defaults to always insertable. */
  canInsertAfter?: (item: T) => boolean;
  className?: string;
  listClassName?: string;
  itemsAriaLabel?: string;
}

function insertionIndex<T extends OrderedItemEditorItem>(items: T[], afterId: string | null): number {
  if (afterId === null) return items.length;
  const afterIndex = items.findIndex((item) => item.id === afterId);
  return afterIndex === -1 ? items.length : afterIndex + 1;
}

export function OrderedItemEditor<T extends OrderedItemEditorItem>({
  items,
  onItemsChange,
  selectedId,
  onSelectedIdChange,
  createItem,
  renderItem,
  renderDetail,
  emptyState,
  unsavedBar,
  canRemove = () => true,
  canInsertAfter = () => true,
  className,
  listClassName,
  itemsAriaLabel = "Items",
}: OrderedItemEditorProps<T>) {
  const selectedIndex = items.findIndex((item) => item.id === selectedId);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : null;

  function handleAdd(afterId: string | null) {
    const newItem = createItem(afterId);
    const index = insertionIndex(items, afterId);
    const next = [...items.slice(0, index), newItem, ...items.slice(index)];
    onItemsChange(next);
    onSelectedIdChange(newItem.id);
  }

  function handleRemove(id: string) {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const next = items.filter((item) => item.id !== id);
    onItemsChange(next);
    if (selectedId === id) {
      const fallback = next[Math.min(index, next.length - 1)] ?? null;
      onSelectedIdChange(fallback ? fallback.id : null);
    }
  }

  function handleMove(id: string, direction: -1 | 1) {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    onItemsChange(next);
  }

  if (items.length === 0) {
    return (
      <div className={className}>
        {emptyState ?? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No items yet.
            <div className="mt-3">
              <Button type="button" size="sm" onClick={() => handleAdd(null)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add first item
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div role="listbox" aria-label={itemsAriaLabel} className={cn("flex flex-wrap items-start gap-2", listClassName)}>
        {items.map((item, index) => {
          const isSelected = item.id === selectedId;
          return (
            <div key={item.id} className="flex items-center gap-2">
              <div className="flex flex-col items-stretch gap-1">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelectedIdChange(item.id)}
                  className={cn(
                    "min-w-40 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    isSelected
                      ? "border-foreground/40 ring-2 ring-foreground/25"
                      : "border-border hover:ring-1 hover:ring-foreground/10",
                  )}
                >
                  {renderItem(item, index, isSelected)}
                </button>
                <div className="flex items-center justify-center gap-1">
                  <button
                    type="button"
                    aria-label="Move earlier"
                    disabled={index === 0}
                    onClick={() => handleMove(item.id, -1)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move later"
                    disabled={index === items.length - 1}
                    onClick={() => handleMove(item.id, 1)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {canRemove(item) ? (
                    <button
                      type="button"
                      aria-label="Remove item"
                      onClick={() => handleRemove(item.id)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              {canInsertAfter(item) ? (
                <button
                  type="button"
                  aria-label="Insert item after"
                  onClick={() => handleAdd(item.id)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {selectedItem ? <div className="space-y-4">{renderDetail(selectedItem, selectedIndex)}</div> : null}

      {unsavedBar}
    </div>
  );
}
