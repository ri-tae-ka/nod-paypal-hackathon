import { randomBytes, randomUUID } from "node:crypto";
import { type HydratedDocument, isValidObjectId } from "mongoose";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { Contribution, type ContributionDoc } from "../models/Contribution.js";
import { Payment } from "../models/Payment.js";
import { Pool, type PoolDoc } from "../models/Pool.js";
import { ProcurementRequest } from "../models/ProcurementRequest.js";
import { User } from "../models/User.js";
import { Version } from "../models/Version.js";
import { type JsonSchema, type LlmClient, LlmOutputError } from "./ai/llm.js";
import {
  type CreateOrderBody,
  type PayPalClient,
  type PayPalOrder,
  PayPalApiError,
  centsToValue,
  valueToCents,
} from "./paypal/client.js";

type PoolDocument = HydratedDocument<PoolDoc>;
type ContributionDocument = HydratedDocument<ContributionDoc>;

export const MIN_CONTRIBUTION_CENTS = 100;
export const MAX_POOL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const notFound = (what: string) => new HttpError(404, `${what} not found.`, "not_found");
const notConfigured = () =>
  new HttpError(503, "Payments are not configured on this server yet.", "payments_not_configured");
const poolClosed = () => new HttpError(409, "This pool is no longer accepting contributions.", "pool_closed");

const LIVE = ["open", "closing"] as const;
const COUNTED = ["capturing", "pending", "completed"] as const;

interface SheetItem {
  title: string;
  brand?: string;
  category?: string;
  unitPriceCents: number;
  quantity: number;
  rationale?: string;
}

const pitchSchema = z.object({ pitch: z.string().min(20).max(600) });
const pitchResponseSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pitch"],
  properties: {
    pitch: { type: "string", description: "2-3 short sentences, plain language, no markdown, no emojis." },
  },
};
const PITCH_SYSTEM = `You write the short pitch shown at the top of a community fundraising page.
Neighbours, classmates or donors read it before chipping in toward a list of items.
Write 2-3 short, warm, concrete sentences: what the money buys and who it helps.
Use only facts from the request, the organiser's story and the item list. Never invent numbers, places or people.
Plain text only: no markdown, no hashtags, no emojis. Write at about a 7th-grade reading level so it is easy to translate and read aloud.`;

function fallbackPitch(title: string, items: SheetItem[], goalCents: number, story?: string) {
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const lead = story ? story.slice(0, 500).trim().replace(/([^.!?])$/, "$1.") : `${title}.`;
  return `${lead} Every contribution goes toward ${count} item${count === 1 ? "" : "s"} on this list, $${centsToValue(goalCents)} in total. If the goal isn't reached, everyone is refunded.`;
}

/** Contributions are shown by first name or "Anonymous"; payer details never leave the server. */
function presentContribution(contribution: ContributionDocument) {
  return {
    id: String(contribution._id),
    name: contribution.anonymous || !contribution.name ? "Anonymous" : contribution.name,
    message: contribution.message ?? null,
    amountCents: contribution.amountCents,
    status: contribution.status,
    capturedAt: contribution.capturedAt ?? null,
    createdAt: contribution.createdAt,
  };
}

async function totals(poolId: unknown) {
  const rows = await Contribution.aggregate<{ _id: string; cents: number; count: number }>([
    { $match: { poolId, status: { $in: [...COUNTED] } } },
    { $group: { _id: "$status", cents: { $sum: "$amountCents" }, count: { $sum: 1 } } },
  ]);
  const by = (status: string) => rows.find((row) => row._id === status) ?? { cents: 0, count: 0 };
  const completed = by("completed");
  return {
    raisedCents: completed.cents,
    contributorCount: completed.count,
    // Includes in-flight captures, so new pledges can't push far past the goal
    committedCents: rows.reduce((sum, row) => sum + row.cents, 0),
  };
}

async function presentPool(pool: PoolDocument) {
  const { raisedCents, contributorCount } = await totals(pool._id);
  return {
    id: String(pool._id),
    requestId: String(pool.requestId),
    token: pool.token,
    title: pool.title,
    story: pool.story ?? null,
    pitch: pool.pitch ?? null,
    pitchByAi: pool.pitchByAi ?? false,
    organizer: pool.organizer,
    versionNumber: pool.versionNumber,
    goalCents: pool.goalCents,
    raisedCents,
    remainingCents: Math.max(0, pool.goalCents - raisedCents),
    contributorCount,
    deadline: pool.deadline ?? null,
    status: pool.status,
    fundedAt: pool.fundedAt ?? null,
    closedAt: pool.closedAt ?? null,
    createdAt: pool.createdAt,
  };
}

export type PresentedPool = Awaited<ReturnType<typeof presentPool>>;

/** Latest pool of a request (any status), for the owner's request page. */
export async function poolSummaryFor(requestId: unknown) {
  const pool = await Pool.findOne({ requestId }).sort({ createdAt: -1 });
  return pool ? presentPool(pool) : null;
}

function approveLink(order: PayPalOrder): string | undefined {
  return order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
}

export interface OpenPoolInput {
  story?: string;
  /** Name shown as the organiser; defaults to the owner's display name. */
  organizer?: string;
  deadline?: Date;
}

export interface ContributeInput {
  amountCents: number;
  name?: string;
  anonymous?: boolean;
  message?: string;
}

export interface PoolServiceOptions {
  paypal: PayPalClient | null;
  llm: LlmClient | null;
  clientOrigin: string;
  now?: () => number;
}

export function createPoolService({ paypal, llm, clientOrigin, now = Date.now }: PoolServiceOptions) {
  async function findOwnedRequest(userId: string, requestId: string) {
    if (!isValidObjectId(requestId)) throw notFound("Request");
    const request = await ProcurementRequest.findOne({ _id: requestId, userId });
    if (!request) throw notFound("Request");
    return request;
  }

  async function findPool(token: string) {
    const pool = await Pool.findOne({ token });
    if (!pool) throw notFound("Pool");
    return pool;
  }

  async function writePitch(input: { prompt: string; title: string; story?: string; items: SheetItem[]; goalCents: number }) {
    const fallback = fallbackPitch(input.title, input.items, input.goalCents, input.story);
    if (!llm) return { pitch: fallback, byAi: false };
    const context = {
      request: input.prompt,
      organiserStory: input.story ?? null,
      goal: `$${centsToValue(input.goalCents)}`,
      items: input.items.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        unitPrice: `$${centsToValue(item.unitPriceCents)}`,
        ...(item.rationale && { why: item.rationale }),
      })),
    };
    try {
      const { pitch } = await llm.generateJson({
        schemaName: "pool_pitch",
        system: PITCH_SYSTEM,
        user: `Write the pitch for this pool.\n${JSON.stringify(context, null, 2)}`,
        responseSchema: pitchResponseSchema,
        parse: pitchSchema,
        temperature: 0.6,
      });
      return { pitch: pitch.trim(), byAi: true };
    } catch (error) {
      // A pitch is nice to have; a model outage must not block opening the pool
      if (!(error instanceof LlmOutputError)) console.warn("Pool pitch generation failed, using the organiser's story instead:", error instanceof Error ? error.message : error);
      return { pitch: fallback, byAi: false };
    }
  }

  /**
   * Closes an open pool all-or-nothing: cancels unpaid orders, refunds every captured contribution,
   * then returns the request to draft so the owner can change course.
   */
  async function close(pool: PoolDocument, finalStatus: "cancelled" | "expired") {
    if (!paypal) throw notConfigured();
    const claimed = await Pool.findOneAndUpdate({ _id: pool._id, status: "open" }, { $set: { status: "closing" } }, { new: true });
    if (!claimed) throw new HttpError(409, "This pool is no longer open.", "pool_closed");
    const reopen = () => Pool.updateOne({ _id: pool._id, status: "closing" }, { $set: { status: "open" } });

    if (await Contribution.exists({ poolId: pool._id, status: { $in: ["capturing", "pending"] } })) {
      await reopen();
      throw new HttpError(409, "A contribution is still being processed. Try again in a moment.", "payment_in_progress");
    }
    await Contribution.updateMany({ poolId: pool._id, status: "created" }, { $set: { status: "cancelled" } });

    const completed = await Contribution.find({ poolId: pool._id, status: "completed" });
    const failures: { contributionId: string; reason: string }[] = [];
    for (const contribution of completed) {
      try {
        const refund = await paypal.refundCapture(contribution.paypalCaptureId!, `refund-${String(contribution._id)}`);
        await Contribution.updateOne(
          { _id: contribution._id },
          { $set: { status: "refunded", refundId: refund.id, refundedAt: new Date() } },
        );
      } catch (error) {
        failures.push({ contributionId: String(contribution._id), reason: error instanceof Error ? error.message : "refund failed" });
      }
    }
    if (failures.length) {
      // Refunded contributions stay refunded; a retry only touches the ones that failed
      await reopen();
      throw new HttpError(502, "Some refunds failed. The pool is still open; try again.", "refund_failed", { failures });
    }

    const closed = await Pool.findOneAndUpdate(
      { _id: pool._id, status: "closing" },
      { $set: { status: finalStatus, closedAt: new Date() }, $unset: { active: 1 } },
      { new: true },
    );
    const request = await ProcurementRequest.findOneAndUpdate(
      { _id: pool.requestId, status: "approved", approvedVersion: pool.versionNumber },
      { $set: { status: "draft", shares: [] }, $unset: { approvedVersion: 1 } },
    );
    if (request) {
      await Version.updateOne({ _id: pool.versionId }, { $unset: { approval: 1 }, $set: { nods: [] } });
    }
    return { pool: await presentPool(closed!), refunded: completed.length };
  }

  /** Marks the pool funded (and the request paid) once captured contributions reach the goal. */
  async function settleIfFunded(pool: PoolDocument) {
    const { raisedCents } = await totals(pool._id);
    if (raisedCents < pool.goalCents) return;
    const funded = await Pool.findOneAndUpdate(
      { _id: pool._id, status: "open" },
      { $set: { status: "funded", fundedAt: new Date() } },
    );
    if (funded) {
      await ProcurementRequest.updateOne({ _id: pool.requestId, status: "approved" }, { $set: { status: "paid" } });
    }
  }

  async function releaseCapture(contribution: ContributionDocument) {
    await Contribution.updateOne({ _id: contribution._id, status: "capturing" }, { $set: { status: "created" } });
  }

  return {
    /** Owner turns an approved solo request into a public pool for its exact approved version. */
    async openPool(userId: string, requestId: string, input: OpenPoolInput) {
      if (!paypal) throw notConfigured();
      const request = await findOwnedRequest(userId, requestId);
      if (request.status === "paid") throw new HttpError(409, "This request has already been paid.", "already_paid");
      if (request.status !== "approved") {
        throw new HttpError(409, "Approve a version before opening a pool.", "not_approved");
      }
      if (request.members.length > 0) {
        throw new HttpError(409, "Group requests are paid in shares, so they can't be pooled.", "group_request");
      }
      if (await Pool.exists({ requestId: request._id, active: true })) {
        throw new HttpError(409, "This request already has a pool.", "pool_exists");
      }
      if (input.deadline) {
        const ms = input.deadline.getTime() - now();
        if (ms < 60 * 60 * 1000 || ms > MAX_POOL_DAYS * DAY_MS) {
          throw new HttpError(400, `The deadline must be between 1 hour and ${MAX_POOL_DAYS} days away.`, "invalid_deadline");
        }
      }

      const version = await Version.findOne({ requestId: request._id, number: request.approvedVersion });
      const approval = version?.approval;
      if (!version || !approval?.approvedAt || approval.approvedRevision !== version.revision || approval.approvedTotalCents !== version.totalCents) {
        throw new HttpError(409, "The approved sheet changed. Unapprove and approve it again.", "approval_invalid");
      }

      // The owner chose to crowdfund instead of paying, so an unpaid checkout is cancelled
      await Payment.updateMany({ requestId: request._id, status: "created" }, { $set: { status: "cancelled" } });
      if (await Payment.exists({ requestId: request._id, status: { $in: ["capturing", "pending", "completed"] } })) {
        throw new HttpError(409, "A payment is already in progress for this request.", "payment_in_progress");
      }

      const owner = await User.findById(userId);
      const title = (request.summary || request.prompt).slice(0, 120);
      const items = version.toObject().items as SheetItem[];
      const { pitch, byAi } = await writePitch({
        prompt: request.prompt,
        title,
        ...(input.story && { story: input.story }),
        items,
        goalCents: version.totalCents,
      });

      try {
        const pool = await Pool.create({
          requestId: request._id,
          ownerId: userId,
          versionId: version._id,
          versionNumber: version.number,
          approvedRevision: version.revision,
          goalCents: version.totalCents,
          token: randomBytes(12).toString("base64url"),
          title,
          ...(input.story && { story: input.story }),
          pitch,
          pitchByAi: byAi,
          organizer: (input.organizer || owner?.displayName || "organiser").slice(0, 60),
          ...(input.deadline && { deadline: input.deadline }),
          active: true,
        });
        return presentPool(pool);
      } catch (error) {
        if ((error as { code?: unknown }).code === 11000) {
          throw new HttpError(409, "This request already has a pool.", "pool_exists");
        }
        throw error;
      }
    },

    async cancelPool(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      const pool = await Pool.findOne({ requestId: request._id, status: { $in: [...LIVE] } });
      if (!pool) throw new HttpError(409, "There is no open pool on this request.", "pool_closed");
      return close(pool, "cancelled");
    },

    /** Public page data: the pool, the approved sheet and recent supporters. */
    async publicView(token: string) {
      const pool = await findPool(token);
      const [version, supporters] = await Promise.all([
        Version.findById(pool.versionId),
        Contribution.find({ poolId: pool._id, status: { $in: ["completed", "refunded"] } }).sort({ createdAt: -1 }).limit(50),
      ]);
      const items = ((version?.toObject().items ?? []) as (SheetItem & { _id: unknown; channel3ProductId: string; imageUrl?: string; retailerDomain: string; buyUrl: string; availability: string })[]).map(
        ({ _id, ...item }) => ({ id: String(_id), ...item, lineTotalCents: item.unitPriceCents * item.quantity }),
      );
      return {
        pool: await presentPool(pool),
        items,
        supporters: supporters.map(presentContribution),
        minContributionCents: MIN_CONTRIBUTION_CENTS,
        sandbox: true,
      };
    },

    /** A guest pledges an amount; returns the PayPal approval link. */
    async contribute(token: string, input: ContributeInput) {
      if (!paypal) throw notConfigured();
      const pool = await findPool(token);
      if (pool.status !== "open") throw poolClosed();
      if (pool.deadline && pool.deadline.getTime() <= now()) throw poolClosed();

      const { committedCents } = await totals(pool._id);
      const remaining = pool.goalCents - committedCents;
      if (remaining <= 0) throw new HttpError(409, "This pool is fully pledged. Thank you!", "pool_full");
      const minimum = Math.min(MIN_CONTRIBUTION_CENTS, remaining);
      if (input.amountCents < minimum || input.amountCents > remaining) {
        throw new HttpError(400, `Choose an amount between $${centsToValue(minimum)} and $${centsToValue(remaining)}.`, "invalid_amount", {
          minCents: minimum,
          maxCents: remaining,
        });
      }

      const amount = { currency_code: "USD" as const, value: centsToValue(input.amountCents) };
      const poolUrl = `${clientOrigin}/pool/${pool.token}`;
      const body: CreateOrderBody = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: String(pool._id),
            custom_id: String(pool.requestId),
            description: `Contribution to a Nod community pool (sandbox)`,
            amount: { ...amount, breakdown: { item_total: amount } },
            items: [
              {
                name: `Contribution: ${pool.title}`.slice(0, 127),
                sku: `pool-${String(pool._id)}`,
                quantity: "1",
                unit_amount: amount,
                category: "PHYSICAL_GOODS",
              },
            ],
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Nod",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: `${poolUrl}/return`,
              cancel_url: `${poolUrl}?cancelled=1`,
            },
          },
        },
      };

      let order: PayPalOrder;
      try {
        // Guests have no account, so each pledge is its own order
        order = await paypal.createOrder(body, `pool-${String(pool._id)}-${randomUUID()}`);
      } catch (error) {
        if (error instanceof PayPalApiError) {
          throw new HttpError(502, "PayPal rejected the order.", "paypal_rejected", { issues: error.issues, debugId: error.debugId });
        }
        throw error;
      }

      const contribution = await Contribution.create({
        poolId: pool._id,
        ...(input.name && { name: input.name }),
        anonymous: input.anonymous ?? false,
        ...(input.message && { message: input.message }),
        amountCents: input.amountCents,
        paypalOrderId: order.id,
        approveUrl: approveLink(order),
      });
      return { contributionId: String(contribution._id), orderId: order.id, approveUrl: contribution.approveUrl ?? null };
    },

    /** Captures a guest's approved order. Safe to retry. */
    async capture(token: string, orderId: string) {
      if (!paypal) throw notConfigured();
      const pool = await findPool(token);
      const contribution = await Contribution.findOne({ paypalOrderId: orderId, poolId: pool._id });
      if (!contribution) throw notFound("Contribution");

      const result = async () => ({ contribution: presentContribution((await Contribution.findById(contribution._id))!), pool: await presentPool((await Pool.findById(pool._id))!) });

      switch (contribution.status) {
        case "completed":
        case "pending":
        case "refunded":
          return result();
        case "cancelled":
          throw poolClosed();
        case "failed":
          throw new HttpError(409, "This payment failed. Try contributing again.", "payment_failed");
        case "capturing":
          throw new HttpError(409, "This payment is already being captured.", "capture_in_progress");
      }

      const claimed = await Contribution.findOneAndUpdate(
        { _id: contribution._id, status: "created" },
        { $set: { status: "capturing" } },
        { new: true },
      );
      if (!claimed) throw new HttpError(409, "This payment is already being captured.", "capture_in_progress");

      // Checked after claiming, so a concurrent close either sees this capture or this sees the close
      const current = await Pool.findById(pool._id);
      if (current?.status !== "open" || (current.deadline && current.deadline.getTime() <= now())) {
        await Contribution.updateOne({ _id: claimed._id, status: "capturing" }, { $set: { status: "cancelled" } });
        throw poolClosed();
      }

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
              throw new HttpError(409, "This order hasn't been approved on PayPal yet.", "order_not_approved", {
                approveUrl: claimed.approveUrl ?? null,
              });
            }
            if (error.issues.includes("INSTRUMENT_DECLINED")) {
              throw new HttpError(402, "The payment method was declined. Approve again with another method.", "payment_declined", {
                approveUrl: claimed.approveUrl ?? null,
              });
            }
            throw new HttpError(502, "PayPal could not capture this order.", "paypal_rejected", { issues: error.issues, debugId: error.debugId });
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
      if (capture.amount.currency_code !== "USD" || valueToCents(capture.amount.value) !== contribution.amountCents) {
        await Contribution.updateOne(
          { _id: contribution._id },
          {
            $set: {
              status: "failed",
              paypalCaptureId: capture.id,
              payer,
              failureReason: `Captured ${capture.amount.currency_code} ${capture.amount.value}, expected USD ${centsToValue(contribution.amountCents)}`,
            },
          },
        );
        throw new HttpError(502, "The captured amount doesn't match the pledge.", "amount_mismatch");
      }

      const status = capture.status === "COMPLETED" ? "completed" : capture.status === "PENDING" ? "pending" : "failed";
      await Contribution.updateOne(
        { _id: contribution._id },
        {
          $set: {
            status,
            paypalCaptureId: capture.id,
            payer,
            ...(status === "completed" && { capturedAt: new Date() }),
            ...(status !== "completed" && { failureReason: capture.status_details?.reason ?? capture.status }),
          },
        },
      );
      if (status === "failed") throw new HttpError(402, "PayPal declined the payment.", "payment_declined");
      if (status === "completed") await settleIfFunded(pool);
      return result();
    },

    /** Owner's view of every contribution, including unfinished ones. */
    async ownerContributions(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      const pool = await Pool.findOne({ requestId: request._id }).sort({ createdAt: -1 });
      if (!pool) return [];
      const contributions = await Contribution.find({ poolId: pool._id }).sort({ createdAt: -1 }).limit(200);
      return contributions.map(presentContribution);
    },

    /** Refunds and closes open pools whose deadline passed. Called by a timer in production. */
    async expireDue() {
      const due = await Pool.find({ status: "open", deadline: { $lte: new Date(now()) } }).limit(20);
      let expired = 0;
      for (const pool of due) {
        try {
          await close(pool, "expired");
          expired++;
        } catch (error) {
          console.warn(`Pool ${String(pool._id)} expiry deferred:`, error instanceof Error ? error.message : error);
        }
      }
      return { expired };
    },
  };
}

export type PoolService = ReturnType<typeof createPoolService>;
