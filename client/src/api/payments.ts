import type { Payment, ProcurementRequest, Version } from "../types/api";
import { api } from "./http";

export const approveVersion = (id: string, n: number, expectedRevision: number) =>
  api<{ request: ProcurementRequest; version: Version }>(`/requests/${id}/versions/${n}/approve`, { body: { expectedRevision } });

export const unapprove = (id: string) =>
  api<{ request: ProcurementRequest }>(`/requests/${id}/unapprove`, { method: "POST" });

export const checkout = (id: string) =>
  api<{ payment: Payment }>(`/requests/${id}/checkout`, { method: "POST" }).then((r) => r.payment);

export const capturePayment = (orderId: string) =>
  api<{ payment: Payment }>(`/payments/${encodeURIComponent(orderId)}/capture`, { method: "POST" }).then((r) => r.payment);

export const listPayments = (id: string) =>
  api<{ payments: Payment[] }>(`/requests/${id}/payments`).then((r) => r.payments);
