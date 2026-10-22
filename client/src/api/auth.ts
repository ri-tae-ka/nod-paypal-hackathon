import type { User } from "../types/api";
import { ApiError, api } from "./http";

export async function fetchMe(): Promise<User | null> {
  try {
    return (await api<{ user: User }>("/auth/me")).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const login = (body: { email: string; password: string }) =>
  api<{ user: User }>("/auth/login", { body }).then((r) => r.user);

export const register = (body: { email: string; password: string; displayName: string }) =>
  api<{ user: User }>("/auth/register", { body }).then((r) => r.user);

export const logout = () => api<void>("/auth/logout", { method: "POST" });
