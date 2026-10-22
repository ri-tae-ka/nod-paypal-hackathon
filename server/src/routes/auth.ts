import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { type AuthConfig, createAuthController } from "../controllers/authController.js";
import { requireAuth } from "../middleware/requireAuth.js";

export interface AuthRateLimits {
  windowMs: number;
  login: number;
  register: number;
}

// Login only counts failed attempts; register counts every attempt.
export const defaultAuthRateLimits: AuthRateLimits = { windowMs: 15 * 60 * 1000, login: 10, register: 5 };

function limiter(windowMs: number, limit: number, skipSuccessfulRequests = false) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts. Try again later." } });
    },
  });
}

export function createAuthRouter(config: AuthConfig, limits: AuthRateLimits = defaultAuthRateLimits) {
  const controller = createAuthController(config);
  const router = Router();
  router.post("/register", limiter(limits.windowMs, limits.register), controller.register);
  router.post("/login", limiter(limits.windowMs, limits.login, true), controller.login);
  router.post("/logout", controller.logout);
  router.get("/me", requireAuth(config.JWT_SECRET), controller.me);
  return router;
}
