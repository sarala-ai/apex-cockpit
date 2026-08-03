/**
 * THE MANIFEST TEST — the reason it is safe to say "this is what gets erased".
 *
 * The erasure service claims a complete, hand-written classification of every
 * company-scoped table. That claim decays the moment someone adds a table and
 * forgets, and it decays SILENTLY: the erasure keeps working, it just quietly
 * stops erasing something. So the claim is asserted here against the live
 * Drizzle schema rather than documented and hoped for.
 */
import { describe, expect, it } from "vitest";
import {
  companyErasureDeleteOrder,
  companyScopedTableNames,
  erasedTableNames,
  erasedTablesForTest,
  preservedTableNames,
  topologicalDeleteOrder,
} from "../services/company-data-erasure.js";

describe("company data erasure manifest", () => {
  it("classifies every company-scoped table as erased or preserved", () => {
    const classified = new Set([...erasedTableNames(), ...preservedTableNames()]);
    const unclassified = companyScopedTableNames().filter((name) => !classified.has(name));
    expect(
      unclassified,
      "New company-scoped tables must be classified in ERASED_TABLES or PRESERVED_TABLES " +
        "in server/src/services/company-data-erasure.ts — an unclassified table is data " +
        "an erasure would silently leave behind.",
    ).toEqual([]);
  });

  it("classifies nothing that is not company-scoped", () => {
    const scoped = new Set(companyScopedTableNames());
    const stray = [...erasedTableNames(), ...preservedTableNames()].filter((name) => !scoped.has(name));
    expect(stray).toEqual([]);
  });

  it("never lists a table as both erased and preserved", () => {
    const preserved = new Set(preservedTableNames());
    expect(erasedTableNames().filter((name) => preserved.has(name))).toEqual([]);
  });

  it("preserves the company's identity, access and credentials", () => {
    const preserved = new Set(preservedTableNames());
    for (const table of [
      "company_memberships",
      "principal_permission_grants",
      "invites",
      "company_logos",
      "company_secrets",
      "company_secret_bindings",
      "labels",
      "pipelines",
      "company_skills",
    ]) {
      expect(preserved, `${table} must survive an erasure`).toContain(table);
    }
  });

  it("erases the board", () => {
    const erased = new Set(erasedTableNames());
    for (const table of ["issues", "goals", "projects", "cases", "proposals", "activity_log"]) {
      expect(erased, `${table} must be erased`).toContain(table);
    }
  });

  /**
   * THE WORKFORCE SURVIVES; ITS WORK DOES NOT.
   *
   * The pair of assertions is the point, and neither half means anything
   * alone. An agent row is a name, a role, an adapter, a permission set and an
   * instruction prompt — configuration, in the same class as memberships,
   * secrets and pipeline definitions, all preserved. Its runs, sessions, wakeups
   * and runtime state are the work, and they go.
   *
   * Erasing the records is what left a reset company with no workforce and no
   * in-product way to recover one (`enableBuiltInAgents` is off by default, so
   * the provisioning routes 404) — and, once lifecycle agent steps resolve
   * their executor by roster key, with every agent step permanently held.
   */
  it("preserves the workforce records and erases what the workforce did", () => {
    const preserved = new Set(preservedTableNames());
    for (const table of ["agents", "agent_memberships", "agent_api_keys", "agent_config_revisions"]) {
      expect(preserved, `${table} is configuration and must survive an erasure`).toContain(table);
    }
    const erased = new Set(erasedTableNames());
    for (const table of [
      "heartbeat_runs",
      "heartbeat_run_events",
      "agent_runtime_state",
      "agent_task_sessions",
      "agent_wakeup_requests",
      "cost_events",
    ]) {
      expect(erased, `${table} is work and must be erased`).toContain(table);
    }
  });

  it("produces a delete order with no blocking-FK cycle", () => {
    const { cycle } = topologicalDeleteOrder(erasedTablesForTest());
    expect(cycle).toEqual([]);
  });

  it("orders every child before the parent it hard-references", () => {
    const order = companyErasureDeleteOrder();
    const position = new Map(order.map((name, index) => [name, index]));
    // Spot-checks of the edges that would actually fail the transaction if the
    // sort regressed — each is `no action` or `restrict` in the schema.
    // `agents` is no longer here as a parent: it is PRESERVED, so an edge
    // pointing at it is out of scope for the sort and orders nothing. The
    // edges that remain are the ones that would still fail the transaction.
    const mustPrecede: Array<[string, string]> = [
      ["issues", "goals"],
      ["issues", "projects"],
      ["cost_events", "issues"],
      ["finance_events", "cost_events"],
      ["feedback_votes", "issues"],
      ["company_skill_test_runs", "issues"],
      ["heartbeat_runs", "agent_wakeup_requests"],
      ["heartbeat_run_events", "heartbeat_runs"],
      ["agent_task_sessions", "heartbeat_runs"],
      ["approval_comments", "approvals"],
      ["budget_incidents", "approvals"],
    ];
    for (const [child, parent] of mustPrecede) {
      expect(position.get(child), `${child} missing from delete order`).toBeDefined();
      expect(position.get(parent), `${parent} missing from delete order`).toBeDefined();
      expect(
        position.get(child)! < position.get(parent)!,
        `${child} must be deleted before ${parent}`,
      ).toBe(true);
    }
  });

  it("covers every erased table exactly once in the delete order", () => {
    const order = companyErasureDeleteOrder();
    expect([...order].sort()).toEqual(erasedTableNames());
    expect(new Set(order).size).toBe(order.length);
  });
});
