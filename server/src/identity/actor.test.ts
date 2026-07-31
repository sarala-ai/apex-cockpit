import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../apex/exec.js", () => ({ run: runMock }));

const { resolveLocalActor, actorId, clearActorCache } = await import("./actor.js");

function reply(map: Record<string, string | null>) {
  runMock.mockImplementation(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    const value = hit?.[1];
    return value == null
      ? { status: "failed", stdout: "", stderr: "not configured" }
      : { status: "ok", stdout: `${value}\n`, stderr: "" };
  });
}

describe("resolveLocalActor", () => {
  beforeEach(() => {
    clearActorCache();
    runMock.mockReset();
  });

  it("prefers the gcloud account — the identity cloud audit logs will show", async () => {
    reply({
      "gcloud config": "founder@sarala.ai",
      "git config --get user.email": "personal@example.com",
      "git config --get user.name": "Srinivas",
      "gh api user": "coolksrini",
    });
    const actor = await resolveLocalActor();
    expect(actorId(actor)).toBe("founder@sarala.ai");
    expect(actor.name).toBe("Srinivas");
    expect(actor.sources).toEqual({
      gcloud: "founder@sarala.ai",
      git: "personal@example.com",
      github: "coolksrini",
    });
    expect(actor.unresolved).toBe(false);
  });

  it("falls back to git, then github, when gcloud is unset", async () => {
    reply({ "git config --get user.email": "dev@example.com", "gh api user": "octocat" });
    expect(actorId(await resolveLocalActor())).toBe("dev@example.com");

    clearActorCache();
    reply({ "gh api user": "octocat" });
    const ghOnly = await resolveLocalActor();
    expect(actorId(ghOnly)).toBe("octocat");
    expect(ghOnly.name).toBe("octocat");
  });

  it("reports unresolved rather than inventing a plausible identity", async () => {
    reply({});
    const actor = await resolveLocalActor();
    expect(actor.unresolved).toBe(true);
    // The old placeholder is exactly what must never reappear.
    expect(actor.email).not.toBe("local@paperclip.local");
  });

  it("treats gcloud's '(unset)' sentinel as absent", async () => {
    reply({ "gcloud config": "(unset)", "git config --get user.email": "dev@example.com" });
    expect(actorId(await resolveLocalActor())).toBe("dev@example.com");
  });

  it("resolves git identity from the REPO, so per-repo config wins", async () => {
    const seen: Array<string | undefined> = [];
    runMock.mockImplementation(async (cmd: string, args: string[], _t: number, cwd?: string) => {
      if (cmd === "git") {
        seen.push(cwd);
        return {
          status: "ok",
          stdout: cwd === "/repos/bloom" ? "work@sarala.ai\n" : "personal@example.com\n",
          stderr: "",
        };
      }
      return { status: "failed", stdout: "", stderr: "" };
    });
    const inRepo = await resolveLocalActor("/repos/bloom");
    expect(actorId(inRepo)).toBe("work@sarala.ai");
    expect(seen).toContain("/repos/bloom");

    // Different repo path is cached separately, not reused.
    const global = await resolveLocalActor();
    expect(actorId(global)).toBe("personal@example.com");
  });

  it("falls back to machine identity when no credential resolves", async () => {
    reply({});
    const actor = await resolveLocalActor();
    expect(actor.unresolved).toBe(true);
    expect(actor.origin.user).toBeTruthy();
    expect(actor.origin.host).toBeTruthy();
    expect(actorId(actor)).toBe(`${actor.origin.user}@${actor.origin.host}`);
    expect(actorId(actor)).not.toBe("unknown");
  });

  it("caches so every request does not re-probe the CLIs", async () => {
    reply({ "gcloud config": "founder@sarala.ai" });
    await resolveLocalActor();
    const callsAfterFirst = runMock.mock.calls.length;
    await resolveLocalActor();
    expect(runMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
