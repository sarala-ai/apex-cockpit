export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /**
   * Work that stopped and is waiting on THIS person — a step that refused to
   * advance, counted for whoever is answerable for the ticket. Not a count of
   * everything in flight: a step parked on an agent that is working is not a
   * problem and is deliberately absent, because a badge that is always lit is
   * a badge nobody reads. Derived on every read, so it falls to zero on its
   * own when the hold clears — there is nothing to dismiss.
   */
  stoppedSteps: number;
}
