export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export type RequestStatus = "draft" | "approved" | "paid";

export interface ProcurementRequest {
  id: string;
  prompt: string;
  summary: string | null;
  budgetCents: number | null;
  status: RequestStatus;
  latestVersion: number;
  approvedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface ProductCandidate {
  channel3ProductId: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  category: string | null;
  materials: string[];
  keyFeatures: string[];
  rating: { value: number; count: number } | null;
  retailerDomain: string;
  buyUrl: string;
  availability: "InStock" | "OutOfStock";
  currency: "USD";
  unitPriceCents: number;
  compareAtPriceCents: number | null;
  offerCount: number;
}

export interface SearchResult {
  products: ProductCandidate[];
  cached: boolean;
  searchesRemainingToday: number;
}

export interface VersionItem {
  id: string;
  channel3ProductId: string;
  title: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  rating?: { value: number; count: number };
  retailerDomain: string;
  buyUrl: string;
  availability: "InStock" | "OutOfStock";
  unitPriceCents: number;
  compareAtPriceCents?: number;
  quantity: number;
  rationale?: string;
  lineTotalCents: number;
}

export interface Version {
  id: string;
  number: number;
  basedOnVersion: number | null;
  instruction: string | null;
  summary: string | null;
  revision: number;
  items: VersionItem[];
  totalCents: number;
  budget: { budgetCents: number | null; remainingCents: number | null; overBudget: boolean };
  approval: { approvedAt: string; approvedRevision: number; approvedTotalCents: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestDetail {
  request: ProcurementRequest;
  latestVersion: Version | null;
}

export interface VersionSummary {
  number: number;
  basedOnVersion: number | null;
  summary: string | null;
  instruction: string | null;
  itemCount: number;
  totalCents: number;
  revision: number;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DiffLine {
  channel3ProductId: string;
  title: string;
  retailerDomain: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface VersionDiff {
  from: { number: number; totalCents: number };
  to: { number: number; totalCents: number };
  totalDeltaCents: number;
  added: DiffLine[];
  removed: DiffLine[];
  changed: (DiffLine & { before: DiffLine })[];
  unchangedCount: number;
}

export interface UnmetNeed {
  key: string;
  description: string;
  reason: "no_results" | "not_selected";
}

export interface GenerateResult {
  version: Version;
  diff: VersionDiff | null;
  agent: { model: string; searches: number; unmet: UnmetNeed[] };
}

export type PaymentStatus = "created" | "capturing" | "completed" | "pending" | "failed" | "cancelled";

export interface Payment {
  id: string;
  requestId: string;
  versionNumber: number;
  approvedRevision: number;
  paypalOrderId: string;
  paypalCaptureId: string | null;
  approveUrl: string | null;
  amountCents: number;
  currency: "USD";
  status: PaymentStatus;
  payer: { email?: string; payerId?: string } | null;
  capturedAt: string | null;
  failureReason: string | null;
  sandbox: true;
  createdAt: string;
  updatedAt: string;
}

