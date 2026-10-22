import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "pd_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Compared against when the email is unknown, so login takes the same time either way.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export function verifyPassword(password: string, hash: string | undefined): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH).then((ok) => ok && hash !== undefined);
}

export function signSession(userId: string, secret: string): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: SESSION_TTL_SECONDS, algorithm: "HS256" });
}

/** Returns the user id, or null if the token is missing, invalid or expired. */
export function verifySession(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    return typeof payload === "object" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
