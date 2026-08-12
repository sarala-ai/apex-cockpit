import { describe, expect, it } from "vitest";
import {
  ownerNameFromRepoUrl,
  resolveDesignCoordinates,
} from "../apex/pipeline/contract-targets.js";
import type { Db } from "@paperclipai/db";

function dbReturning(workspace: Record<string, unknown> | null): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => ({ then: (fn: (rows: unknown[]) => unknown) => fn(workspace ? [workspace] : []) }),
  };
  return { select: () => chain } as unknown as Db;
}

const ws = (over: Record<string, unknown> = {}) => ({
  name: "primary",
  repoUrl: null,
  designRepo: null,
  designPath: null,
  ...over,
});

describe("ownerNameFromRepoUrl", () => {
  it("accepts the three forms a workspace actually stores", () => {
    // ssh with a host alias — the form this instance uses for its own repos.
    expect(ownerNameFromRepoUrl("git@github.com-ck:sarala-ai/apex-design.git")).toBe("sarala-ai/apex-design");
    expect(ownerNameFromRepoUrl("git@github.com:sarala-ai/apex-core.git")).toBe("sarala-ai/apex-core");
    expect(ownerNameFromRepoUrl("https://github.com/sarala-ai/apex-cockpit")).toBe("sarala-ai/apex-cockpit");
    expect(ownerNameFromRepoUrl("https://github.com/sarala-ai/apex-cockpit.git")).toBe("sarala-ai/apex-cockpit");
    // Already a slug.
    expect(ownerNameFromRepoUrl("sarala-ai/apex-design")).toBe("sarala-ai/apex-design");
  });

  it("returns null rather than a half-parsed guess", () => {
    expect(ownerNameFromRepoUrl(null)).toBeNull();
    expect(ownerNameFromRepoUrl("")).toBeNull();
    expect(ownerNameFromRepoUrl("/Users/srinivas/Dev/repos/thing")).toBeNull();
    expect(ownerNameFromRepoUrl("https://github.com/onlyowner")).toBeNull();
  });
});

describe("resolveDesignCoordinates — the two real shapes", () => {
  it("SEPARATE REPO: an explicit designRepo wins over the project's own repo", async () => {
    const result = await resolveDesignCoordinates(
      dbReturning(ws({
        repoUrl: "git@github.com-ck:sarala-ai/apex-cockpit.git",
        designRepo: "sarala-ai/apex-design",
        designPath: "product",
      })),
      { companyId: "c1", projectId: "p1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.coordinates).toEqual({ repo: "sarala-ai/apex-design", path: "product" });
  });

  it("MONOREPO: no designRepo means design lives in the project's own repo", async () => {
    const result = await resolveDesignCoordinates(
      dbReturning(ws({
        repoUrl: "git@github.com-ck:sarala-ai/apex-cockpit.git",
        designPath: "design/boards",
      })),
      { companyId: "c1", projectId: "p1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coordinates).toEqual({ repo: "sarala-ai/apex-cockpit", path: "design/boards" });
    }
  });

  it("normalises the path so templates can join it without guessing separators", async () => {
    const result = await resolveDesignCoordinates(
      dbReturning(ws({ designRepo: "o/n", designPath: "  /product/  " })),
      { companyId: "c1", projectId: "p1" },
    );
    expect(result.ok && result.coordinates.path).toBe("product");
  });

  it("an unset path means the repository root, not a failure", async () => {
    const result = await resolveDesignCoordinates(
      dbReturning(ws({ designRepo: "o/n" })),
      { companyId: "c1", projectId: "p1" },
    );
    expect(result.ok && result.coordinates.path).toBe("");
  });
});

describe("resolveDesignCoordinates — refusals", () => {
  it("HOLDS when nothing names a repo, instead of defaulting to one", async () => {
    // The whole point. The default anyone would reach for is "the repo we
    // always used", and on a company-shared lifecycle that pushes one
    // company's design into another's repository.
    const result = await resolveDesignCoordinates(
      dbReturning(ws({ repoUrl: "/Users/srinivas/Dev/repos/thing" })),
      { companyId: "c1", projectId: "p1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe("design_repo_not_configured");
      // The message must say what to declare and where.
      expect(result.message).toContain("designRepo");
      expect(result.message).toContain("designPath");
    }
  });

  it("refuses a designRepo that is not owner/name", async () => {
    const result = await resolveDesignCoordinates(
      dbReturning(ws({ designRepo: "https://github.com/o/n" })),
      { companyId: "c1", projectId: "p1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe("design_repo_not_configured");
  });

  it("refuses when there is no project, and when the project has no workspace", async () => {
    const noProject = await resolveDesignCoordinates(dbReturning(null), {
      companyId: "c1", projectId: null,
    });
    expect(noProject.ok).toBe(false);
    if (!noProject.ok) expect(noProject.errorType).toBe("design_source_unresolvable");

    const noWorkspace = await resolveDesignCoordinates(dbReturning(null), {
      companyId: "c1", projectId: "p1",
    });
    expect(noWorkspace.ok).toBe(false);
    if (!noWorkspace.ok) expect(noWorkspace.errorType).toBe("design_source_unresolvable");
  });
});
