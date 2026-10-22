import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { CHANNEL3_BASE_URL, createChannel3Client } from "./services/channel3/client.js";
import { type ProductCandidate, toProductCandidate } from "./services/channel3/mapper.js";
import { SESSION_COOKIE, signSession } from "./services/authService.js";
import { createProductSearchService } from "./services/productSearch.js";

const rawChair = {
  id: "abc123",
  title: "ErgoPro Office Chair",
  brands: [{ id: "b1", name: "ErgoPro" }],
  images: [
    { url: "https://img.example/side.jpg", is_main_image: false },
    { url: "https://img.example/main.jpg", is_main_image: true },
  ],
  category: { slug: "office-chairs", title: "Office Chairs", has_children: false },
  materials: ["mesh", "aluminium"],
  key_features: ["Lumbar support", "4D armrests"],
  ratings: { value: 4.4, count: 812, source_count: 3 },
  offers: [
    { url: "https://buy.example/a", domain: "pricey.com", price: { price: 349.99, currency: "USD" }, availability: "InStock" },
    { url: "https://buy.example/b", domain: "cheap-but-out.com", price: { price: 199.0, currency: "USD" }, availability: "OutOfStock" },
    { url: "https://buy.example/c", domain: "deals.com", price: { price: 299.5, compare_at_price: 399, currency: "USD" }, availability: "InStock" },
    { url: "https://buy.example/d", domain: "uk-shop.co.uk", price: { price: 150, currency: "GBP" }, availability: "InStock" },
  ],
};

describe("toProductCandidate", () => {
  it("picks the cheapest in-stock USD offer and converts to cents", () => {
    const p = toProductCandidate(rawChair);
    expect(p).toMatchObject({
      channel3ProductId: "abc123",
      brand: "ErgoPro",
      imageUrl: "https://img.example/main.jpg",
      category: "Office Chairs",
      retailerDomain: "deals.com",
      buyUrl: "https://buy.example/c",
      availability: "InStock",
      unitPriceCents: 29950,
      compareAtPriceCents: 39900,
      rating: { value: 4.4, count: 812 },
      offerCount: 3,
    });
  });

  it("falls back to an out-of-stock offer when nothing is in stock", () => {
    const p = toProductCandidate({
      ...rawChair,
      offers: [{ url: "u", domain: "x.com", price: { price: 10, currency: "USD" }, availability: "OutOfStock" }],
    });
    expect(p?.availability).toBe("OutOfStock");
  });

  it("drops products without a usable USD price, and malformed products", () => {
    expect(toProductCandidate({ ...rawChair, offers: [rawChair.offers[3]] })).toBeNull();
    expect(
      toProductCandidate({ ...rawChair, offers: [{ url: "u", domain: "x.com", price: { price: 0, currency: "USD" }, availability: "InStock" }] }),
    ).toBeNull();
    expect(toProductCandidate({ title: "no id" })).toBeNull();
  });

  it("treats a zero-review rating as no rating and tolerates missing optional fields", () => {
    const p = toProductCandidate({
      id: "x",
      title: "Plain pen",
      ratings: { value: 0, count: 0, source_count: 0 },
      offers: [{ url: "u", domain: "pens.com", price: { price: 1.2, currency: "usd" }, availability: "InStock" }],
    });
    expect(p).toMatchObject({ rating: null, brand: null, imageUrl: null, materials: [], keyFeatures: [], unitPriceCents: 120 });
  });
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

describe("Channel3 client", () => {
  const params = { query: "office chair", limit: 5, maxPriceCents: 30000, userId: "user-1" };

  it("sends the key, user id, filters and USD config, and maps results", async () => {
    const fetchImpl = fakeFetch(200, { products: [rawChair, { bad: true }], next_page_token: null });
    const products = await createChannel3Client("secret-key", fetchImpl).search(params);

    expect(products).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${CHANNEL3_BASE_URL}/v1/search`);
    expect(init?.headers).toMatchObject({ "x-api-key": "secret-key", "x-user-id": "user-1" });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "office chair",
      limit: 5,
      filters: { availability: ["InStock"], conditions: ["new"], price: { max_price: 300 } },
      config: { country: "US", currency: "USD" },
    });
  });

  it.each([
    [401, 502, "search_unavailable"],
    [403, 502, "search_unavailable"],
    [402, 503, "search_quota_exhausted"],
    [422, 400, "invalid_search"],
    [429, 503, "search_busy"],
    [500, 502, "search_unavailable"],
  ])("maps upstream %i to %i %s without leaking details", async (upstream, status, code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createChannel3Client("k", fakeFetch(upstream, { detail: "secret upstream detail" }));
    await expect(client.search(params)).rejects.toMatchObject({ status, code });
  });

  it("maps network failures and bad payloads to 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createChannel3Client("k", offline).search(params)).rejects.toMatchObject({ status: 502 });
    await expect(createChannel3Client("k", fakeFetch(200, "not json")).search(params)).rejects.toMatchObject({ status: 502 });
  });

  it("fetches a single product in USD and returns null on 404", async () => {
    const fetchImpl = fakeFetch(200, rawChair);
    const product = await createChannel3Client("secret-key", fetchImpl).getProduct("abc 123", "user-1");
    expect(product).toMatchObject({ channel3ProductId: "abc123", unitPriceCents: 29950 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${CHANNEL3_BASE_URL}/v1/products/abc%20123?country=US&currency=USD`);
    expect(init?.headers).toMatchObject({ "x-api-key": "secret-key", "x-user-id": "user-1" });

    expect(await createChannel3Client("k", fakeFetch(404, { detail: "nope" })).getProduct("x", "u")).toBeNull();
  });
});

describe("product search service", () => {
  const product = toProductCandidate(rawChair) as ProductCandidate;
  const base = { query: "Office  Chair", limit: 5, userId: "u1" };

  it("caches identical searches per user without spending quota", async () => {
    const client = { search: vi.fn(async () => [product]), getProduct: vi.fn(async () => null) };
    const service = createProductSearchService({ client, dailyLimitPerUser: 5 });

    const first = await service.search(base);
    const second = await service.search({ ...base, query: "office chair " });
    const otherUser = await service.search({ ...base, userId: "u2" });

    expect(first).toMatchObject({ cached: false, searchesRemainingToday: 4 });
    expect(second).toMatchObject({ cached: true, searchesRemainingToday: 4 });
    expect(otherUser.cached).toBe(false);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it("expires cache entries after the TTL", async () => {
    let clock = 0;
    const client = { search: vi.fn(async () => [product]), getProduct: vi.fn(async () => null) };
    const service = createProductSearchService({ client, dailyLimitPerUser: 5, cacheTtlMs: 1000, now: () => clock });
    await service.search(base);
    clock = 1001;
    expect((await service.search(base)).cached).toBe(false);
  });

  it("enforces the per-user daily cap and resets the next UTC day", async () => {
    let clock = Date.UTC(2026, 9, 21, 10);
    const client = { search: vi.fn(async () => [product]), getProduct: vi.fn(async () => null) };
    const service = createProductSearchService({ client, dailyLimitPerUser: 2, now: () => clock });

    await service.search({ ...base, query: "a1" });
    await service.search({ ...base, query: "a2" });
    await expect(service.search({ ...base, query: "a3" })).rejects.toMatchObject({ status: 429, code: "search_limit_reached" });
    expect((await service.search({ ...base, query: "a3", userId: "u2" })).cached).toBe(false);

    clock = Date.UTC(2026, 9, 22, 0, 1);
    expect((await service.search({ ...base, query: "a3" })).searchesRemainingToday).toBe(1);
  });

  it("reports not configured when there is no API key", async () => {
    const service = createProductSearchService({ client: null, dailyLimitPerUser: 5 });
    await expect(service.search(base)).rejects.toMatchObject({ status: 503, code: "search_not_configured" });
  });

  it("resolves products the user already saw without spending quota", async () => {
    const client = { search: vi.fn(async () => [product]), getProduct: vi.fn(async () => null) };
    const service = createProductSearchService({ client, dailyLimitPerUser: 5 });
    await service.search(base);

    expect(await service.resolveProduct("u1", "abc123")).toEqual(product);
    expect(client.getProduct).not.toHaveBeenCalled();
    expect((await service.search({ ...base, query: "other" })).searchesRemainingToday).toBe(3);
  });

  it("falls back to Channel3 for unseen products, spending quota and remembering the result", async () => {
    const client = { search: vi.fn(async () => []), getProduct: vi.fn(async (id: string) => (id === "abc123" ? product : null)) };
    const service = createProductSearchService({ client, dailyLimitPerUser: 5 });

    expect(await service.resolveProduct("u1", "abc123")).toEqual(product);
    expect(await service.resolveProduct("u1", "abc123")).toEqual(product);
    expect(await service.resolveProduct("u1", "missing")).toBeNull();
    expect(client.getProduct).toHaveBeenCalledTimes(2);
    // Seen products are per user
    await service.resolveProduct("u2", "abc123");
    expect(client.getProduct).toHaveBeenCalledTimes(3);
    expect((await service.search(base)).searchesRemainingToday).toBe(2);
  });
});

describe("POST /api/products/search", () => {
  const config = {
    CLIENT_ORIGIN: "http://localhost:5173",
    NODE_ENV: "test" as const,
    JWT_SECRET: "test-secret-that-is-at-least-32-characters",
    BCRYPT_ROUNDS: 4,
  };
  const product = toProductCandidate(rawChair) as ProductCandidate;
  const client = { search: vi.fn(async () => [product]), getProduct: vi.fn(async () => null) };
  const app = createApp(config, { productSearch: createProductSearchService({ client, dailyLimitPerUser: 5 }) });
  const cookie = `${SESSION_COOKIE}=${signSession("507f1f77bcf86cd799439011", config.JWT_SECRET)}`;

  it("requires sign-in", async () => {
    const res = await request(app).post("/api/products/search").send({ query: "chair" });
    expect(res.status).toBe(401);
  });

  it("returns mapped products for the signed-in user", async () => {
    const res = await request(app).post("/api/products/search").set("Cookie", cookie).send({ query: "chair", maxPriceCents: 30000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cached: false, products: [{ channel3ProductId: "abc123", unitPriceCents: 29950 }] });
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "chair", limit: 10, maxPriceCents: 30000, userId: "507f1f77bcf86cd799439011" }),
    );
  });

  it("validates the body", async () => {
    const res = await request(app)
      .post("/api/products/search")
      .set("Cookie", cookie)
      .send({ query: "x", limit: 99, minPriceCents: 500, maxPriceCents: 100 });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["query", "limit"]));
  });

  it("returns 503 when search is not configured", async () => {
    const bare = createApp(config);
    const res = await request(bare).post("/api/products/search").set("Cookie", cookie).send({ query: "chair" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("search_not_configured");
  });
});
