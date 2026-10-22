import type { RequestHandler, Response } from "express";
import { SESSION_COOKIE, verifySession } from "../services/authService.js";
import { HttpError } from "./errorHandler.js";

export function requireAuth(jwtSecret: string): RequestHandler {
  return (req, res, next) => {
    const userId = verifySession(req.cookies?.[SESSION_COOKIE], jwtSecret);
    if (!userId) return next(new HttpError(401, "Please sign in.", "unauthorized"));
    res.locals.userId = userId;
    next();
  };
}

/** Use only in handlers mounted behind requireAuth. */
export function currentUserId(res: Response): string {
  const userId = res.locals.userId;
  if (typeof userId !== "string") throw new HttpError(401, "Please sign in.", "unauthorized");
  return userId;
}
