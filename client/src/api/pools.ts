import type { Contribution, Pool, PoolView } from "../types/api";
import { api } from "./http";

export const openPool = (id: string, body: { story?: string; organizer?: string; deadline?: string }) =>
  api<{ pool: Pool }>(`/requests/${id}/pool`, { body }).then((r) => r.pool);

export const cancelPool = (id: string) =>
  api<{ pool: Pool; refunded: number }>(`/requests/${id}/pool/cancel`, { method: "POST" });

export const ownerContributions = (id: string) =>
  api<{ contributions: Contribution[] }>(`/requests/${id}/pool/contributions`).then((r) => r.contributions);

export const getPool = (token: string) => api<PoolView>(`/pools/${encodeURIComponent(token)}`);

export const contribute = (token: string, body: { amountCents: number; name?: string; anonymous?: boolean; message?: string }) =>
  api<{ contributionId: string; orderId: string; approveUrl: string | null }>(`/pools/${encodeURIComponent(token)}/contribute`, { body });

export const captureContribution = (token: string, orderId: string) =>
  api<{ contribution: Contribution; pool: Pool }>(
    `/pools/${encodeURIComponent(token)}/contributions/${encodeURIComponent(orderId)}/capture`,
    { method: "POST" },
  );
