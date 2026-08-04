// @vitest-environment jsdom

/**
 * The point of rendering a ticket's type is that the UNDECLARED case stays
 * visible. A blank cell cannot be told apart from a surface that forgot to
 * render the field, so the absence has to say its own name.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TicketTypeChip, ticketTypeDisplayLabel } from "./TicketTypeChip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function chip() {
  return container.querySelector('[data-testid="ticket-type-chip"]')!;
}

describe("a declared type", () => {
  it("uses the same label the composer offered, so the choice is recognisable later", () => {
    render(<TicketTypeChip ticketType="design-change" />);
    expect(chip().textContent).toBe("Design change");
    expect(chip().getAttribute("data-ticket-type")).toBe("design-change");
  });

  it("renders every seeded type", () => {
    for (const [ticketType, label] of [
      ["feature", "Feature"],
      ["bug", "Bug"],
      ["chore", "Chore"],
    ] as const) {
      render(<TicketTypeChip ticketType={ticketType} />);
      expect(chip().textContent).toBe(label);
    }
  });
});

describe("an undeclared type", () => {
  it("says so, rather than rendering nothing", () => {
    render(<TicketTypeChip ticketType={null} />);

    expect(chip().textContent).toBe("No type");
    expect(chip().getAttribute("data-ticket-type")).toBe("undeclared");
  });

  it("explains the consequence on hover, since the gap is the actionable part", () => {
    render(<TicketTypeChip ticketType={undefined} />);
    expect(chip().getAttribute("title")).toContain("runs no process");
  });

  it("is drawn as a gap, not as a type literally named 'No type'", () => {
    render(<TicketTypeChip ticketType={null} />);
    expect(chip().className).toContain("border-dashed");

    render(<TicketTypeChip ticketType="feature" />);
    expect(chip().className).not.toContain("border-dashed");
  });
});

describe("dense rows", () => {
  it("keeps the label reachable to a screen reader when the icon stands alone", () => {
    render(<TicketTypeChip ticketType="bug" showLabel={false} />);
    expect(chip().textContent).toBe("Bug");
    expect(chip().querySelector(".sr-only")).not.toBeNull();
  });
});

describe("the label helper", () => {
  it("is the single place the undeclared wording lives", () => {
    expect(ticketTypeDisplayLabel("feature")).toBe("Feature");
    expect(ticketTypeDisplayLabel(null)).toBe("No type");
    expect(ticketTypeDisplayLabel(undefined)).toBe("No type");
  });
});
