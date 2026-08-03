// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Target } from "lucide-react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("offers only the primary action when there is no bulk route", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={Target} message="No goals yet." action="Add Goal" onAction={() => {}} />,
    );

    expect(html).toContain("Add Goal");
    expect(html).not.toContain("Reconstruct");
  });

  /**
   * The brownfield case. A board that is empty because the work happened
   * elsewhere needs a bulk route, and the footnote is load-bearing: it is what
   * keeps a route that produces a PROPOSAL from reading as an import.
   */
  it("renders a secondary bulk route with its footnote", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={Target}
        message="No goals yet."
        action="Add Goal"
        onAction={() => {}}
        secondaryAction="Reconstruct from the repos"
        onSecondaryAction={() => {}}
        footnote="It writes nothing on its own."
      />,
    );

    expect(html).toContain("Add Goal");
    expect(html).toContain("Reconstruct from the repos");
    expect(html).toContain("It writes nothing on its own.");
  });

  it("disables the bulk route while it is starting", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={Target}
        message="No goals yet."
        secondaryAction="Reconstruct from the repos"
        onSecondaryAction={() => {}}
        secondaryActionPending
      />,
    );

    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
  });
});
