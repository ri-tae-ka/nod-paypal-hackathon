import { HttpError } from "../../middleware/errorHandler.js";
import { type JsonSchema, type LlmClient, LlmOutputError } from "./llm.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 60_000;

/** Keywords Gemini's OpenAPI-subset `responseSchema` accepts; anything else is dropped. */
const PASSTHROUGH_KEYS = ["description", "format", "enum", "minItems", "maxItems", "minimum", "maximum"] as const;

/**
 * Converts the agent's strict JSON Schema into Gemini's schema dialect:
 * uppercase types, `nullable` instead of `["x","null"]`, no `additionalProperties`.
 */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  let type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length !== type.length) out.nullable = true;
    type = nonNull[0];
  }
  if (typeof type === "string") out.type = type.toUpperCase();
  for (const key of PASSTHROUGH_KEYS) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.properties) {
    const properties = schema.properties as Record<string, JsonSchema>;
    out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(properties);
    if (schema.required) out.required = schema.required;
  }
  if (schema.items) out.items = toGeminiSchema(schema.items as JsonSchema);
  return out;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

async function upstreamError(response: Response): Promise<HttpError> {
  const text = await response.text().catch(() => "");
  console.error(`Gemini responded ${response.status}: ${text.slice(0, 500)}`);
  if (response.status === 429) {
    return new HttpError(503, "The AI service is busy or over its free quota. Try again in a minute.", "ai_busy");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    return new HttpError(502, "The AI service is misconfigured.", "ai_unavailable");
  }
  return new HttpError(502, "The AI service is unavailable. Try again shortly.", "ai_unavailable");
}

/** Gemini generateContent with JSON mode and a response schema. */
export function createGeminiClient(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): LlmClient {
  return {
    model,
    async generateJson({ system, user, responseSchema, parse, temperature = 0.2 }) {
      let response: Response;
      try {
        response = await fetchImpl(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              temperature,
              responseMimeType: "application/json",
              responseSchema: toGeminiSchema(responseSchema),
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
        console.error(
          "Gemini request failed:",
          error instanceof Error ? `${error.name}: ${error.message}` : error,
          cause ? `(cause: ${cause.code ?? ""} ${cause.message ?? ""})` : "",
        );
        throw new HttpError(502, "The AI service is unavailable. Try again shortly.", "ai_unavailable");
      }

      if (!response.ok) throw await upstreamError(response);

      let body: GeminiResponse;
      try {
        body = (await response.json()) as GeminiResponse;
      } catch {
        throw new HttpError(502, "The AI service returned an unreadable response.", "ai_unavailable");
      }

      if (body.promptFeedback?.blockReason) {
        throw new HttpError(422, "The AI declined this request. Try rewording it.", "ai_refused");
      }
      const candidate = body.candidates?.[0];
      if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
        throw new HttpError(422, "The AI declined this request. Try rewording it.", "ai_refused");
      }
      const text = candidate?.content?.parts
        ?.filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (!text) throw new LlmOutputError(`Empty model output (finishReason ${candidate?.finishReason ?? "unknown"})`);
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new LlmOutputError("Model output was cut off; keep the answer shorter.");
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmOutputError("Model output was not valid JSON.");
      }
      const result = parse.safeParse(json);
      if (!result.success) {
        throw new LlmOutputError(
          `Model output did not match the schema: ${result.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      return result.data;
    },
  };
}
