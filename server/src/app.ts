import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import path from "node:path";
import helmet from "helmet";
import type { Env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { type AuthRateLimits, createAuthRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { createPaymentsRouter } from "./routes/payments.js";
import { createProductsRouter } from "./routes/products.js";
import { createRequestsRouter } from "./routes/requests.js";
import type { LlmClient } from "./services/ai/llm.js";
import { createGeminiClient } from "./services/ai/gemini.js";
import { createChannel3Client } from "./services/channel3/client.js";
import { createPaymentService } from "./services/paymentService.js";
import { type PayPalClient, createPayPalClient } from "./services/paypal/client.js";
import { createProcurementAgent } from "./services/procurementAgent.js";
import { type ProductSearchService, createProductSearchService } from "./services/productSearch.js";
import { createRequestService } from "./services/requestService.js";

export type AppConfig = Pick<Env, "CLIENT_ORIGIN" | "NODE_ENV" | "JWT_SECRET" | "BCRYPT_ROUNDS"> &
  Partial<
    Pick<
      Env,
      | "CHANNEL3_API_KEY"
      | "CHANNEL3_DAILY_SEARCH_LIMIT"
      | "GEMINI_API_KEY"
      | "GEMINI_MODEL"
      | "AI_DAILY_GENERATION_LIMIT"
      | "PAYPAL_CLIENT_ID"
      | "PAYPAL_CLIENT_SECRET"
    >
  >;

export interface AppOptions {
  authRateLimits?: AuthRateLimits;
  productSearch?: ProductSearchService;
  /** Pass null to run without AI; omit to build a Gemini client from config. */
  llm?: LlmClient | null;
  /** Pass null to run without payments; omit to build a PayPal Sandbox client from config. */
  paypal?: PayPalClient | null;
  /** Built client (client/dist) to serve from the same origin as the API. */
  staticDir?: string;
}

export function createApp(config: AppConfig, options: AppOptions = {}) {
  const productSearch =
    options.productSearch ??
    createProductSearchService({
      client: config.CHANNEL3_API_KEY ? createChannel3Client(config.CHANNEL3_API_KEY) : null,
      dailyLimitPerUser: config.CHANNEL3_DAILY_SEARCH_LIMIT ?? 50,
    });

  const llm =
    options.llm !== undefined
      ? options.llm
      : config.GEMINI_API_KEY
        ? createGeminiClient(config.GEMINI_API_KEY, config.GEMINI_MODEL ?? "gemini-2.5-flash")
        : null;
  const requests = createRequestService(productSearch);
  const agent = createProcurementAgent({
    llm,
    productSearch,
    requests,
    dailyLimitPerUser: config.AI_DAILY_GENERATION_LIMIT ?? 20,
  });

  const paypal =
    options.paypal !== undefined
      ? options.paypal
      : config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET
        ? createPayPalClient(config.PAYPAL_CLIENT_ID, config.PAYPAL_CLIENT_SECRET)
        : null;
  const payments = createPaymentService({ paypal, clientOrigin: config.CLIENT_ORIGIN });

  const app = express();
  app.disable("x-powered-by");
  // Render sits behind one proxy; needed so rate limits see the real client IP.
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        // Product thumbnails come from retailer CDNs.
        directives: { "img-src": ["'self'", "data:", "https:"] },
      },
    }),
  );
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use("/api/health", healthRouter);
  // The client ID is public by design; the PayPal JS SDK needs it in the browser
  app.use("/api/auth", createAuthRouter(config, options.authRateLimits));
  app.use("/api/products", createProductsRouter(config.JWT_SECRET, productSearch));
  app.use("/api/requests", createRequestsRouter(config.JWT_SECRET, requests, agent));
  app.use("/api", createPaymentsRouter(config.JWT_SECRET, payments));

  if (options.staticDir) {
    const staticDir = options.staticDir;
    // Vite fingerprints everything under /assets, so it can be cached forever.
    app.use("/assets", express.static(path.join(staticDir, "assets"), { immutable: true, maxAge: "1y" }));
    app.use(express.static(staticDir, { index: false }));
    // SPA fallback: client-side routes like /requests/:id load index.html.
    app.use((req, res, next) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api")) return next();
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
