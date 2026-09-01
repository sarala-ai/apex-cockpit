import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { authRoutes } from "./auth.js";

// /api/auth/config is public and pre-auth; db is not touched by it.
function appWith(googleAuthEnabled: boolean) {
  const app = express();
  app.use("/api/auth", authRoutes({} as never, { googleAuthEnabled }));
  return app;
}

describe("GET /api/auth/config (public discovery)", () => {
  it("lists only password when Google is disabled", async () => {
    const res = await request(appWith(false)).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: ["password"] });
  });

  it("includes google when enabled", async () => {
    const res = await request(appWith(true)).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.providers).toContain("password");
    expect(res.body.providers).toContain("google");
  });

  it("exposes ONLY provider types — no deployment mode, bootstrap, or org posture", async () => {
    const res = await request(appWith(true)).get("/api/auth/config");
    expect(Object.keys(res.body)).toEqual(["providers"]);
  });
});
