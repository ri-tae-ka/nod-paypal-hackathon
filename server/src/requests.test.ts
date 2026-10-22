import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { Payment } from "./models/Payment.js";
import { ProcurementRequest } from "./models/ProcurementRequest.js";
import { Version } from "./models/Version.js";
import { SESSION_COOKIE, signSession } from "./services/authService.js";
import type { ProductCandidate } from "./services/channel3/mapper.js";
import type { ProductSearchService } from "./services/productSearch.js";

// Separate database from auth.test.ts, which drops its own database when it finishes.
const TEST_DB_URI = process.env.TEST_REQUESTS_MONGODB_URI ?? "mongodb://127.0.0.1:27017/procurement_desk_test_requests";
const config = {
  CLIENT_ORIGIN: "http://localhost:5173",
  NODE_ENV: "test" as const,
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  BCRYPT_ROUNDS: 4,
};

let dbAvailable = false;
try {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
  dbAvailable = true;
} catch {
  console.warn(`Skipping requests tests: no MongoDB at ${TEST_DB_URI}`);
}

function makeProduct(id: string, unitPriceCents: number, extra: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    channel3ProductId: id,
    title: `Product ${id}`,
    brand: "Acme",
    imageUrl: null,
    category: "Office",
    materials: [],
    keyFeatures: ["Sturdy"],
    rating: { value: 4.5, count: 120 },
    retailerDomain: "shop.example",
    buyUrl: `https://shop.example/${id}`,
    availability: "InStock",
    currency: "USD",
    unitPriceCents,
    compareAtPriceCents: null,
    offerCount: 1,
    ...extra,
  };
}

const catalog = new Map<string, ProductCandidate>(
  [makeProduct("chair", 15000), makeProduct("desk", 40000), makeProduct("lamp", 2500), makeProduct("chair-pro", 32000)].map(
    (p) => [p.channel3ProductId, p],
  ),
);
const productSearch: ProductSearchService = {
  search: vi.fn(),
  resolveProduct: vi.fn(async (_userId: string, id: string) => catalog.get(id) ?? null),
};

const alice = new Types.ObjectId().toString();
const bob = new Types.ObjectId().toString();
const cookieFor = (userId: string) => `${SESSION_COOKIE}=${signSession(userId, config.JWT_SECRET)}`;

describe.skipIf(!dbAvailable)("requests API", () => {
  const app = createApp(config, { productSearch });
  const as = (userId: string) => {
    const cookie = cookieFor(userId);
    return {
      get: (url: string) => request(app).get(url).set("Cookie", cookie),
      post: (url: string, body: object) => request(app).post(url).set("Cookie", cookie).send(body),
      patch: (url: string, body: object) => request(app).patch(url).set("Cookie", cookie).send(body),
      delete: (url: string) => request(app).delete(url).set("Cookie", cookie),
    };
  };

  async function createRequestWithVersion(budgetCents?: number) {
    const created = await as(alice).post("/api/requests", { prompt: "Set up a home office", budgetCents });
    const id = created.body.request.id as string;
    const v1 = await as(alice).post(`/api/requests/${id}/versions`, {
      summary: "Basic setup",
      items: [
        { channel3ProductId: "chair", quantity: 2, rationale: "Ergonomic" },
        { channel3ProductId: "lamp", quantity: 1 },
      ],
    });
    return { id, v1: v1.body.version };
  }

  beforeAll(async () => {
    await Version.init();
  });
  beforeEach(async () => {
    await Promise.all([ProcurementRequest.deleteMany({}), Version.deleteMany({}), Payment.deleteMany({})]);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it("requires sign-in", async () => {
    expect((await request(app).get("/api/requests")).status).toBe(401);
  });

  it("creates, lists and fetches requests, newest first", async () => {
    const first = await as(alice).post("/api/requests", { prompt: "Desk for the new hire", budgetCents: 100000 });
    expect(first.status).toBe(201);
    expect(first.body.request).toMatchObject({ prompt: "Desk for the new hire", budgetCents: 100000, status: "draft", latestVersion: 0 });
    await as(alice).post("/api/requests", { prompt: "Kitchen supplies" });

    const list = await as(alice).get("/api/requests");
    expect(list.body.requests.map((r: { prompt: string }) => r.prompt)).toEqual(["Kitchen supplies", "Desk for the new hire"]);

    const one = await as(alice).get(`/api/requests/${first.body.request.id}`);
    expect(one.body).toMatchObject({ request: { id: first.body.request.id }, latestVersion: null });
  });

  it("validates the request body", async () => {
    const res = await as(alice).post("/api/requests", { prompt: "x", budgetCents: 10.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["prompt", "budgetCents"]));
  });

  it("hides other users' requests and invalid ids behind 404", async () => {
    const { id } = await createRequestWithVersion();
    expect((await as(bob).get(`/api/requests/${id}`)).status).toBe(404);
    expect((await as(bob).get(`/api/requests/${id}/versions/1`)).status).toBe(404);
    expect((await as(bob).post(`/api/requests/${id}/versions`, { items: [{ channel3ProductId: "lamp", quantity: 1 }] })).status).toBe(404);
    expect((await as(bob).get("/api/requests")).body.requests).toEqual([]);
    expect((await as(alice).get("/api/requests/not-an-id")).status).toBe(404);
  });

  it("creates versions with server-side prices, snapshots and totals", async () => {
    const { id, v1 } = await createRequestWithVersion(30000);
    expect(v1).toMatchObject({
      number: 1,
      basedOnVersion: null,
      revision: 0,
      totalCents: 32500,
      budget: { budgetCents: 30000, remainingCents: -2500, overBudget: true },
      approval: null,
    });
    expect(v1.items[0]).toMatchObject({
      channel3ProductId: "chair",
      title: "Product chair",
      unitPriceCents: 15000,
      quantity: 2,
      lineTotalCents: 30000,
      rating: { value: 4.5, count: 120 },
      rationale: "Ergonomic",
    });
    expect(typeof v1.items[0].id).toBe("string");

    const v2 = await as(alice).post(`/api/requests/${id}/versions`, {
      items: [{ channel3ProductId: "chair-pro", quantity: 2 }],
      instruction: "Upgrade quality",
    });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toMatchObject({ number: 2, basedOnVersion: 1, instruction: "Upgrade quality", totalCents: 64000 });

    const latest = await as(alice).get(`/api/requests/${id}`);
    expect(latest.body).toMatchObject({ request: { latestVersion: 2 }, latestVersion: { number: 2 } });
    expect((await as(alice).get(`/api/requests/${id}/versions/1`)).body.version.totalCents).toBe(32500);
    expect((await as(alice).get(`/api/requests/${id}/versions/3`)).status).toBe(404);
  });

  it("rejects unknown products, duplicates, bad quantities and bad base versions", async () => {
    const { id } = await createRequestWithVersion();
    const post = (body: object) => as(alice).post(`/api/requests/${id}/versions`, body);

    const unknown = await post({ items: [{ channel3ProductId: "ghost", quantity: 1 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: "unknown_product", details: { channel3ProductId: "ghost" } });

    const dupes = await post({ items: [{ channel3ProductId: "lamp", quantity: 1 }, { channel3ProductId: "lamp", quantity: 2 }] });
    expect(dupes.body.error.code).toBe("duplicate_product");

    expect((await post({ items: [{ channel3ProductId: "lamp", quantity: 0 }] })).status).toBe(400);
    expect((await post({ items: [{ channel3ProductId: "lamp", quantity: 1001 }] })).status).toBe(400);
    expect((await post({ items: [] })).status).toBe(400);
    expect((await post({ basedOnVersion: 5, items: [{ channel3ProductId: "lamp", quantity: 1 }] })).body.error.code).toBe(
      "invalid_base_version",
    );
    expect((await as(alice).get(`/api/requests/${id}`)).body.request.latestVersion).toBe(1);
  });

  it("edits quantities with optimistic concurrency and recomputes totals", async () => {
    const { id, v1 } = await createRequestWithVersion();
    const chairId = v1.items[0].id;
    const url = `/api/requests/${id}/versions/1/items/${chairId}`;

    const updated = await as(alice).patch(url, { quantity: 3, expectedRevision: 0 });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toMatchObject({ revision: 1, totalCents: 47500 });
    expect(updated.body.version.items[0]).toMatchObject({ quantity: 3, lineTotalCents: 45000 });

    const stale = await as(alice).patch(url, { quantity: 1, expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "stale_revision", details: { currentRevision: 1 } });

    expect((await as(alice).patch(`/api/requests/${id}/versions/1/items/${new Types.ObjectId()}`, { quantity: 1, expectedRevision: 1 })).status).toBe(404);
    expect((await as(alice).patch(url, { quantity: 0, expectedRevision: 1 })).status).toBe(400);
    expect((await as(bob).patch(url, { quantity: 1, expectedRevision: 1 })).status).toBe(404);
  });

  it("lets only one of two concurrent edits on the same revision win", async () => {
    const { id, v1 } = await createRequestWithVersion();
    const url = `/api/requests/${id}/versions/1/items/${v1.items[0].id}`;
    const results = await Promise.all([
      as(alice).patch(url, { quantity: 5, expectedRevision: 0 }),
      as(alice).patch(url, { quantity: 7, expectedRevision: 0 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await Version.findOne({ number: 1 }))?.revision).toBe(1);
  });

  it("adds and removes items, enforcing no duplicates", async () => {
    const { id, v1 } = await createRequestWithVersion();
    const itemsUrl = `/api/requests/${id}/versions/1/items`;

    const added = await as(alice).post(itemsUrl, { channel3ProductId: "desk", quantity: 1, expectedRevision: 0 });
    expect(added.status).toBe(201);
    expect(added.body.version).toMatchObject({ revision: 1, totalCents: 72500 });
    expect(added.body.version.items).toHaveLength(3);

    const dup = await as(alice).post(itemsUrl, { channel3ProductId: "desk", quantity: 1, expectedRevision: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("duplicate_product");

    const unknown = await as(alice).post(itemsUrl, { channel3ProductId: "ghost", quantity: 1, expectedRevision: 1 });
    expect(unknown.body.error.code).toBe("unknown_product");

    const removed = await as(alice).delete(`${itemsUrl}/${v1.items[1].id}?expectedRevision=1`);
    expect(removed.status).toBe(200);
    expect(removed.body.version).toMatchObject({ revision: 2, totalCents: 70000 });
    expect(removed.body.version.items.map((i: { channel3ProductId: string }) => i.channel3ProductId)).toEqual(["chair", "desk"]);

    expect((await as(alice).delete(`${itemsUrl}/${v1.items[0].id}`)).status).toBe(400);
  });

  it("caps a version at 50 items", async () => {
    const { id } = await createRequestWithVersion();
    const many = Array.from({ length: 50 }, (_, i) => makeProduct(`bulk-${i}`, 100));
    for (const p of many) catalog.set(p.channel3ProductId, p);
    catalog.set("one-more", makeProduct("one-more", 100));

    const v2 = await as(alice).post(`/api/requests/${id}/versions`, {
      items: many.map((p) => ({ channel3ProductId: p.channel3ProductId, quantity: 1 })),
    });
    expect(v2.status).toBe(201);
    const tooMany = await as(alice).post(`/api/requests/${id}/versions/2/items`, {
      channel3ProductId: "one-more",
      quantity: 1,
      expectedRevision: 0,
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("too_many_items");
  });

  it("locks older versions and non-draft requests", async () => {
    const { id, v1 } = await createRequestWithVersion();
    await as(alice).post(`/api/requests/${id}/versions`, { items: [{ channel3ProductId: "desk", quantity: 1 }] });

    const old = await as(alice).patch(`/api/requests/${id}/versions/1/items/${v1.items[0].id}`, { quantity: 9, expectedRevision: 0 });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe("version_locked");

    await ProcurementRequest.updateOne({ _id: id }, { status: "paid" });
    const locked = await as(alice).post(`/api/requests/${id}/versions`, { items: [{ channel3ProductId: "lamp", quantity: 1 }] });
    expect(locked.body.error.code).toBe("request_locked");
  });

  it("clears an existing approval when the version is edited", async () => {
    const { id, v1 } = await createRequestWithVersion();
    await Version.updateOne(
      { number: 1 },
      { approval: { approvedAt: new Date(), approvedRevision: 0, approvedTotalCents: 32500 } },
    );
    expect((await as(alice).get(`/api/requests/${id}/versions/1`)).body.version.approval).toMatchObject({ approvedRevision: 0 });

    const edited = await as(alice).patch(`/api/requests/${id}/versions/1/items/${v1.items[1].id}`, { quantity: 2, expectedRevision: 0 });
    expect(edited.body.version.approval).toBeNull();
  });

  it("lists versions oldest first with summaries", async () => {
    const { id } = await createRequestWithVersion(50000);
    await as(alice).post(`/api/requests/${id}/versions`, {
      summary: "Cheaper",
      instruction: "cut cost",
      items: [{ channel3ProductId: "lamp", quantity: 3 }],
    });
    await Version.updateOne({ number: 2 }, { approval: { approvedAt: new Date(), approvedRevision: 0, approvedTotalCents: 7500 } });

    const res = await as(alice).get(`/api/requests/${id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([
      expect.objectContaining({ number: 1, basedOnVersion: null, summary: "Basic setup", itemCount: 2, totalCents: 32500, approved: false }),
      expect.objectContaining({ number: 2, basedOnVersion: 1, summary: "Cheaper", instruction: "cut cost", itemCount: 1, totalCents: 7500, approved: true }),
    ]);
    expect((await as(bob).get(`/api/requests/${id}/versions`)).status).toBe(404);
  });

  it("copies a version into a new latest version without re-fetching products", async () => {
    const { id, v1 } = await createRequestWithVersion();
    catalog.set("chair", makeProduct("chair", 99999));

    const copy = await as(alice).post(`/api/requests/${id}/versions/1/copy`, { summary: "Before AI tweaks", expectedLatestVersion: 1 });
    expect(copy.status).toBe(201);
    expect(copy.body.version).toMatchObject({ number: 2, basedOnVersion: 1, summary: "Before AI tweaks", revision: 0, totalCents: 32500 });
    expect(copy.body.version.items.map((i: { channel3ProductId: string }) => i.channel3ProductId)).toEqual(["chair", "lamp"]);
    expect(copy.body.version.items[0].id).not.toBe(v1.items[0].id);
    expect(copy.body.version.items[0].rationale).toBe("Ergonomic");

    const fallback = await as(alice).post(`/api/requests/${id}/versions/1/copy`, { expectedLatestVersion: 2 });
    expect(fallback.body.version).toMatchObject({ number: 3, summary: "Copy of v1" });

    const stale = await as(alice).post(`/api/requests/${id}/versions/3/copy`, { expectedLatestVersion: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await as(alice).post(`/api/requests/${id}/versions/9/copy`, { expectedLatestVersion: 3 })).status).toBe(404);
    expect((await as(alice).post(`/api/requests/${id}/versions/1/copy`, {})).status).toBe(400);

    await ProcurementRequest.updateOne({ _id: id }, { status: "approved" });
    const locked = await as(alice).post(`/api/requests/${id}/versions/1/copy`, { expectedLatestVersion: 3 });
    expect(locked.body.error.code).toBe("request_locked");
    catalog.set("chair", makeProduct("chair", 15000));
  });

  it("deletes draft and approved requests with their versions and unpaid payments", async () => {
    const { id, v1 } = await createRequestWithVersion();
    await as(alice).post(`/api/requests/${id}/versions/1/copy`, { expectedLatestVersion: 1 });

    expect((await as(bob).delete(`/api/requests/${id}`)).status).toBe(404);
    const res = await as(alice).delete(`/api/requests/${id}`);
    expect(res.status).toBe(204);
    expect(await ProcurementRequest.countDocuments({ _id: id })).toBe(0);
    expect(await Version.countDocuments({ requestId: id })).toBe(0);
    expect((await as(alice).get(`/api/requests/${id}`)).status).toBe(404);
    expect((await as(alice).delete(`/api/requests/${id}`)).status).toBe(404);

    const approved = await createRequestWithVersion();
    await ProcurementRequest.updateOne({ _id: approved.id }, { status: "approved", approvedVersion: 1 });
    const payment = {
      userId: alice,
      requestId: approved.id,
      versionId: v1.id,
      versionNumber: 1,
      approvedRevision: 0,
      amountCents: 32500,
    };
    await Payment.create({ ...payment, paypalOrderId: "ORDER-OPEN" });
    expect((await as(alice).delete(`/api/requests/${approved.id}`)).status).toBe(204);
    expect(await Payment.countDocuments({ requestId: approved.id })).toBe(0);
  });

  it("refuses to delete paid requests or ones with a capture in flight", async () => {
    const paid = await createRequestWithVersion();
    await ProcurementRequest.updateOne({ _id: paid.id }, { status: "paid", approvedVersion: 1 });
    const blocked = await as(alice).delete(`/api/requests/${paid.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("request_paid");

    const capturing = await createRequestWithVersion();
    await ProcurementRequest.updateOne({ _id: capturing.id }, { status: "approved", approvedVersion: 1 });
    await Payment.create({
      userId: alice,
      requestId: capturing.id,
      versionId: capturing.v1.id,
      versionNumber: 1,
      approvedRevision: 0,
      amountCents: 32500,
      paypalOrderId: "ORDER-CAPTURING",
      status: "capturing",
    });
    const inFlight = await as(alice).delete(`/api/requests/${capturing.id}`);
    expect(inFlight.status).toBe(409);
    expect(inFlight.body.error.code).toBe("payment_in_progress");
    expect(await ProcurementRequest.countDocuments({ _id: capturing.id })).toBe(1);
    expect(await Version.countDocuments({ requestId: capturing.id })).toBe(1);
  });

  it("diffs two versions by product", async () => {
    const { id } = await createRequestWithVersion();
    catalog.set("lamp", makeProduct("lamp", 2700));
    await as(alice).post(`/api/requests/${id}/versions`, {
      items: [
        { channel3ProductId: "chair-pro", quantity: 2 },
        { channel3ProductId: "lamp", quantity: 1 },
        { channel3ProductId: "desk", quantity: 1 },
      ],
    });
    catalog.set("lamp", makeProduct("lamp", 2500));

    const res = await as(alice).get(`/api/requests/${id}/versions/2/diff?against=1`);
    expect(res.status).toBe(200);
    const { diff } = res.body;
    expect(diff).toMatchObject({
      from: { number: 1, totalCents: 32500 },
      to: { number: 2, totalCents: 106700 },
      totalDeltaCents: 74200,
      unchangedCount: 0,
    });
    expect(diff.added.map((i: { channel3ProductId: string }) => i.channel3ProductId)).toEqual(["chair-pro", "desk"]);
    expect(diff.removed).toEqual([expect.objectContaining({ channel3ProductId: "chair", quantity: 2, lineTotalCents: 30000 })]);
    expect(diff.changed).toEqual([
      expect.objectContaining({ channel3ProductId: "lamp", unitPriceCents: 2700, before: expect.objectContaining({ unitPriceCents: 2500 }) }),
    ]);

    expect((await as(alice).get(`/api/requests/${id}/versions/2/diff`)).status).toBe(400);
    expect((await as(alice).get(`/api/requests/${id}/versions/2/diff?against=9`)).status).toBe(404);
  });
});
