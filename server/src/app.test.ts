import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const app = createApp({
  CLIENT_ORIGIN: "http://localhost:5173",
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  BCRYPT_ROUNDS: 4,
});

describe("server foundation", () => {
  it("reports degraded health when the database is not connected", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", database: "disconnected" });
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns a 400 for malformed JSON without leaking details", async () => {
    const res = await request(app).post("/api/health").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("sets security headers and hides the framework", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("environment validation", () => {
  const valid = { MONGODB_URI: "mongodb+srv://u:p@cluster.example.mongodb.net/procurement_desk", JWT_SECRET: "x".repeat(32) };

  it("applies defaults", () => {
    expect(loadEnv(valid)).toMatchObject({ PORT: 4000, NODE_ENV: "development" });
  });

  it("requires a MongoDB connection string", () => {
    expect(() => loadEnv({})).toThrow("MONGODB_URI");
    expect(() => loadEnv({ MONGODB_URI: "http://nope" })).toThrow("MONGODB_URI");
  });

  it("rejects invalid values", () => {
    expect(() => loadEnv({ ...valid, PORT: "abc" })).toThrow("Invalid environment configuration");
    expect(() => loadEnv({ ...valid, CLIENT_ORIGIN: "not-a-url" })).toThrow("CLIENT_ORIGIN");
  });

  it("requires a strong JWT secret and defaults bcrypt rounds", () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: undefined })).toThrow("JWT_SECRET");
    expect(() => loadEnv({ ...valid, JWT_SECRET: "short" })).toThrow("JWT_SECRET");
    expect(loadEnv(valid).BCRYPT_ROUNDS).toBe(12);
  });
});

describe("serving the built client", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "client-dist-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
  const staticApp = createApp(
    { CLIENT_ORIGIN: "http://localhost:4000", NODE_ENV: "test", JWT_SECRET: "test-secret-that-is-at-least-32-characters", BCRYPT_ROUNDS: 4 },
    { staticDir: dir },
  );

  it("serves index.html for client-side routes", async () => {
    const res = await request(staticApp).get("/requests/123");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id=root>');
  });

  it("serves fingerprinted assets with a long cache", async () => {
    const res = await request(staticApp).get("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("keeps JSON 404s for unknown API routes", async () => {
    const res = await request(staticApp).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("allows product images from https hosts", async () => {
    const res = await request(staticApp).get("/");
    expect(res.headers["content-security-policy"]).toMatch(/img-src 'self' data: https:/);
  });
});

describe("Render defaults", () => {
  it("uses RENDER_EXTERNAL_URL as the client origin when CLIENT_ORIGIN is unset", () => {
    const env = loadEnv({
      MONGODB_URI: "mongodb://localhost/test",
      JWT_SECRET: "test-secret-that-is-at-least-32-characters",
      RENDER_EXTERNAL_URL: "https://nod-app.onrender.com",
    });
    expect(env.CLIENT_ORIGIN).toBe("https://nod-app.onrender.com");
  });
});
