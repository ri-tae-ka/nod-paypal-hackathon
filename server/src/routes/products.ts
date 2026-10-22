import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../middleware/requireAuth.js";
import type { ProductSearchService } from "../services/productSearch.js";

const searchBody = z
  .object({
    query: z.string().trim().min(2).max(200),
    limit: z.number().int().min(1).max(30).default(10),
    minPriceCents: z.number().int().min(0).optional(),
    maxPriceCents: z.number().int().min(1).optional(),
  })
  .refine(
    (b) => b.minPriceCents === undefined || b.maxPriceCents === undefined || b.minPriceCents <= b.maxPriceCents,
    { message: "minPriceCents must not exceed maxPriceCents", path: ["minPriceCents"] },
  );

export function createProductsRouter(jwtSecret: string, productSearch: ProductSearchService) {
  const router = Router();
  router.post("/search", requireAuth(jwtSecret), async (req, res) => {
    const body = searchBody.parse(req.body);
    const result = await productSearch.search({ ...body, userId: currentUserId(res) });
    res.json(result);
  });
  return router;
}
