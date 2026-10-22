import { HttpError } from "../middleware/errorHandler.js";
import type { Channel3Client, Channel3SearchParams } from "./channel3/client.js";
import type { ProductCandidate } from "./channel3/mapper.js";

export interface ProductSearchOptions {
  client: Channel3Client | null;
  dailyLimitPerUser: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  seenTtlMs?: number;
  maxSeenPerUser?: number;
  now?: () => number;
}

export interface SearchResult {
  products: ProductCandidate[];
  cached: boolean;
  searchesRemainingToday: number;
}

export interface ProductSearchService {
  search(params: Channel3SearchParams): Promise<SearchResult>;
  /**
   * Server-side source of truth for a product's price and details. Uses what this user saw in a recent
   * search when possible, otherwise asks Channel3 (counts against the daily cap). Null if unknown.
   */
  resolveProduct(userId: string, productId: string): Promise<ProductCandidate | null>;
}

/**
 * Wraps Channel3 with a per-user cache and a per-user daily cap, to protect the free-tier quota.
 * Cache hits don't count against the cap. Everything lives in memory, so it resets on restart.
 */
export function createProductSearchService({
  client,
  dailyLimitPerUser,
  cacheTtlMs = 15 * 60 * 1000,
  maxCacheEntries = 200,
  seenTtlMs = 2 * 60 * 60 * 1000,
  maxSeenPerUser = 500,
  now = Date.now,
}: ProductSearchOptions): ProductSearchService {
  const cache = new Map<string, { expiresAt: number; products: ProductCandidate[] }>();
  const usage = new Map<string, { day: string; count: number }>();
  const seen = new Map<string, Map<string, { expiresAt: number; product: ProductCandidate }>>();

  const today = () => new Date(now()).toISOString().slice(0, 10);
  const usedToday = (userId: string) => {
    const entry = usage.get(userId);
    return entry && entry.day === today() ? entry.count : 0;
  };

  function requireClient(): Channel3Client {
    if (!client) {
      throw new HttpError(503, "Product search is not configured on this server.", "search_not_configured");
    }
    return client;
  }

  /** Counts a Channel3 call against today's cap. Counted before the call so concurrent requests can't overshoot. */
  function consumeQuota(userId: string): number {
    const used = usedToday(userId);
    if (used >= dailyLimitPerUser) {
      throw new HttpError(429, "Daily product search limit reached. Try again tomorrow.", "search_limit_reached");
    }
    usage.set(userId, { day: today(), count: used + 1 });
    return dailyLimitPerUser - used - 1;
  }

  function remember(userId: string, products: ProductCandidate[]) {
    let userSeen = seen.get(userId);
    if (!userSeen) seen.set(userId, (userSeen = new Map()));
    for (const product of products) {
      userSeen.delete(product.channel3ProductId);
      userSeen.set(product.channel3ProductId, { expiresAt: now() + seenTtlMs, product });
    }
    while (userSeen.size > maxSeenPerUser) {
      const oldest = userSeen.keys().next().value;
      if (oldest === undefined) break;
      userSeen.delete(oldest);
    }
  }

  return {
    async search(params) {
      const channel3 = requireClient();

      // userId is part of the key because Channel3 embeds it in the buy URLs it returns.
      const key = JSON.stringify([
        params.userId,
        params.query.trim().toLowerCase().replace(/\s+/g, " "),
        params.limit,
        params.minPriceCents ?? null,
        params.maxPriceCents ?? null,
      ]);

      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) {
        remember(params.userId, hit.products);
        return {
          products: hit.products,
          cached: true,
          searchesRemainingToday: dailyLimitPerUser - usedToday(params.userId),
        };
      }
      cache.delete(key);

      const remaining = consumeQuota(params.userId);
      const products = await channel3.search(params);

      if (cache.size >= maxCacheEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { expiresAt: now() + cacheTtlMs, products });
      remember(params.userId, products);

      return { products, cached: false, searchesRemainingToday: remaining };
    },

    async resolveProduct(userId, productId) {
      const entry = seen.get(userId)?.get(productId);
      if (entry && entry.expiresAt > now()) return entry.product;

      const channel3 = requireClient();
      consumeQuota(userId);
      const product = await channel3.getProduct(productId, userId);
      if (product) remember(userId, [product]);
      return product;
    },
  };
}
