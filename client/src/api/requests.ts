import type { GenerateResult, ProcurementRequest, RequestDetail, SearchResult, Version, VersionDiff, VersionSummary } from "../types/api";
import { api } from "./http";

export const listRequests = () => api<{ requests: ProcurementRequest[] }>("/requests").then((r) => r.requests);

export const createRequest = (body: { prompt: string; budgetCents?: number }) =>
  api<{ request: ProcurementRequest }>("/requests", { body }).then((r) => r.request);

export const getRequest = (id: string) => api<RequestDetail>(`/requests/${id}`);

export const deleteRequest = (id: string) => api<void>(`/requests/${id}`, { method: "DELETE" });

export interface ItemInput {
  channel3ProductId: string;
  quantity: number;
  rationale?: string;
}

export const createVersion = (id: string, body: { items: ItemInput[]; summary?: string; basedOnVersion?: number }) =>
  api<{ version: Version }>(`/requests/${id}/versions`, { body }).then((r) => r.version);

export const addItem = (id: string, n: number, body: ItemInput & { expectedRevision: number }) =>
  api<{ version: Version }>(`/requests/${id}/versions/${n}/items`, { body }).then((r) => r.version);

export const updateItemQuantity = (id: string, n: number, itemId: string, quantity: number, expectedRevision: number) =>
  api<{ version: Version }>(`/requests/${id}/versions/${n}/items/${itemId}`, {
    method: "PATCH",
    body: { quantity, expectedRevision },
  }).then((r) => r.version);

export const removeItem = (id: string, n: number, itemId: string, expectedRevision: number) =>
  api<{ version: Version }>(`/requests/${id}/versions/${n}/items/${itemId}?expectedRevision=${expectedRevision}`, {
    method: "DELETE",
  }).then((r) => r.version);

export const searchProducts = (body: { query: string; maxPriceCents?: number; limit?: number }) =>
  api<SearchResult>("/products/search", { body });

export const listVersions = (id: string) =>
  api<{ versions: VersionSummary[] }>(`/requests/${id}/versions`).then((r) => r.versions);

export const getVersion = (id: string, n: number) =>
  api<{ version: Version }>(`/requests/${id}/versions/${n}`).then((r) => r.version);

export const diffVersions = (id: string, n: number, against: number) =>
  api<{ diff: VersionDiff }>(`/requests/${id}/versions/${n}/diff?against=${against}`).then((r) => r.diff);

export const copyVersion = (id: string, n: number, body: { summary?: string; expectedLatestVersion: number }) =>
  api<{ version: Version }>(`/requests/${id}/versions/${n}/copy`, { body }).then((r) => r.version);

export const generateVersion = (id: string, body: { instruction?: string; expectedLatestVersion: number }) =>
  api<GenerateResult>(`/requests/${id}/generate`, { body });
