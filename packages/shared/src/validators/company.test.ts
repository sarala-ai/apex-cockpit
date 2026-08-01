import { describe, expect, it } from "vitest";
import {
  companySlugSchema,
  createCompanySchema,
  updateCompanySchema,
} from "./company.js";

describe("companySlugSchema", () => {
  it("accepts a well-formed lowercase slug", () => {
    expect(companySlugSchema.parse("acme")).toBe("acme");
    expect(companySlugSchema.parse("acme-corp-2")).toBe("acme-corp-2");
  });

  it("normalizes uppercase input to lowercase", () => {
    expect(companySlugSchema.parse("ACME")).toBe("acme");
    expect(companySlugSchema.parse("Acme-Corp")).toBe("acme-corp");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(companySlugSchema.parse("  acme  ")).toBe("acme");
  });

  it("rejects a slug that starts with a digit", () => {
    expect(() => companySlugSchema.parse("1acme")).toThrow();
  });

  it("rejects a slug that starts with a hyphen", () => {
    expect(() => companySlugSchema.parse("-acme")).toThrow();
  });

  it("rejects a single-character slug (minimum length is 2)", () => {
    expect(() => companySlugSchema.parse("a")).toThrow();
  });

  it("rejects underscores and other non-hyphen punctuation", () => {
    expect(() => companySlugSchema.parse("acme_corp")).toThrow();
    expect(() => companySlugSchema.parse("acme.corp")).toThrow();
    expect(() => companySlugSchema.parse("acme corp")).toThrow();
  });

  it("rejects a slug longer than 32 characters", () => {
    const tooLong = "a" + "b".repeat(32);
    expect(tooLong).toHaveLength(33);
    expect(() => companySlugSchema.parse(tooLong)).toThrow();
  });

  it("accepts the maximum length of 32 characters", () => {
    const maxLength = "a" + "b".repeat(31);
    expect(maxLength).toHaveLength(32);
    expect(companySlugSchema.parse(maxLength)).toBe(maxLength);
  });
});

describe("createCompanySchema — slug", () => {
  it("is optional — omitting it is valid", () => {
    const parsed = createCompanySchema.parse({ name: "Acme" });
    expect(parsed.slug).toBeUndefined();
  });

  it("normalizes and validates a supplied slug", () => {
    const parsed = createCompanySchema.parse({ name: "Acme", slug: "ACME" });
    expect(parsed.slug).toBe("acme");
  });

  it("rejects a malformed supplied slug", () => {
    expect(() => createCompanySchema.parse({ name: "Acme", slug: "not valid!" })).toThrow();
  });
});

describe("updateCompanySchema — github projection", () => {
  it("accepts enabling with an owner/name repo", () => {
    const parsed = updateCompanySchema.parse({
      githubProjectionEnabled: true,
      githubProjectionRepo: "sarala-ai/apex",
    });
    expect(parsed.githubProjectionEnabled).toBe(true);
    expect(parsed.githubProjectionRepo).toBe("sarala-ai/apex");
  });

  it("accepts disabling and clearing the repo", () => {
    const parsed = updateCompanySchema.parse({
      githubProjectionEnabled: false,
      githubProjectionRepo: null,
    });
    expect(parsed.githubProjectionEnabled).toBe(false);
    expect(parsed.githubProjectionRepo).toBeNull();
  });

  it("rejects a repo that is not owner/name shaped", () => {
    expect(() => updateCompanySchema.parse({ githubProjectionRepo: "not-a-repo" })).toThrow();
    expect(() => updateCompanySchema.parse({ githubProjectionRepo: "a/b/c" })).toThrow();
    expect(() => updateCompanySchema.parse({ githubProjectionRepo: "a b/c" })).toThrow();
  });

  it("both fields are optional — omitting them is valid", () => {
    const parsed = updateCompanySchema.parse({ name: "Acme" });
    expect(parsed.githubProjectionEnabled).toBeUndefined();
    expect(parsed.githubProjectionRepo).toBeUndefined();
  });
});

describe("updateCompanySchema — slug", () => {
  it("is optional — omitting it is valid", () => {
    const parsed = updateCompanySchema.parse({ name: "Acme" });
    expect(parsed.slug).toBeUndefined();
  });

  it("normalizes and validates a supplied slug", () => {
    const parsed = updateCompanySchema.parse({ slug: "New-Slug" });
    expect(parsed.slug).toBe("new-slug");
  });

  it("rejects a malformed supplied slug", () => {
    expect(() => updateCompanySchema.parse({ slug: "Not Valid" })).toThrow();
  });
});
