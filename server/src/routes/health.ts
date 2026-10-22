import { Router } from "express";
import { isDbReady } from "../config/db.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  const database = isDbReady() ? "connected" : "disconnected";
  res.status(database === "connected" ? 200 : 503).json({
    status: database === "connected" ? "ok" : "degraded",
    database,
    uptimeSeconds: Math.round(process.uptime()),
  });
});
