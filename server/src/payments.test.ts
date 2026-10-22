import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { Payment } from "./models/Payment.js";
import { ProcurementRequest } from "./models/ProcurementRequest.js";
import { Version } from "./models/Version.js";
import { SESSION_COOKIE, signSession } from "./services/authService.js";
import type { ProductCandidate } from "./services/channel3/mapper.js";
import {
  type CreateOrderBody,
  PAYPAL_BASE_URL,
  type PayPalClient,
  type PayPalOrder,
  PayPalApiError,
  centsToValue,
  createPayPalClient,
  valueToCents,
} from "./services/paypal/client.js";
import type { ProductSearchService } from "./services/productSearch.js";

describe("money helpers", () => {
  it("round-trips cents and PayPal decimal strings", () => {
    expect(centsToValue(0)).toBe("0.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(centsToValue(123456)).toBe("1234.56");
    expect(valueToCents("1234.56")).toBe(123456);
    expect(valueToCents("10.5")).toBe(1050);
    expect(valueToCents("7")).toBe(700);
    expect(valueToCents("1.234")).toBeNull();
    expect(valueToCents("abc")).toBeNull();
  });
});

describe("PayPal client", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("caches the OAuth token and sends idempotency keys", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/v1/oauth2/token")
        ? json(200, { access_token: "tok", expires_in: 32400 })
        : json(201, { id: "ORDER1", status: "PAYER_ACTION_REQUIRED" }),
    );
    const client = createPayPalClient("id", "secret", fetchImpl);
    await client.createOrder({} as CreateOrderBody, "key-1");
    await client.captureOrder("ORDER1", "key-2");

    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.endsWith("/v1/oauth2/token"))).toHaveLength(1);
    expect(urls).toContain(`${PAYPAL_BASE_URL}/v2/checkout/orders/ORDER1/capture`);

    const tokenInit = fetchImpl.mock.calls[0]![1]!;
    expect(tokenInit.headers).toMatchObject({ authorization: `Basic ${Buffer.from("id:secret").toString("base64")}` });
    expect(fetchImpl.mock.calls[1]![1]!.headers).toMatchObject({ authorization: "Bearer tok", "paypal-request-id": "key-1" });
    expect(fetchImpl.mock.calls[2]![1]!.headers).toMatchObject({ "paypal-request-id": "key-2" });
  });

  it("refreshes the token once on 401 and parses API errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let orderCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/oauth2/token")) return json(200, { access_token: "tok", expires_in: 32400 });
      orderCalls++;
      return orderCalls === 1
        ? json(401, { name: "AUTHENTICATION_FAILURE" })
        : json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }], debug_id: "dbg" });
    });
    const error = await createPayPalClient("id", "secret", fetchImpl).captureOrder("O", "k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 422, issues: ["ORDER_NOT_APPROVED"], debugId: "dbg" });
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("maps bad credentials to a misconfiguration error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => json(401, { error: "invalid_client" }));
    await expect(createPayPalClient("id", "bad", fetchImpl).getOrder("O")).rejects.toMatchObject({
      status: 502,
      code: "paypal_unavailable",
    });
  });
});

// ---------- Approval and payments through the API, with a scripted PayPal ----------

const TEST_DB_URI = process.env.TEST_PAYMENTS_MONGODB_URI ?? "mongodb://127.0.0.1:27017/procurement_desk_test_payments";
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
  console.warn(`Skipping payments tests: no MongoDB at ${TEST_DB_URI}`);
}

function makeProduct(id: string, unitPriceCents: number, extra: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    channel3ProductId: id,
    title: `Product ${id}`,
    brand: "Acme",
    imageUrl: null,
    category: "Office",
    materials: [],
    keyFeatures: [],
    rating: null,
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
const catalog = new Map(
  [makeProduct("chair", 15000), makeProduct("lamp", 2599), makeProduct("gone", 1000, { availability: "OutOfStock" })].map((p) => [
    p.channel3ProductId,
    p,
  ]),
);
const productSearch: ProductSearchService = {
  search: vi.fn(),
  resolveProduct: vi.fn(async (_userId: string, id: string) => catalog.get(id) ?? null),
};

/** In-memory PayPal: orders must be "approved" by the test before they can be captured. */
function fakePayPal() {
  const orders = new Map<string, { body: CreateOrderBody; approved: boolean; captured: boolean }>();
  const byKey = new Map<string, string>();
  let captureAmountOverride: string | null = null;
  let captureStatus: "COMPLETED" | "PENDING" | "DECLINED" = "COMPLETED";

  const captured = (id: string): PayPalOrder => {
    const unit = orders.get(id)!.body.purchase_units[0]!;
    return {
      id,
      status: "COMPLETED",
      payer: { email_address: "buyer@example.com", payer_id: "PAYER1" },
      purchase_units: [
        {
          payments: {
            captures: [{ id: `CAP-${id}`, status: captureStatus, amount: { currency_code: "USD", value: captureAmountOverride ?? unit.amount.value } }],
          },
        },
      ],
    };
  };

  const client: PayPalClient = {
    createOrder: vi.fn(async (body: CreateOrderBody, key: string): Promise<PayPalOrder> => {
      const existing = byKey.get(key);
      const id = existing ?? `ORDER${orders.size + 1}`;
      if (!existing) {
        orders.set(id, { body, approved: false, captured: false });
        byKey.set(key, id);
      }
      return { id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://sandbox.paypal.com/checkoutnow?token=${id}` }] };
    }),
    captureOrder: vi.fn(async (id: string) => {
      const order = orders.get(id);
      if (!order) throw new PayPalApiError(404, "RESOURCE_NOT_FOUND", ["INVALID_RESOURCE_ID"], "dbg");
      if (order.captured) throw new PayPalApiError(422, "UNPROCESSABLE_ENTITY", ["ORDER_ALREADY_CAPTURED"], "dbg");
      if (!order.approved) throw new PayPalApiError(422, "UNPROCESSABLE_ENTITY", ["ORDER_NOT_APPROVED"], "dbg");
      order.captured = true;
      return captured(id);
    }),
    getOrder: vi.fn(async (id: string) => captured(id)),
  };
  return {
    client,
    orders,
    approve: (id: string) => {
      orders.get(id)!.approved = true;
    },
    setCaptureAmount: (value: string | null) => {
      captureAmountOverride = value;
    },
    setCaptureStatus: (status: typeof captureStatus) => {
      captureStatus = status;
    },
  };
}

const alice = new Types.ObjectId().toString();
const bob = new Types.ObjectId().toString();
const cookieFor = (userId: string) => `${SESSION_COOKIE}=${signSession(userId, config.JWT_SECRET)}`;

describe.skipIf(!dbAvailable)("approval and payments API", () => {
  let paypal = fakePayPal();
  let app = createApp(config, { productSearch, llm: null, paypal: paypal.client });
  const as = (userId: string) => {
    const cookie = cookieFor(userId);
    return {
      get: (url: string) => request(app).get(url).set("Cookie", cookie),
      post: (url: string, body: object = {}) => request(app).post(url).set("Cookie", cookie).send(body),
      patch: (url: string, body: object) => request(app).patch(url).set("Cookie", cookie).send(body),
    };
  };

  async function draft(items: { channel3ProductId: string; quantity: number }[] = [
    { channel3ProductId: "chair", quantity: 2 },
    { channel3ProductId: "lamp", quantity: 1 },
  ], budgetCents?: number) {
    const created = await as(alice).post("/api/requests", { prompt: "Home office setup", budgetCents });
    const id = created.body.request.id as string;
    const v1 = await as(alice).post(`/api/requests/${id}/versions`, { items });
    expect(v1.status).toBe(201);
    return { id, v1: v1.body.version };
  }

  async function approvedRequest() {
    const { id, v1 } = await draft();
    const res = await as(alice).post(`/api/requests/${id}/versions/1/approve`, { expectedRevision: v1.revision });
    expect(res.status).toBe(200);
    return { id, v1 };
  }

  beforeAll(async () => {
    await Promise.all([Version.init(), Payment.init()]);
  });
  beforeEach(async () => {
    await Promise.all([ProcurementRequest.deleteMany({}), Version.deleteMany({}), Payment.deleteMany({})]);
    paypal = fakePayPal();
    app = createApp(config, { productSearch, llm: null, paypal: paypal.client });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe("approval", () => {
    it("approves an exact revision and locks the request", async () => {
      const { id, v1 } = await draft();
      const res = await as(alice).post(`/api/requests/${id}/versions/1/approve`, { expectedRevision: v1.revision });
      expect(res.body.request).toMatchObject({ status: "approved", approvedVersion: 1 });
      expect(res.body.version.approval).toMatchObject({ approvedRevision: 0, approvedTotalCents: 32599 });

      const item = v1.items[0].id;
      const edit = await as(alice).patch(`/api/requests/${id}/versions/1/items/${item}`, { quantity: 5, expectedRevision: 0 });
      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe("request_locked");

      const again = await as(alice).post(`/api/requests/${id}/versions/1/approve`, { expectedRevision: 0 });
      expect(again.body.error).toMatchObject({ code: "already_approved", details: { approvedVersion: 1 } });
    });

    it("rejects stale, over-budget, out-of-stock and foreign approvals", async () => {
      const { id, v1 } = await draft();
      await as(alice).patch(`/api/requests/${id}/versions/1/items/${v1.items[0].id}`, { quantity: 3, expectedRevision: 0 });
      const stale = await as(alice).post(`/api/requests/${id}/versions/1/approve`, { expectedRevision: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({ code: "stale_revision", details: { currentRevision: 1 } });

      const over = await draft(undefined, 10000);
      const overRes = await as(alice).post(`/api/requests/${over.id}/versions/1/approve`, { expectedRevision: 0 });
      expect(overRes.status).toBe(422);
      expect(overRes.body.error.code).toBe("over_budget");

      const oos = await draft([{ channel3ProductId: "gone", quantity: 1 }]);
      const oosRes = await as(alice).post(`/api/requests/${oos.id}/versions/1/approve`, { expectedRevision: 0 });
      expect(oosRes.body.error.code).toBe("out_of_stock");

      const foreign = await as(bob).post(`/api/requests/${id}/versions/1/approve`, { expectedRevision: 1 });
      expect(foreign.status).toBe(404);
    });

    it("unapprove returns the request to draft and clears the approval", async () => {
      const { id, v1 } = await approvedRequest();
      const res = await as(alice).post(`/api/requests/${id}/unapprove`);
      expect(res.body.request).toMatchObject({ status: "draft", approvedVersion: null });
      const version = await as(alice).get(`/api/requests/${id}/versions/1`);
      expect(version.body.version.approval).toBeNull();

      const edit = await as(alice).patch(`/api/requests/${id}/versions/1/items/${v1.items[0].id}`, { quantity: 1, expectedRevision: 0 });
      expect(edit.status).toBe(200);
      const none = await as(alice).post(`/api/requests/${id}/unapprove`);
      expect(none.body.error.code).toBe("not_approved");
    });
  });

  describe("checkout", () => {
    it("requires an approval", async () => {
      const { id } = await draft();
      const res = await as(alice).post(`/api/requests/${id}/checkout`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("not_approved");
    });

    it("creates an itemised order for the approved total and reuses it on retry", async () => {
      const { id } = await approvedRequest();
      const first = await as(alice).post(`/api/requests/${id}/checkout`);
      expect(first.status).toBe(201);
      expect(first.body.payment).toMatchObject({
        paypalOrderId: "ORDER1",
        status: "created",
        amountCents: 32599,
        versionNumber: 1,
        sandbox: true,
        approveUrl: "https://sandbox.paypal.com/checkoutnow?token=ORDER1",
      });

      const body = paypal.orders.get("ORDER1")!.body;
      const unit = body.purchase_units[0]!;
      expect(unit.amount).toEqual({ currency_code: "USD", value: "325.99", breakdown: { item_total: { currency_code: "USD", value: "325.99" } } });
      expect(unit.items).toEqual([
        expect.objectContaining({ sku: "chair", quantity: "2", unit_amount: { currency_code: "USD", value: "150.00" } }),
        expect.objectContaining({ sku: "lamp", quantity: "1", unit_amount: { currency_code: "USD", value: "25.99" } }),
      ]);
      expect(body.payment_source.paypal.experience_context.return_url).toBe(`http://localhost:5173/requests/${id}/checkout/return`);

      const second = await as(alice).post(`/api/requests/${id}/checkout`);
      expect(second.body.payment.paypalOrderId).toBe("ORDER1");
      expect(paypal.client.createOrder).toHaveBeenCalledTimes(1);
    });

    it("returns 503 when PayPal is not configured", async () => {
      const { id } = await approvedRequest();
      app = createApp(config, { productSearch, llm: null, paypal: null });
      const res = await as(alice).post(`/api/requests/${id}/checkout`);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("payments_not_configured");
    });
  });

  describe("capture", () => {
    async function checkedOut() {
      const { id } = await approvedRequest();
      const res = await as(alice).post(`/api/requests/${id}/checkout`);
      return { id, orderId: res.body.payment.paypalOrderId as string };
    }

    it("refuses until the buyer approves, then completes and marks the request paid", async () => {
      const { id, orderId } = await checkedOut();
      const early = await as(alice).post(`/api/payments/${orderId}/capture`);
      expect(early.status).toBe(409);
      expect(early.body.error).toMatchObject({ code: "order_not_approved", details: { approveUrl: expect.stringContaining(orderId) } });

      paypal.approve(orderId);
      const res = await as(alice).post(`/api/payments/${orderId}/capture`);
      expect(res.status).toBe(200);
      expect(res.body.payment).toMatchObject({
        status: "completed",
        paypalCaptureId: `CAP-${orderId}`,
        payer: { email: "buyer@example.com", payerId: "PAYER1" },
        approveUrl: null,
      });

      const after = await as(alice).get(`/api/requests/${id}`);
      expect(after.body.request.status).toBe("paid");
      expect((await as(alice).post(`/api/requests/${id}/unapprove`)).body.error.code).toBe("request_locked");
      expect((await as(alice).post(`/api/requests/${id}/checkout`)).body.error.code).toBe("already_paid");

      const retry = await as(alice).post(`/api/payments/${orderId}/capture`);
      expect(retry.body.payment.status).toBe("completed");
      expect(paypal.client.captureOrder).toHaveBeenCalledTimes(2);

      const list = await as(alice).get(`/api/requests/${id}/payments`);
      expect(list.body.payments).toHaveLength(1);
    });

    it("cancels the open order when the approval is withdrawn", async () => {
      const { id, orderId } = await checkedOut();
      await as(alice).post(`/api/requests/${id}/unapprove`);
      paypal.approve(orderId);
      const res = await as(alice).post(`/api/payments/${orderId}/capture`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("order_cancelled");
      expect(paypal.client.captureOrder).not.toHaveBeenCalled();
    });

    it("flags a captured amount that differs from the approval", async () => {
      const { orderId } = await checkedOut();
      paypal.approve(orderId);
      paypal.setCaptureAmount("1.00");
      const res = await as(alice).post(`/api/payments/${orderId}/capture`);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("amount_mismatch");
      expect((await Payment.findOne({ paypalOrderId: orderId }))?.status).toBe("failed");
    });

    it("keeps pending captures out of paid and hides other users' orders", async () => {
      const { id, orderId } = await checkedOut();
      expect((await as(bob).post(`/api/payments/${orderId}/capture`)).status).toBe(404);
      expect((await as(bob).get(`/api/requests/${id}/payments`)).status).toBe(404);

      paypal.approve(orderId);
      paypal.setCaptureStatus("PENDING");
      const res = await as(alice).post(`/api/payments/${orderId}/capture`);
      expect(res.body.payment.status).toBe("pending");
      expect((await as(alice).get(`/api/requests/${id}`)).body.request.status).toBe("approved");
      expect((await as(alice).post(`/api/requests/${id}/unapprove`)).body.error.code).toBe("payment_in_progress");
    });
  });
});
