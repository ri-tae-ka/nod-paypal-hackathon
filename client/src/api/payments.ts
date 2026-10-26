import type { Payment, ProcurementRequest, Version } from "../types/api";
import { api } from "./http";

export const approveVersion = (id: string, n: number, expectedRevision: number) =>
  api<{ finalized?: boolean; request: ProcurementRequest; version: Version }>(`/requests/${id}/versions/${n}/approve`, { body: { expectedRevision } });

export const unapprove = (id: string) =>
  api<{ request: ProcurementRequest }>(`/requests/${id}/unapprove`, { method: "POST" });

export const checkout = (id: string) =>
  api<{ payment: Payment }>(`/requests/${id}/checkout`, { method: "POST" }).then((r) => r.payment);

export const capturePayment = (orderId: string) =>
  api<{ payment: Payment }>(`/payments/${encodeURIComponent(orderId)}/capture`, { method: "POST" }).then((r) => r.payment);

export const listPayments = (id: string) =>
  api<{ payments: Payment[] }>(`/requests/${id}/payments`).then((r) => r.payments);

export const withdrawNod = (id: string, n: number) =>
  api<void>(`/requests/${id}/versions/${n}/nod`, { method: "DELETE" });

export const setShares = (id: string, shares: { userId: string; amountCents: number }[]) =>
  api<unknown>(`/requests/${id}/shares`, { method: "PUT", body: { shares } });

export const cancelGroupPayment = (id: string) =>
  api<{ refunded: number }>(`/requests/${id}/cancel-payment`, { method: "POST" });
