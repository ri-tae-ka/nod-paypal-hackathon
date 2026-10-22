import type { CookieOptions, RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { currentUserId } from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { User } from "../models/User.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  hashPassword,
  signSession,
  verifyPassword,
} from "../services/authService.js";

export interface AuthConfig {
  JWT_SECRET: string;
  BCRYPT_ROUNDS: number;
  NODE_ENV: "development" | "test" | "production";
}

const email = z.email().max(254).transform((value) => value.trim().toLowerCase());
// bcrypt ignores anything past 72 bytes, so reject longer passwords instead of silently truncating.
const password = z
  .string()
  .min(8, "must be at least 8 characters")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "must be at most 72 bytes");

const registerBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(80),
});
const loginBody = z.object({ email, password: z.string().min(1).max(200) });

type PublicUser = { id: string; email: string; displayName: string; createdAt: Date };

function toPublicUser(user: { _id: unknown; email: string; displayName: string; createdAt: Date }): PublicUser {
  return { id: String(user._id), email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

export function createAuthController(config: AuthConfig) {
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };

  const startSession: (res: Parameters<RequestHandler>[1], userId: string) => void = (res, userId) => {
    res.cookie(SESSION_COOKIE, signSession(userId, config.JWT_SECRET), {
      ...cookieOptions,
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  };

  const register: RequestHandler = async (req, res) => {
    const body = registerBody.parse(req.body);
    const passwordHash = await hashPassword(body.password, config.BCRYPT_ROUNDS);
    try {
      const user = await User.create({ email: body.email, passwordHash, displayName: body.displayName });
      startSession(res, String(user._id));
      res.status(201).json({ user: toPublicUser(user) });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new HttpError(409, "An account with this email already exists.", "email_taken");
      }
      throw error;
    }
  };

  const login: RequestHandler = async (req, res) => {
    const body = loginBody.parse(req.body);
    const user = await User.findOne({ email: body.email }).select("+passwordHash");
    const ok = await verifyPassword(body.password, user?.passwordHash);
    if (!user || !ok) throw new HttpError(401, "Invalid email or password.", "invalid_credentials");
    startSession(res, String(user._id));
    res.json({ user: toPublicUser(user) });
  };

  const logout: RequestHandler = (_req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  };

  const me: RequestHandler = async (_req, res) => {
    const userId = currentUserId(res);
    const user = isValidObjectId(userId) ? await User.findById(userId) : null;
    if (!user) {
      res.clearCookie(SESSION_COOKIE, cookieOptions);
      throw new HttpError(401, "Please sign in.", "unauthorized");
    }
    res.json({ user: toPublicUser(user) });
  };

  return { register, login, logout, me };
}
