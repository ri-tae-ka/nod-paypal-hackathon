import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../middleware/requireAuth.js";
import type { PaymentService } from "../services/paymentService.js";

const orderParams = z.object({ orderId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });

/** Mounted at /api; auth is applied per route so unknown /api paths still 404. */
export function createPaymentsRouter(jwtSecret: string, service: PaymentService) {
  const router = Router();
  const auth = requireAuth(jwtSecret);

  router.post("/requests/:id/checkout", auth, async (req, res) => {
    res.status(201).json({ payment: await service.checkout(currentUserId(res), String(req.params.id)) });
  });

  router.get("/requests/:id/payments", auth, async (req, res) => {
    res.json({ payments: await service.listPayments(currentUserId(res), String(req.params.id)) });
  });

  router.post("/payments/:orderId/capture", auth, async (req, res) => {
    const { orderId } = orderParams.parse(req.params);
    res.json({ payment: await service.capture(currentUserId(res), orderId) });
  });

  return router;
}
