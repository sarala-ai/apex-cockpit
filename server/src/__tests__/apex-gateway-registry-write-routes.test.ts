import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apexGatewayObserveRoutes } from "../routes/apex-gateway-observe.js";
import { errorHandler } from "../middleware/index.js";
import type { GatewayClient, GatewayWriteResult } from "../gateway/gateway-client.js";

function makeClient(registerGateway: (input: unknown) => Promise<GatewayWriteResult>) {
  return { registerGateway } as unknown as GatewayClient;
}

function appWith(client: GatewayClient) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "agent", agentId: "a1" };
    next();
  });
  app.use(apexGatewayObserveRoutes(client));
  app.use(errorHandler);
  return app;
}

const VALID_BODY = {
  name: "penpot",
  url: "https://penpot.example.com/mcp",
  transport: "STREAMABLEHTTP",
};

describe("POST /gateway/registry", () => {
  it("registers a gateway and returns its id/name on success", async () => {
    const client = makeClient(async () => ({ ok: true, id: "gw-1", name: "penpot" }));
    const res = await request(appWith(client)).post("/gateway/registry").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "gw-1", name: "penpot" });
  });

  it("400s when required fields are missing", async () => {
    const client = makeClient(async () => ({ ok: true, id: "gw-1", name: "penpot" }));
    const res = await request(appWith(client)).post("/gateway/registry").send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("400s STDIO transport without calling the client (not meaningful from a browser form)", async () => {
    let called = false;
    const client = makeClient(async () => {
      called = true;
      return { ok: true, id: "gw-1", name: "penpot" };
    });
    const res = await request(appWith(client))
      .post("/gateway/registry")
      .send({ name: "local", url: "http://localhost:9000", transport: "STDIO" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("STDIO");
    expect(called).toBe(false);
  });

  it("maps a 409 conflict to 'name already registered' territory", async () => {
    const client = makeClient(async () => ({
      ok: false,
      status: "conflict",
      message: "Gateway name already exists",
    }));
    const res = await request(appWith(client)).post("/gateway/registry").send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Gateway name already exists");
  });

  it("maps a 422 validation failure to a 422 with an SSRF-guard teaching hint", async () => {
    const client = makeClient(async () => ({
      ok: false,
      status: "validation",
      message: "url resolves to a private network address",
    }));
    const res = await request(appWith(client)).post("/gateway/registry").send(VALID_BODY);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("private network address");
    expect(res.body.error).toContain("SSRF_ALLOW_PRIVATE_NETWORKS");
  });

  it("maps a 502 upstream-unreachable failure to 502 mentioning the URL", async () => {
    const client = makeClient(async () => ({
      ok: false,
      status: "upstream_unreachable",
      message: "Connection refused",
    }));
    const res = await request(appWith(client)).post("/gateway/registry").send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("can't reach that URL");
  });

  it("maps apex-gateway itself being unreachable to 502", async () => {
    const client = makeClient(async () => ({
      ok: false,
      status: "unreachable",
      message: "n/a",
    }));
    const res = await request(appWith(client)).post("/gateway/registry").send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("apex-gateway itself is unreachable");
  });

  it("falls back to a generic 400 for an unclassified error", async () => {
    const client = makeClient(async () => ({
      ok: false,
      status: "error",
      message: "Unexpected error",
    }));
    const res = await request(appWith(client)).post("/gateway/registry").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unexpected error");
  });
});
