import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { currentUserId, requireAuth } from "../middleware/requireAuth.js";
import type { PoolService } from "../services/poolService.js";

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/) });
const captureParams = tokenParams.extend({ orderId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });

const openPoolBody = z.object({
  story: z.string().trim().max(2000).optional(),
  organizer: z.string().trim().min(1).max(60).optional(),
  deadline: z.coerce.date().optional(),
});

const contributeBody = z.object({
  amountCents: z.number().int().min(1).max(100_000_000),
  name: z.string().trim().max(60).optional(),
  anonymous: z.boolean().optional(),
  message: z.string().trim().max(200).optional(),
});

export interface PoolRateLimits {
  windowMs: number;
  /** Pledges and captures per IP; guests are unauthenticated, so this caps abuse. */
  writes: number;
}

export const defaultPoolRateLimits: PoolRateLimits = { windowMs: 15 * 60 * 1000, writes: 30 };

/** Mounted at /api. Owner routes need a session; the /pools/:token routes are public for guests. */
export function createPoolsRouter(jwtSecret: string, service: PoolService, limits: PoolRateLimits = defaultPoolRateLimits) {
  const router = Router();
  const auth = requireAuth(jwtSecret);
  const writeLimit = rateLimit({
    windowMs: limits.windowMs,
    limit: limits.writes,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts. Try again later." } });
    },
  });

  router.post("/requests/:id/pool", auth, async (req, res) => {
    const body = openPoolBody.parse(req.body ?? {});
    const pool = await service.openPool(currentUserId(res), String(req.params.id), {
      ...(body.story && { story: body.story }),
      ...(body.organizer && { organizer: body.organizer }),
      ...(body.deadline && { deadline: body.deadline }),
    });
    res.status(201).json({ pool });
  });

  router.post("/requests/:id/pool/cancel", auth, async (req, res) => {
    res.json(await service.cancelPool(currentUserId(res), String(req.params.id)));
  });

  router.get("/requests/:id/pool/contributions", auth, async (req, res) => {
    res.json({ contributions: await service.ownerContributions(currentUserId(res), String(req.params.id)) });
  });

  router.get("/pools/:token", async (req, res) => {
    const { token } = tokenParams.parse(req.params);
    res.json(await service.publicView(token));
  });

  router.post("/pools/:token/contribute", writeLimit, async (req, res) => {
    const { token } = tokenParams.parse(req.params);
    const body = contributeBody.parse(req.body);
    res.status(201).json(
      await service.contribute(token, {
        amountCents: body.amountCents,
        ...(body.name && { name: body.name }),
        ...(body.anonymous !== undefined && { anonymous: body.anonymous }),
        ...(body.message && { message: body.message }),
      }),
    );
  });

  router.post("/pools/:token/contributions/:orderId/capture", writeLimit, async (req, res) => {
    const { token, orderId } = captureParams.parse(req.params);
    res.json(await service.capture(token, orderId));
  });

  return router;
}
