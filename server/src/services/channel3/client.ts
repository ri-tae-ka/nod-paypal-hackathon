import { HttpError } from "../../middleware/errorHandler.js";
import { type ProductCandidate, channel3SearchResponseSchema, toProductCandidate } from "./mapper.js";

export const CHANNEL3_BASE_URL = "https://api.trychannel3.com";
const TIMEOUT_MS = 15_000;

export interface Channel3SearchParams {
  query: string;
  limit: number;
  minPriceCents?: number;
  maxPriceCents?: number;
  userId: string;
}

export interface Channel3Client {
  search(params: Channel3SearchParams): Promise<ProductCandidate[]>;
  /** Returns null when Channel3 doesn't know the product or it has no usable USD offer. */
  getProduct(productId: string, userId: string): Promise<ProductCandidate | null>;
}

function upstreamError(status: number): HttpError {
  switch (status) {
    case 401:
    case 403:
      return new HttpError(502, "Product search is misconfigured.", "search_unavailable");
    case 402:
      return new HttpError(503, "Product search credits are used up.", "search_quota_exhausted");
    case 422:
      return new HttpError(400, "That search could not be run. Try different wording.", "invalid_search");
    case 429:
      return new HttpError(503, "Product search is busy. Try again shortly.", "search_busy");
    default:
      return new HttpError(502, "Product search is unavailable right now.", "search_unavailable");
  }
}

export function createChannel3Client(apiKey: string, fetchImpl: typeof fetch = fetch): Channel3Client {
  return {
    async search({ query, limit, minPriceCents, maxPriceCents, userId }) {
      const price =
        minPriceCents !== undefined || maxPriceCents !== undefined
          ? {
              ...(minPriceCents !== undefined && { min_price: minPriceCents / 100 }),
              ...(maxPriceCents !== undefined && { max_price: maxPriceCents / 100 }),
            }
          : undefined;

      let response: Response;
      try {
        response = await fetchImpl(`${CHANNEL3_BASE_URL}/v1/search`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "x-user-id": userId },
          body: JSON.stringify({
            query,
            limit,
            filters: { availability: ["InStock"], conditions: ["new"], ...(price && { price }) },
            config: { country: "US", currency: "USD" },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        console.error("Channel3 request failed:", error instanceof Error ? error.message : error);
        throw upstreamError(0);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(`Channel3 responded ${response.status}: ${detail.slice(0, 300)}`);
        throw upstreamError(response.status);
      }

      const body = channel3SearchResponseSchema.safeParse(await response.json().catch(() => null));
      if (!body.success) {
        console.error("Channel3 returned an unexpected response shape");
        throw upstreamError(0);
      }
      return body.data.products.map(toProductCandidate).filter((p): p is ProductCandidate => p !== null);
    },

    async getProduct(productId, userId) {
      const url = new URL(`${CHANNEL3_BASE_URL}/v1/products/${encodeURIComponent(productId)}`);
      url.searchParams.set("country", "US");
      url.searchParams.set("currency", "USD");

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          headers: { "x-api-key": apiKey, "x-user-id": userId },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        console.error("Channel3 request failed:", error instanceof Error ? error.message : error);
        throw upstreamError(0);
      }

      if (response.status === 404) return null;
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(`Channel3 responded ${response.status}: ${detail.slice(0, 300)}`);
        throw upstreamError(response.status);
      }
      return toProductCandidate(await response.json().catch(() => null));
    },
  };
}
