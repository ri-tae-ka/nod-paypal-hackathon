import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { User } from "./models/User.js";
import { SESSION_COOKIE, signSession } from "./services/authService.js";

const TEST_DB_URI = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017/procurement_desk_test";
const config = {
  CLIENT_ORIGIN: "http://localhost:5173",
  NODE_ENV: "test" as const,
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  BCRYPT_ROUNDS: 4,
};
const generousLimits = { windowMs: 60_000, login: 1000, register: 1000 };

let dbAvailable = false;
try {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
  dbAvailable = true;
} catch {
  console.warn(`Skipping auth tests: no MongoDB at ${TEST_DB_URI}`);
}

const alice = { email: "Alice@Example.com", password: "correct horse battery", displayName: "Alice" };

function sessionCookie(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
}

describe.skipIf(!dbAvailable)("auth API", () => {
  const app = createApp(config, { authRateLimits: generousLimits });

  beforeAll(async () => {
    await User.init();
  });
  beforeEach(async () => {
    await User.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it("registers a user, normalises the email, and sets an httpOnly session cookie", async () => {
    const res = await request(app).post("/api/auth/register").send(alice);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "alice@example.com", displayName: "Alice" });
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const stored = await User.findOne({ email: "alice@example.com" }).select("+passwordHash");
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored?.passwordHash).not.toContain(alice.password);
  });

  it("rejects a duplicate email regardless of case", async () => {
    await request(app).post("/api/auth/register").send(alice);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...alice, email: "ALICE@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("validates registration input", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "not-an-email", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["email", "password", "displayName"]));
  });

  it("rejects passwords longer than bcrypt's 72-byte limit", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...alice, password: "a".repeat(73) });
    expect(res.status).toBe(400);
  });

  it("logs in with the right password and returns the same generic error otherwise", async () => {
    await request(app).post("/api/auth/register").send(alice);

    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@example.com", password: alice.password });
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok)).toBeDefined();

    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: alice.email, password: "wrong password" });
    const unknownEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever123" });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({ code: "invalid_credentials", message: "Invalid email or password." });
      expect(sessionCookie(res)).toBeUndefined();
    }
  });

  it("returns the current user with a session and 401 without one", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(alice);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("alice@example.com");

    const anonymous = await request(app).get("/api/auth/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("unauthorized");
  });

  it("rejects tampered, foreign-signed and orphaned sessions", async () => {
    const reg = await request(app).post("/api/auth/register").send(alice);
    const userId = reg.body.user.id as string;

    const forged = signSession(userId, "a-different-secret-that-is-32-chars-long");
    const tampered = `${signSession(userId, config.JWT_SECRET)}x`;
    for (const token of [forged, tampered, "garbage"]) {
      const res = await request(app).get("/api/auth/me").set("Cookie", `${SESSION_COOKIE}=${token}`);
      expect(res.status).toBe(401);
    }

    await User.deleteOne({ _id: userId });
    const orphan = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${SESSION_COOKIE}=${signSession(userId, config.JWT_SECRET)}`);
    expect(orphan.status).toBe(401);
  });

  it("logs out by clearing the cookie", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(alice);

    const out = await agent.post("/api/auth/logout");
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("rate-limits repeated failed logins but not successful ones", async () => {
    const limited = createApp(config, { authRateLimits: { windowMs: 60_000, login: 2, register: 1000 } });
    await request(limited).post("/api/auth/register").send(alice);

    const good = { email: alice.email, password: alice.password };
    for (let i = 0; i < 3; i++) expect((await request(limited).post("/api/auth/login").send(good)).status).toBe(200);

    const bad = { email: alice.email, password: "wrong password" };
    expect((await request(limited).post("/api/auth/login").send(bad)).status).toBe(401);
    expect((await request(limited).post("/api/auth/login").send(bad)).status).toBe(401);
    const blocked = await request(limited).post("/api/auth/login").send(good);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});
