import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// Import after mocks are hoisted
const { subscriptionBridgeRouter, bridgeAuthMiddleware } = await import(
  "../apex/model-access/subscription-bridge.js"
);

function makeFakeProc(opts: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn((signal?: string) => {
    proc.emit("close", signal === "SIGTERM" ? 143 : 1);
  });

  // Simulate async I/O on next tick
  setImmediate(() => {
    if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
    proc.emit("close", opts.exitCode ?? 0);
  });

  return proc;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/bridge/v1", subscriptionBridgeRouter());
  return app;
}

describe("subscriptionBridgeRouter — prompt serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a single user message as plain text to stdin", async () => {
    // Use mockImplementation so makeFakeProc is called lazily when spawn fires,
    // not eagerly at mockReturnValue time (which fires setImmediate too early).
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "great" }));
    await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hello" }] });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0];
    // --max-turns 1 must be present (first defense layer)
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    // --disallowedTools must carry the full built-in deny-list (second defense layer;
    // --tools "" is a fake flag silently ignored by the CLI — regression guard).
    expect(args).toContain("--disallowedTools");
    const denyList = args[args.indexOf("--disallowedTools") + 1] as string;
    const deniedNames = denyList.split(",");
    expect(deniedNames).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch"]),
    );
    expect(denyList).not.toBe(""); // must not be the fake empty-string form

    // stdin receives the user content directly (no role prefix for single message)
    const written: string = mockSpawn.mock.results[0].value.stdin.write.mock.calls[0][0];
    expect(written).toContain("hello");
    expect(written).not.toMatch(/^Human:/m);
  });

  it("prepends system message in <system> tags", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "ok" }));
    await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({
        messages: [
          { role: "system", content: "You are a judge" },
          { role: "user", content: "Rate this" },
        ],
      });

    const written: string = mockSpawn.mock.results[0].value.stdin.write.mock.calls[0][0];
    expect(written).toMatch(/<system>\nYou are a judge\n<\/system>/);
    expect(written).toContain("Rate this");
  });

  it("serializes multi-turn history with Human/Assistant prefixes", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "final" }));
    await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({
        messages: [
          { role: "user", content: "Q1" },
          { role: "assistant", content: "A1" },
          { role: "user", content: "Q2" },
        ],
      });

    const written: string = mockSpawn.mock.results[0].value.stdin.write.mock.calls[0][0];
    expect(written).toMatch(/Human: Q1/);
    expect(written).toMatch(/Assistant: A1/);
    expect(written).toMatch(/Human: Q2/);
  });

  it("returns the response text in an OpenAI-compatible shape", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "verdict: correct\n" }));
    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "evaluate" }] });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.choices[0].message.content).toBe("verdict: correct");
  });
});

describe("subscriptionBridgeRouter — error taxonomy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps auth errors to 401", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ exitCode: 1, stderr: "not authenticated" }));
    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "x" }] });

    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
  });

  it("maps ENOENT (missing CLI) to 503", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
      return proc;
    });

    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "x" }] });

    expect(res.status).toBe(503);
  });

  it("maps generic claude failures to 502", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ exitCode: 1, stderr: "unexpected internal error" }));
    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "x" }] });

    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe("upstream_error");
  });

  it("returns 400 for empty messages array", async () => {
    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [] });

    expect(res.status).toBe(400);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 429 when concurrency cap is reached", async () => {
    // Hold MAX_CONCURRENT_BRIDGE_CALLS (3) inflight requests open
    let releaseAll: (() => void)[] = [];
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.kill = vi.fn();
      // Don't emit 'close' until told — keeps the slot occupied
      releaseAll.push(() => { proc.stdout.emit("data", Buffer.from("ok")); proc.emit("close", 0); });
      return proc;
    });

    const app = makeApp();
    const pendingReqs = Array.from({ length: 3 }, () =>
      request(app)
        .post("/bridge/v1/chat/completions")
        .send({ messages: [{ role: "user", content: "slow" }] })
        .then((r) => r, (e) => e),
    );

    // Wait until all 3 spawns have been registered
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(3));

    // The 4th request must be rejected
    const overflow = await request(app)
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "extra" }] });

    expect(overflow.status).toBe(429);

    // Release all held spawns so the test doesn't hang
    releaseAll.forEach((fn) => fn());
    await Promise.all(pendingReqs);
  });
});

describe("subscriptionBridgeRouter — abort kills subprocess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills the subprocess when the client disconnects", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn(() => { proc.emit("close", 143); });
    mockSpawn.mockReturnValue(proc);

    const app = makeApp();
    const req = request(app)
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hang" }] });
    const pending = req.then(() => undefined, () => undefined);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(proc.kill).not.toHaveBeenCalled();

    req.abort();
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith("SIGTERM"));
    await pending;
  });
});

describe("subscriptionBridgeRouter — ignored params", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces temperature and max_tokens in _bridge_ignored when present", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "result" }));
    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "x" }], temperature: 0, max_tokens: 512 });

    expect(res.status).toBe(200);
    expect(res.body._bridge_ignored).toEqual({ temperature: 0, max_tokens: 512 });
  });

  it("omits _bridge_ignored when no unsupported params are sent", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "result" }));
    const res = await request(makeApp())
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "x" }] });

    expect(res.status).toBe(200);
    expect(res.body._bridge_ignored).toBeUndefined();
  });
});

describe("subscriptionBridgeRouter — GET /models", () => {
  it("returns the model list", async () => {
    const res = await request(makeApp()).get("/bridge/v1/models");
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data[0].id).toBe("claude-subscription");
  });
});

describe("bridgeAuthMiddleware — no secret configured (local mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APEX_BRIDGE_SECRET", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("allows requests when APEX_BRIDGE_SECRET is not set", async () => {
    const app = express();
    app.use(express.json());
    app.use("/bridge/v1", bridgeAuthMiddleware(), subscriptionBridgeRouter());
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "ok" }));
    const res = await request(app)
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("allows requests with no Authorization header in local mode", async () => {
    const app = express();
    app.use(express.json());
    app.use("/bridge/v1", bridgeAuthMiddleware(), subscriptionBridgeRouter());
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "ok" }));
    const res = await request(app)
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });
});

describe("bridgeAuthMiddleware — secret configured (container mode)", () => {
  const SECRET = "test-bridge-secret-xyz";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APEX_BRIDGE_SECRET", SECRET);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("allows requests with correct bearer token", async () => {
    const app = express();
    app.use(express.json());
    app.use("/bridge/v1", bridgeAuthMiddleware(), subscriptionBridgeRouter());
    mockSpawn.mockImplementation(() => makeFakeProc({ stdout: "ok" }));
    const res = await request(app)
      .post("/bridge/v1/chat/completions")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const app = express();
    app.use(express.json());
    app.use("/bridge/v1", bridgeAuthMiddleware(), subscriptionBridgeRouter());
    const res = await request(app)
      .post("/bridge/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 401 with wrong token", async () => {
    const app = express();
    app.use(express.json());
    app.use("/bridge/v1", bridgeAuthMiddleware(), subscriptionBridgeRouter());
    const res = await request(app)
      .post("/bridge/v1/chat/completions")
      .set("Authorization", "Bearer wrong-token")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("also protects GET /models when secret is set", async () => {
    const app = express();
    app.use(express.json());
    app.use("/bridge/v1", bridgeAuthMiddleware(), subscriptionBridgeRouter());
    const res = await request(app).get("/bridge/v1/models");
    expect(res.status).toBe(401);
  });
});
