import { type HydratedDocument, isValidObjectId } from "mongoose";
import { HttpError } from "../middleware/errorHandler.js";
import { Payment, type PaymentDoc } from "../models/Payment.js";
import { ProcurementRequest } from "../models/ProcurementRequest.js";
import { Version } from "../models/Version.js";
import {
  type CreateOrderBody,
  type PayPalClient,
  type PayPalOrder,
  PayPalApiError,
  centsToValue,
  valueToCents,
} from "./paypal/client.js";

type PaymentDocument = HydratedDocument<PaymentDoc>;

const BRAND_NAME = "Nod";

function presentPayment(payment: PaymentDocument) {
  return {
    id: String(payment._id),
    requestId: String(payment.requestId),
    versionNumber: payment.versionNumber,
    approvedRevision: payment.approvedRevision,
    paypalOrderId: payment.paypalOrderId,
    paypalCaptureId: payment.paypalCaptureId ?? null,
    approveUrl: payment.status === "created" ? (payment.approveUrl ?? null) : null,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    payer: payment.payer?.email || payment.payer?.payerId ? payment.payer : null,
    capturedAt: payment.capturedAt ?? null,
    failureReason: payment.failureReason ?? null,
    sandbox: true,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

export type PresentedPayment = ReturnType<typeof presentPayment>;

const notFound = (what: string) => new HttpError(404, `${what} not found.`, "not_found");
const notConfigured = () =>
  new HttpError(503, "Payments are not configured on this server yet.", "payments_not_configured");

function approveLink(order: PayPalOrder): string | undefined {
  return order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
}

export interface PaymentServiceOptions {
  paypal: PayPalClient | null;
  /** Frontend origin PayPal redirects the buyer back to. */
  clientOrigin: string;
}

export function createPaymentService({ paypal, clientOrigin }: PaymentServiceOptions) {
  async function findOwnedRequest(userId: string, requestId: string) {
    if (!isValidObjectId(requestId)) throw notFound("Request");
    const request = await ProcurementRequest.findOne({ _id: requestId, userId });
    if (!request) throw notFound("Request");
    return request;
  }

  /** Loads the approved version and checks the approval still matches it exactly. */
  async function approvedVersionOf(request: Awaited<ReturnType<typeof findOwnedRequest>>) {
    const version = await Version.findOne({ requestId: request._id, number: request.approvedVersion });
    const approval = version?.approval;
    if (
      !version ||
      !approval?.approvedAt ||
      approval.approvedRevision !== version.revision ||
      approval.approvedTotalCents !== version.totalCents
    ) {
      throw new HttpError(409, "The approved sheet changed. Unapprove and approve it again.", "approval_invalid");
    }
    return { version, approvedAt: approval.approvedAt };
  }

  async function releaseCapture(payment: PaymentDocument) {
    await Payment.updateOne({ _id: payment._id, status: "capturing" }, { $set: { status: "created" } });
  }

  return {
    /** Creates (or reuses) a PayPal order for exactly the approved version. */
    async checkout(userId: string, requestId: string) {
      if (!paypal) throw notConfigured();
      const request = await findOwnedRequest(userId, requestId);
      if (request.status === "paid") throw new HttpError(409, "This request has already been paid.", "already_paid");
      if (request.status !== "approved") {
        throw new HttpError(409, "Approve a version before checking out.", "not_approved");
      }
      const { version, approvedAt } = await approvedVersionOf(request);

      const existing = await Payment.findOne({
        requestId: request._id,
        versionId: version._id,
        approvedRevision: version.revision,
        status: { $in: ["created", "capturing", "pending", "completed"] },
      }).sort({ createdAt: -1 });
      if (existing) {
        if (existing.status === "created") return presentPayment(existing);
        throw new HttpError(409, "A payment is already in progress for this request.", "payment_in_progress", {
          payment: presentPayment(existing),
        });
      }

      const items = version.toObject().items as { channel3ProductId: string; title: string; unitPriceCents: number; quantity: number }[];
      const total: { currency_code: "USD"; value: string } = { currency_code: "USD", value: centsToValue(version.totalCents) };
      const returnBase = `${clientOrigin}/requests/${String(request._id)}/checkout`;
      const body: CreateOrderBody = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: String(version._id),
            custom_id: String(request._id),
            description: `Procurement request, version ${version.number} (sandbox)`.slice(0, 127),
            amount: { ...total, breakdown: { item_total: total } },
            items: items.map((item) => ({
              name: item.title.slice(0, 127),
              sku: item.channel3ProductId.slice(0, 127),
              quantity: String(item.quantity),
              unit_amount: { currency_code: "USD", value: centsToValue(item.unitPriceCents) },
              category: "PHYSICAL_GOODS",
            })),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: BRAND_NAME,
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: `${returnBase}/return`,
              cancel_url: `${returnBase}/cancel`,
            },
          },
        },
      };

      // Same approval + attempt => same key, so concurrent checkouts get the same PayPal order.
      const attempt = await Payment.countDocuments({ versionId: version._id });
      const idempotencyKey = `order-${String(version._id)}-${approvedAt.getTime()}-${attempt}`;

      let order: PayPalOrder;
      try {
        order = await paypal.createOrder(body, idempotencyKey);
      } catch (error) {
        if (error instanceof PayPalApiError) {
          throw new HttpError(502, "PayPal rejected the order.", "paypal_rejected", { issues: error.issues, debugId: error.debugId });
        }
        throw error;
      }

      try {
        const payment = await Payment.create({
          userId,
          requestId: request._id,
          versionId: version._id,
          versionNumber: version.number,
          approvedRevision: version.revision,
          paypalOrderId: order.id,
          approveUrl: approveLink(order),
          amountCents: version.totalCents,
        });
        return presentPayment(payment);
      } catch (error) {
        if ((error as { code?: unknown }).code === 11000) {
          const payment = await Payment.findOne({ paypalOrderId: order.id });
          if (payment) return presentPayment(payment);
        }
        throw error;
      }
    },

    /** Captures a buyer-approved order. Safe to retry: completed payments are returned as-is. */
    async capture(userId: string, orderId: string) {
      if (!paypal) throw notConfigured();
      const payment = await Payment.findOne({ paypalOrderId: orderId, userId });
      if (!payment) throw notFound("Payment");

      switch (payment.status) {
        case "completed":
        case "pending":
          return presentPayment(payment);
        case "cancelled":
          throw new HttpError(409, "This order was cancelled. Start checkout again.", "order_cancelled");
        case "failed":
          throw new HttpError(409, "This payment failed. Start checkout again.", "payment_failed");
        case "capturing":
          throw new HttpError(409, "This payment is already being captured.", "capture_in_progress");
      }

      const request = await ProcurementRequest.findById(payment.requestId);
      const approval = request?.status === "approved" && request.approvedVersion === payment.versionNumber
        ? (await Version.findById(payment.versionId))?.approval
        : null;
      if (!approval?.approvedAt || approval.approvedRevision !== payment.approvedRevision) {
        await Payment.updateOne({ _id: payment._id, status: "created" }, { $set: { status: "cancelled" } });
        throw new HttpError(409, "The approval changed since checkout started. Start checkout again.", "approval_changed");
      }

      const claimed = await Payment.findOneAndUpdate({ _id: payment._id, status: "created" }, { $set: { status: "capturing" } }, { new: true });
      if (!claimed) throw new HttpError(409, "This payment is already being captured.", "capture_in_progress");

      let order: PayPalOrder;
      try {
        order = await paypal.captureOrder(orderId, `capture-${orderId}`);
      } catch (error) {
        if (error instanceof PayPalApiError && error.issues.includes("ORDER_ALREADY_CAPTURED")) {
          order = await paypal.getOrder(orderId).catch(async (e) => {
            await releaseCapture(claimed);
            throw e;
          });
        } else {
          await releaseCapture(claimed);
          if (error instanceof PayPalApiError) {
            if (error.issues.includes("ORDER_NOT_APPROVED")) {
              throw new HttpError(409, "The buyer hasn't approved this order on PayPal yet.", "order_not_approved", {
                approveUrl: claimed.approveUrl ?? null,
              });
            }
            if (error.issues.includes("INSTRUMENT_DECLINED")) {
              throw new HttpError(402, "The payment method was declined. Approve again with another method.", "payment_declined", {
                approveUrl: claimed.approveUrl ?? null,
              });
            }
            throw new HttpError(502, "PayPal could not capture this order.", "paypal_rejected", {
              issues: error.issues,
              debugId: error.debugId,
            });
          }
          throw error;
        }
      }

      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      if (!capture) {
        await releaseCapture(claimed);
        throw new HttpError(502, "PayPal returned no capture for this order.", "paypal_unavailable");
      }

      const payer = { email: order.payer?.email_address, payerId: order.payer?.payer_id };
      const capturedCents = valueToCents(capture.amount.value);
      if (capture.amount.currency_code !== "USD" || capturedCents !== payment.amountCents) {
        await Payment.updateOne(
          { _id: payment._id },
          {
            $set: {
              status: "failed",
              paypalCaptureId: capture.id,
              payer,
              failureReason: `Captured ${capture.amount.currency_code} ${capture.amount.value}, expected USD ${centsToValue(payment.amountCents)}`,
            },
          },
        );
        throw new HttpError(502, "The captured amount doesn't match the approved total.", "amount_mismatch");
      }

      const status = capture.status === "COMPLETED" ? "completed" : capture.status === "PENDING" ? "pending" : "failed";
      const updated = await Payment.findByIdAndUpdate(
        payment._id,
        {
          $set: {
            status,
            paypalCaptureId: capture.id,
            payer,
            ...(status === "completed" && { capturedAt: new Date() }),
            ...(status !== "completed" && { failureReason: capture.status_details?.reason ?? capture.status }),
          },
        },
        { new: true },
      );
      if (status === "completed") {
        await ProcurementRequest.updateOne({ _id: payment.requestId, status: "approved" }, { $set: { status: "paid" } });
      }
      if (status === "failed") {
        throw new HttpError(402, "PayPal declined the payment.", "payment_declined", { payment: presentPayment(updated!) });
      }
      return presentPayment(updated!);
    },

    async listPayments(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      const payments = await Payment.find({ requestId: request._id }).sort({ createdAt: -1 }).limit(50);
      return payments.map(presentPayment);
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
