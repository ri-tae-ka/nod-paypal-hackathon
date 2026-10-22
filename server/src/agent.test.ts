import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { createApp } from "./app.js";
import { ProcurementRequest } from "./models/ProcurementRequest.js";
import { Version } from "./models/Version.js";
import { type JsonGenerationRequest, type JsonSchema, type LlmClient, LlmOutputError } from "./services/ai/llm.js";
import { GEMINI_BASE_URL, createGeminiClient, toGeminiSchema } from "./services/ai/gemini.js";
import { SESSION_COOKIE, signSession } from "./services/authService.js";
import type { ProductCandidate } from "./services/channel3/mapper.js";
import { weightedRating } from "./services/procurementAgent.js";
import type { ProductSearchService } from "./services/productSearch.js";
import { HttpError } from "./middleware/errorHandler.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}
const completion = (text: string | null, finishReason = "STOP") => ({
  candidates: [{ content: { parts: text === null ? [] : [{ text: "thinking...", thought: true }, { text }] }, finishReason }],
});

describe("weightedRating", () => {
  it("discounts ratings with few reviews", () => {
    expect(weightedRating(null)).toBeNull();
    expect(weightedRating({ value: 5, count: 2 })).toBeLessThan(weightedRating({ value: 4.5, count: 800 })!);
    expect(weightedRating({ value: 4.5, count: 800 })).toBeCloseTo(4.49, 2);
  });
});

describe("toGeminiSchema", () => {
  it("converts strict JSON Schema to Gemini's dialect", () => {
    expect(
      toGeminiSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: ["string", "null"], description: "why" },
          tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, maxItems: 3 },
        },
        required: ["note", "tags"],
      }),
    ).toEqual({
      type: "OBJECT",
      properties: {
        note: { type: "STRING", nullable: true, description: "why" },
        tags: { type: "ARRAY", items: { type: "STRING", enum: ["a", "b"] }, maxItems: 3 },
      },
      propertyOrdering: ["note", "tags"],
      required: ["note", "tags"],
    });
  });
});

describe("Gemini client", () => {
  const request = {
    schemaName: "test_output",
    system: "sys",
    user: "hello",
    responseSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    parse: { safeParse: (v: unknown) => ({ success: true, data: v }) } as unknown as ZodType<{ ok: boolean }>,
  } satisfies JsonGenerationRequest<{ ok: boolean }>;

  it("sends the key, prompts and response schema, and ignores thought parts", async () => {
    const fetchImpl = fakeFetch(200, completion('{"ok":true}'));
    const output = await createGeminiClient("g-key", "gemini-2.5-flash", fetchImpl).generateJson(request);
    expect(output).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${GEMINI_BASE_URL}/models/gemini-2.5-flash:generateContent`);
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "g-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: {} } },
    });
  });

  it("maps upstream failures without leaking details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const call = (status: number) => createGeminiClient("k", "m", fakeFetch(status, { error: "secret" })).generateJson(request);
    await expect(call(429)).rejects.toMatchObject({ status: 503, code: "ai_busy" });
    await expect(call(403)).rejects.toMatchObject({ status: 502, code: "ai_unavailable" });
    await expect(call(500)).rejects.toMatchObject({ status: 502, code: "ai_unavailable" });
  });

  it("reports refusals and unusable output distinctly", async () => {
    const client = (body: unknown) => createGeminiClient("k", "m", fakeFetch(200, body));
    await expect(client({ promptFeedback: { blockReason: "SAFETY" } }).generateJson(request)).rejects.toMatchObject({
      status: 422,
      code: "ai_refused",
    });
    await expect(client(completion(null, "SAFETY")).generateJson(request)).rejects.toMatchObject({ code: "ai_refused" });
    await expect(client(completion("not json")).generateJson(request)).rejects.toBeInstanceOf(LlmOutputError);
    await expect(client(completion('{"ok":', "MAX_TOKENS")).generateJson(request)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

/** Strict schema shape: every object lists all properties as required and forbids extras (keeps output predictable). */
function assertStrictSchema(schema: JsonSchema, path = "$") {
  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"))) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect([...((schema.required as string[]) ?? [])].sort(), `${path}.required`).toEqual(Object.keys(properties).sort());
    for (const [key, child] of Object.entries(properties)) assertStrictSchema(child, `${path}.${key}`);
  }
  if (schema.items) assertStrictSchema(schema.items as JsonSchema, `${path}[]`);
}

// ---------- Agent end-to-end through the API, with a scripted model ----------

const TEST_DB_URI = process.env.TEST_AGENT_MONGODB_URI ?? "mongodb://127.0.0.1:27017/procurement_desk_test_agent";
const config = {
  CLIENT_ORIGIN: "http://localhost:5173",
  NODE_ENV: "test" as const,
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  BCRYPT_ROUNDS: 4,
  AI_DAILY_GENERATION_LIMIT: 5,
};

let dbAvailable = false;
try {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
  dbAvailable = true;
} catch {
  console.warn(`Skipping agent tests: no MongoDB at ${TEST_DB_URI}`);
}

function product(id: string, unitPriceCents: number, rating: ProductCandidate["rating"] = { value: 4.5, count: 200 }): ProductCandidate {
  return {
    channel3ProductId: id,
    title: `Product ${id}`,
    brand: "Acme",
    imageUrl: null,
    category: null,
    materials: [],
    keyFeatures: [],
    rating,
    retailerDomain: "shop.example",
    buyUrl: `https://shop.example/${id}`,
    availability: "InStock",
    currency: "USD",
    unitPriceCents,
    compareAtPriceCents: null,
    offerCount: 1,
  };
}

const resultsByQuery: Record<string, ProductCandidate[]> = {
  "standing desk": [product("desk-a", 30000), product("desk-b", 45000, { value: 4.8, count: 900 })],
  "office chair": [product("chair-a", 15000), product("chair-b", 32000, { value: 4.7, count: 1200 })],
  "desk lamp": [product("lamp-a", 2500)],
  "unicorn saddle": [],
};
const catalog = new Map(Object.values(resultsByQuery).flat().map((p) => [p.channel3ProductId, p]));

const productSearch: ProductSearchService = {
  search: vi.fn(async ({ query }) => ({ products: resultsByQuery[query] ?? [], cached: false, searchesRemainingToday: 10 })),
  resolveProduct: vi.fn(async (_userId: string, id: string) => catalog.get(id) ?? null),
};

/** Fake model: returns scripted outputs in order, validated like the real client does. */
function scriptedLlm(outputs: unknown[]) {
  const calls: { system: string; user: string; schema: JsonSchema }[] = [];
  const llm: LlmClient = {
    model: "fake-model",
    async generateJson<T>(req: JsonGenerationRequest<T>): Promise<T> {
      calls.push({ system: req.system, user: req.user, schema: req.responseSchema });
      const next = outputs.shift();
      if (next === undefined) throw new Error("No scripted output left");
      if (next instanceof Error) throw next;
      const parsed = req.parse.safeParse(next);
      if (!parsed.success) throw new LlmOutputError(parsed.error.message);
      return parsed.data;
    },
  };
  return { llm, calls };
}

const searchNeed = (key: string, searchQuery: string, quantity: number, extra: object = {}) => ({
  key,
  description: `Need ${key}`,
  action: "search",
  quantity,
  searchQuery,
  rationale: "",
  ...extra,
});
const keepNeed = (key: string, id: string, quantity: number) => ({
  key,
  description: `Keep ${key}`,
  action: "keep",
  quantity,
  keepChannel3ProductId: id,
  rationale: "",
});
const firstPlan = {
  summary: "Desk and chair for one person",
  needs: [searchNeed("desk", "standing desk", 1), searchNeed("chair", "office chair", 2, { maxUnitPriceCents: 20000 })],
};
const firstPicks = {
  picks: [
    { needKey: "desk", channel3ProductId: "desk-a", rationale: "4.5 from 200 reviews at a fair price" },
    { needKey: "chair", channel3ProductId: "chair-a", rationale: "Within the per-chair cap" },
  ],
};

const userId = new Types.ObjectId().toString();
const cookie = `${SESSION_COOKIE}=${signSession(userId, config.JWT_SECRET)}`;

describe.skipIf(!dbAvailable)("POST /api/requests/:id/generate", () => {
  const appWith = (llm: LlmClient | null) => createApp(config, { productSearch, llm });

  async function newRequest(budgetCents?: number) {
    const res = await request(appWith(null))
      .post("/api/requests")
      .set("Cookie", cookie)
      .send({ prompt: "Home office for one person", budgetCents });
    return res.body.request.id as string;
  }
  const generate = (app: ReturnType<typeof appWith>, id: string, body: object) =>
    request(app).post(`/api/requests/${id}/generate`).set("Cookie", cookie).send(body);

  beforeAll(async () => {
    await Version.init();
  });
  beforeEach(async () => {
    await Promise.all([ProcurementRequest.deleteMany({}), Version.deleteMany({})]);
    vi.mocked(productSearch.search).mockClear();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it("returns 503 when AI is not configured", async () => {
    const id = await newRequest();
    const res = await generate(appWith(null), id, { expectedLatestVersion: 0 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ai_not_configured");
  });

  it("plans, searches, selects and saves version 1 with server prices", async () => {
    const id = await newRequest(70000);
    const { llm, calls } = scriptedLlm([firstPlan, firstPicks]);
    const res = await generate(appWith(llm), id, { expectedLatestVersion: 0 });

    expect(res.status).toBe(201);
    expect(res.body.version).toMatchObject({
      number: 1,
      summary: "Desk and chair for one person",
      totalCents: 60000,
      budget: { budgetCents: 70000, overBudget: false },
    });
    expect(res.body.version.items).toEqual([
      expect.objectContaining({ channel3ProductId: "desk-a", quantity: 1, unitPriceCents: 30000, rationale: "4.5 from 200 reviews at a fair price" }),
      expect.objectContaining({ channel3ProductId: "chair-a", quantity: 2, unitPriceCents: 15000 }),
    ]);
    expect(res.body).toMatchObject({ diff: null, agent: { model: "fake-model", searches: 2, unmet: [] } });

    expect(productSearch.search).toHaveBeenCalledWith(expect.objectContaining({ query: "office chair", maxPriceCents: 20000, userId }));
    expect(calls[0]!.user).toContain('"budgetCents": 70000');
    // Selection sees reviews-adjusted ratings alongside the raw ones
    expect(calls[1]!.user).toContain('"weightedRating"');
    expect(calls[1]!.user).toContain("(200 reviews)");
    for (const call of calls) assertStrictSchema(call.schema);
  });

  it("feeds validation errors back once and accepts the corrected answer", async () => {
    const id = await newRequest();
    const badPicks = { picks: [{ needKey: "desk", channel3ProductId: "chair-a", rationale: "" }] };
    const { llm, calls } = scriptedLlm([firstPlan, badPicks, firstPicks]);
    const res = await generate(appWith(llm), id, { expectedLatestVersion: 0 });

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.user).toContain('"chair-a" is not a candidate for need "desk"');
  });

  it("gives up after two invalid answers without creating a version", async () => {
    const id = await newRequest();
    const badPlan = { summary: "x", needs: [keepNeed("ghost", "not-on-sheet", 1)] };
    const { llm } = scriptedLlm([badPlan, { summary: "x", needs: "nope" }]);
    const res = await generate(appWith(llm), id, { expectedLatestVersion: 0 });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_bad_output");
    expect(await Version.countDocuments()).toBe(0);
  });

  it("revises by keeping and removing lines without searching, and returns the diff", async () => {
    const id = await newRequest();
    await generate(appWith(scriptedLlm([firstPlan, firstPicks]).llm), id, { expectedLatestVersion: 0 });

    const { llm, calls } = scriptedLlm([{ summary: "Dropped the desk, 3 chairs", needs: [keepNeed("chair", "chair-a", 3)] }]);
    const res = await generate(appWith(llm), id, { instruction: "Remove the desk and add a third chair", expectedLatestVersion: 1 });

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(productSearch.search).toHaveBeenCalledTimes(2);
    expect(calls[0]!.user).toContain("chair-a");
    expect(res.body.version).toMatchObject({ number: 2, basedOnVersion: 1, instruction: "Remove the desk and add a third chair", totalCents: 45000 });
    expect(res.body.version.items[0].rationale).toBe("Within the per-chair cap");
    expect(res.body.diff).toMatchObject({
      totalDeltaCents: -15000,
      removed: [expect.objectContaining({ channel3ProductId: "desk-a" })],
      changed: [expect.objectContaining({ channel3ProductId: "chair-a", quantity: 3 })],
    });
  });

  it("upgrades quality by re-searching a line while keeping the rest", async () => {
    const id = await newRequest();
    await generate(appWith(scriptedLlm([firstPlan, firstPicks]).llm), id, { expectedLatestVersion: 0 });

    const { llm } = scriptedLlm([
      { summary: "Better chairs", needs: [keepNeed("desk", "desk-a", 1), searchNeed("chair", "office chair", 2)] },
      { picks: [{ needKey: "chair", channel3ProductId: "chair-b", rationale: "4.7 from 1200 reviews" }] },
    ]);
    const res = await generate(appWith(llm), id, { instruction: "Upgrade quality", expectedLatestVersion: 1 });

    expect(res.status).toBe(201);
    expect(res.body.diff.added).toEqual([expect.objectContaining({ channel3ProductId: "chair-b" })]);
    expect(res.body.diff.removed).toEqual([expect.objectContaining({ channel3ProductId: "chair-a" })]);
  });

  it("reports needs it could not fill, and fails when nothing could be filled", async () => {
    const id = await newRequest();
    const plan = { summary: "s", needs: [searchNeed("lamp", "desk lamp", 1), searchNeed("saddle", "unicorn saddle", 1)] };
    const ok = await generate(appWith(scriptedLlm([plan, { picks: [{ needKey: "lamp", channel3ProductId: "lamp-a" }] }]).llm), id, {
      expectedLatestVersion: 0,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.agent.unmet).toEqual([{ key: "saddle", description: "Need saddle", reason: "no_results" }]);

    const other = await newRequest();
    const none = await generate(appWith(scriptedLlm([{ summary: "s", needs: [searchNeed("saddle", "unicorn saddle", 1)] }]).llm), other, {
      expectedLatestVersion: 0,
    });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe("ai_no_result");
  });

  it("checks state before spending AI calls", async () => {
    const id = await newRequest();
    await generate(appWith(scriptedLlm([firstPlan, firstPicks]).llm), id, { expectedLatestVersion: 0 });
    const { llm, calls } = scriptedLlm([]);

    const stale = await generate(appWith(llm), id, { instruction: "Upgrade quality", expectedLatestVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "version_conflict", details: { latestVersion: 1 } });

    const noInstruction = await generate(appWith(llm), id, { expectedLatestVersion: 1 });
    expect(noInstruction.body.error.code).toBe("instruction_required");

    expect((await generate(appWith(llm), new Types.ObjectId().toString(), { expectedLatestVersion: 0 })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("enforces the daily generation limit per user", async () => {
    const id = await newRequest();
    const app = appWith(scriptedLlm(Array.from({ length: 5 }, () => new HttpError(503, "busy", "ai_busy"))).llm);
    for (let i = 0; i < 5; i++) expect((await generate(app, id, { expectedLatestVersion: 0 })).status).toBe(503);
    const limited = await generate(app, id, { expectedLatestVersion: 0 });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("ai_limit_reached");
  });

  it("validates the body", async () => {
    const id = await newRequest();
    const res = await generate(appWith(scriptedLlm([]).llm), id, { instruction: "x" });
    expect(res.status).toBe(400);
  });
});
