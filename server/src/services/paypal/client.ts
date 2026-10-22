import { HttpError } from "../../middleware/errorHandler.js";

/** Sandbox only: this project never moves real money. */
export const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 20_000;
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export interface Money {
  currency_code: "USD";
  value: string;
}

export interface OrderItem {
  name: string;
  quantity: string;
  unit_amount: Money;
  sku?: string;
  url?: string;
  category: "PHYSICAL_GOODS";
}

export interface CreateOrderBody {
  intent: "CAPTURE";
  purchase_units: {
    reference_id: string;
    custom_id: string;
    description: string;
    amount: Money & { breakdown: { item_total: Money } };
    items: OrderItem[];
  }[];
  payment_source: {
    paypal: {
      experience_context: {
        brand_name: string;
        shipping_preference: "NO_SHIPPING";
        user_action: "PAY_NOW";
        return_url: string;
        cancel_url: string;
      };
    };
  };
}

export interface PayPalCapture {
  id: string;
  status: "COMPLETED" | "PENDING" | "DECLINED" | "FAILED" | "PARTIALLY_REFUNDED" | "REFUNDED";
  amount: Money;
  status_details?: { reason?: string };
}

export interface PayPalOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  links?: { href: string; rel: string; method?: string }[];
  payer?: { email_address?: string; payer_id?: string };
  purchase_units?: { payments?: { captures?: PayPalCapture[] } }[];
}

/** A PayPal API error with the machine-readable issue codes from `details[].issue`. */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly paypalName: string,
    readonly issues: string[],
    readonly debugId: string | undefined,
  ) {
    super(`PayPal ${status} ${paypalName}${issues.length ? ` (${issues.join(", ")})` : ""}`);
  }
}

export interface PayPalClient {
  createOrder(body: CreateOrderBody, idempotencyKey: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, idempotencyKey: string): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
}

const unavailable = () => new HttpError(502, "PayPal is unavailable right now. Try again shortly.", "paypal_unavailable");

export function createPayPalClient(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): PayPalClient {
  let token: { value: string; expiresAt: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      console.error("PayPal request failed:", error instanceof Error ? error.message : error, cause?.code ?? "");
      throw unavailable();
    }
  }

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const response = await send(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      console.error(`PayPal token request responded ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
      throw response.status === 401
        ? new HttpError(502, "PayPal is misconfigured.", "paypal_unavailable")
        : unavailable();
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS };
    return token.value;
  }

  async function call(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<PayPalOrder> {
    const attempt = async () =>
      send(`${PAYPAL_BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
          prefer: "return=representation",
          ...(idempotencyKey && { "paypal-request-id": idempotencyKey }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });

    let response = await attempt();
    if (response.status === 401) {
      // Token revoked or expired early: refresh once.
      token = null;
      response = await attempt();
    }
    if (response.ok) return (await response.json()) as PayPalOrder;

    const text = await response.text().catch(() => "");
    let parsed: { name?: string; details?: { issue?: string }[]; debug_id?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON error body (e.g. a proxy page)
    }
    const error = new PayPalApiError(
      response.status,
      parsed.name ?? "UNKNOWN_ERROR",
      (parsed.details ?? []).map((d) => d.issue).filter((i): i is string => typeof i === "string"),
      parsed.debug_id,
    );
    console.error(`${method} ${path} -> ${error.message} debug_id=${error.debugId ?? "-"}`);
    throw error;
  }

  return {
    createOrder: (body, idempotencyKey) => call("POST", "/v2/checkout/orders", body, idempotencyKey),
    captureOrder: (orderId, idempotencyKey) =>
      call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, idempotencyKey),
    getOrder: (orderId) => call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`),
  };
}

export function centsToValue(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Parses PayPal's decimal string ("12.3", "12.30", "12") into integer cents; null if malformed. */
export function valueToCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
}
