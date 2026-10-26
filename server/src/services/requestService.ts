import { randomBytes } from "node:crypto";
import { type HydratedDocument, Types, isValidObjectId } from "mongoose";
import { HttpError } from "../middleware/errorHandler.js";
import { Payment } from "../models/Payment.js";
import { Pool, poolLocks } from "../models/Pool.js";
import { ProcurementRequest, type ProcurementRequestDoc } from "../models/ProcurementRequest.js";
import { User } from "../models/User.js";
import { Version, type VersionDoc } from "../models/Version.js";
import type { ProductCandidate } from "./channel3/mapper.js";
import { poolSummaryFor } from "./poolService.js";
import type { ProductSearchService } from "./productSearch.js";

export const MAX_ITEMS_PER_VERSION = 50;
export const MAX_GROUP_SIZE = 10;

export interface ItemInput {
  channel3ProductId: string;
  quantity: number;
  rationale?: string;
}

export interface CreateVersionInput {
  basedOnVersion?: number;
  summary?: string;
  instruction?: string;
  items: ItemInput[];
  /** If set, fail with 409 unless the request's latest version is still this number. */
  expectedLatestVersion?: number;
}

/** Line item as stored in a Version (snapshot of the product at selection time). */
interface StoredItem {
  _id: Types.ObjectId;
  channel3ProductId: string;
  title: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  materials?: string[];
  keyFeatures?: string[];
  rating?: { value: number; count: number };
  retailerDomain: string;
  buyUrl: string;
  availability: "InStock" | "OutOfStock";
  currency: "USD";
  unitPriceCents: number;
  compareAtPriceCents?: number;
  quantity: number;
  rationale?: string;
}

type RequestDocument = HydratedDocument<ProcurementRequestDoc>;
type VersionDocument = HydratedDocument<VersionDoc>;

const notFound = (what: string) => new HttpError(404, `${what} not found.`, "not_found");

function staleRevision(currentRevision: number) {
  return new HttpError(
    409,
    "This sheet changed since you loaded it. Reload and try again.",
    "stale_revision",
    { currentRevision },
  );
}

export function versionConflict(latestVersion: number) {
  return new HttpError(409, "A newer version was created meanwhile. Reload and try again.", "version_conflict", {
    latestVersion,
  });
}

function snapshot(product: ProductCandidate, quantity: number, rationale?: string): StoredItem {
  return {
    _id: new Types.ObjectId(),
    channel3ProductId: product.channel3ProductId,
    title: product.title.slice(0, 500),
    ...(product.brand && { brand: product.brand }),
    ...(product.category && { category: product.category }),
    ...(product.imageUrl && { imageUrl: product.imageUrl }),
    ...(product.materials.length && { materials: product.materials.slice(0, 10) }),
    ...(product.keyFeatures.length && { keyFeatures: product.keyFeatures.slice(0, 10) }),
    ...(product.rating && { rating: product.rating }),
    retailerDomain: product.retailerDomain,
    buyUrl: product.buyUrl,
    availability: product.availability,
    currency: "USD",
    unitPriceCents: product.unitPriceCents,
    ...(product.compareAtPriceCents !== null && { compareAtPriceCents: product.compareAtPriceCents }),
    quantity,
    ...(rationale && { rationale }),
  };
}

const lineTotal = (item: { unitPriceCents: number; quantity: number }) => item.unitPriceCents * item.quantity;
const sumTotal = (items: { unitPriceCents: number; quantity: number }[]) =>
  items.reduce((sum, item) => sum + lineTotal(item), 0);

const memberIdsOf = (request: RequestDocument) => [String(request.userId), ...request.members.map((m) => String(m.userId))];

/** Splits a total evenly; leftover cents go one each to the first members. */
export function equalShares(totalCents: number, userIds: string[]) {
  const base = Math.floor(totalCents / userIds.length);
  const extra = totalCents - base * userIds.length;
  return userIds.map((userId, i) => ({ userId, amountCents: base + (i < extra ? 1 : 0) }));
}

function presentRequest(request: RequestDocument, viewerId?: string) {
  return {
    ...(viewerId !== undefined && { role: String(request.userId) === viewerId ? "owner" : "member" }),
    memberCount: request.members.length + 1,
    id: String(request._id),
    prompt: request.prompt,
    summary: request.summary ?? null,
    budgetCents: request.budgetCents ?? null,
    status: request.status,
    latestVersion: request.latestVersion,
    approvedVersion: request.approvedVersion ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function presentVersion(version: VersionDocument, budgetCents: number | null | undefined) {
  const items = (version.toObject().items as StoredItem[]).map(({ _id, ...item }) => ({
    id: String(_id),
    ...item,
    lineTotalCents: lineTotal(item),
  }));
  const budget = budgetCents ?? null;
  return {
    id: String(version._id),
    number: version.number,
    basedOnVersion: version.basedOnVersion ?? null,
    instruction: version.instruction ?? null,
    summary: version.summary ?? null,
    revision: version.revision,
    items,
    totalCents: version.totalCents,
    budget: {
      budgetCents: budget,
      remainingCents: budget === null ? null : budget - version.totalCents,
      overBudget: budget !== null && version.totalCents > budget,
    },
    approval: version.approval?.approvedAt ? version.approval : null,
    nods: version.nods.filter((n) => n.revision === version.revision).map((n) => String(n.userId)),
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

export type PresentedVersion = ReturnType<typeof presentVersion>;

export function createRequestService(productSearch: ProductSearchService) {
  async function findOwnedRequest(userId: string, requestId: string) {
    if (!isValidObjectId(requestId)) throw notFound("Request");
    const request = await ProcurementRequest.findOne({ _id: requestId, userId });
    if (!request) throw notFound("Request");
    return request;
  }

  /** Owner or member. */
  async function findAccessibleRequest(userId: string, requestId: string) {
    if (!isValidObjectId(requestId)) throw notFound("Request");
    const request = await ProcurementRequest.findOne({
      _id: requestId,
      $or: [{ userId }, { "members.userId": userId }],
    });
    if (!request) throw notFound("Request");
    return request;
  }

  async function presentMembers(request: RequestDocument, version?: VersionDocument | null) {
    const ids = memberIdsOf(request);
    const users = await User.find({ _id: { $in: ids } });
    const names = new Map(users.map((u) => [String(u._id), u.displayName]));
    const nodded = new Set(
      version ? version.nods.filter((n) => n.revision === version.revision).map((n) => String(n.userId)) : [],
    );
    const joined = new Map(request.members.map((m) => [String(m.userId), m.joinedAt]));
    const shares = new Map(request.shares.map((s) => [String(s.userId), s.amountCents]));
    return ids.map((id) => ({
      userId: id,
      displayName: names.get(id) ?? "Unknown",
      role: id === String(request.userId) ? ("owner" as const) : ("member" as const),
      joinedAt: joined.get(id) ?? request.createdAt,
      nodded: nodded.has(id),
      shareCents: shares.get(id) ?? null,
    }));
  }

  async function findVersion(request: RequestDocument, number: number) {
    const version = await Version.findOne({ requestId: request._id, number });
    if (!version) throw notFound("Version");
    return version;
  }

  function assertEditable(request: RequestDocument, version: VersionDocument) {
    if (request.status !== "draft") {
      throw new HttpError(409, "This request is no longer a draft.", "request_locked");
    }
    if (version.number !== request.latestVersion) {
      throw new HttpError(409, "Only the latest version can be edited.", "version_locked");
    }
  }

  async function resolve(userId: string, productId: string): Promise<ProductCandidate> {
    const product = await productSearch.resolveProduct(userId, productId);
    if (!product) {
      throw new HttpError(400, `Product ${productId} could not be found or has no USD price.`, "unknown_product", {
        channel3ProductId: productId,
      });
    }
    return product;
  }

  /** Loads, checks, applies `mutate` and saves atomically, only if nobody changed the version in between. */
  async function mutateItems(
    userId: string,
    requestId: string,
    number: number,
    expectedRevision: number,
    mutate: (items: StoredItem[]) => StoredItem[] | Promise<StoredItem[]>,
  ) {
    const request = await findAccessibleRequest(userId, requestId);
    const version = await findVersion(request, number);
    assertEditable(request, version);
    if (version.revision !== expectedRevision) throw staleRevision(version.revision);

    const items = await mutate(version.toObject().items as StoredItem[]);
    const updated = await Version.findOneAndUpdate(
      { _id: version._id, revision: expectedRevision },
      { $set: { items, totalCents: sumTotal(items), nods: [] }, $inc: { revision: 1 }, $unset: { approval: 1 } },
      { new: true, runValidators: true },
    );
    if (!updated) {
      const current = await Version.findById(version._id);
      throw staleRevision(current?.revision ?? expectedRevision + 1);
    }
    return presentVersion(updated, request.budgetCents);
  }

  function findItem(items: StoredItem[], itemId: string) {
    const index = items.findIndex((item) => String(item._id) === itemId);
    if (index === -1) throw notFound("Item");
    return index;
  }

  async function insertVersion(
    userId: string,
    request: RequestDocument,
    items: StoredItem[],
    meta: { basedOnVersion?: number; summary?: string; instruction?: string },
  ) {
    const number = request.latestVersion + 1;
    let version: VersionDocument;
    try {
      version = await Version.create({
        requestId: request._id,
        userId,
        number,
        ...(meta.basedOnVersion !== undefined && { basedOnVersion: meta.basedOnVersion }),
        ...(meta.summary && { summary: meta.summary }),
        ...(meta.instruction && { instruction: meta.instruction }),
        items,
        totalCents: sumTotal(items),
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 11000) {
        throw versionConflict(number);
      }
      throw error;
    }
    await ProcurementRequest.updateOne({ _id: request._id }, { $max: { latestVersion: number } });
    return presentVersion(version, request.budgetCents);
  }

  return {
    async createRequest(userId: string, input: { prompt: string; budgetCents?: number }) {
      const request = await ProcurementRequest.create({ userId, ...input });
      return presentRequest(request, userId);
    },

    async listRequests(userId: string) {
      const requests = await ProcurementRequest.find({ $or: [{ userId }, { "members.userId": userId }] })
        .sort({ createdAt: -1 })
        .limit(100);
      const pools = await Pool.find({ requestId: { $in: requests.map((r) => r._id) }, active: true }, { requestId: 1, status: 1 });
      const poolStatus = new Map(pools.map((pool) => [String(pool.requestId), pool.status]));
      return requests.map((request) => ({ ...presentRequest(request, userId), poolStatus: poolStatus.get(String(request._id)) ?? null }));
    },

    async getRequest(userId: string, requestId: string) {
      const request = await findAccessibleRequest(userId, requestId);
      const latest =
        request.latestVersion > 0 ? await Version.findOne({ requestId: request._id, number: request.latestVersion }) : null;
      return {
        request: presentRequest(request, userId),
        latestVersion: latest ? presentVersion(latest, request.budgetCents) : null,
        members: await presentMembers(request, latest),
        inviteToken: String(request.userId) === userId ? (request.inviteToken ?? null) : null,
        pool: await poolSummaryFor(request._id),
      };
    },

    async getVersion(userId: string, requestId: string, number: number) {
      const request = await findAccessibleRequest(userId, requestId);
      return presentVersion(await findVersion(request, number), request.budgetCents);
    },

    async createVersion(userId: string, requestId: string, input: CreateVersionInput) {
      const request = await findAccessibleRequest(userId, requestId);
      if (request.status !== "draft") {
        throw new HttpError(409, "This request is no longer a draft.", "request_locked");
      }
      if (input.expectedLatestVersion !== undefined && input.expectedLatestVersion !== request.latestVersion) {
        throw versionConflict(request.latestVersion);
      }

      const basedOnVersion = input.basedOnVersion ?? (request.latestVersion > 0 ? request.latestVersion : undefined);
      if (basedOnVersion !== undefined && (basedOnVersion < 1 || basedOnVersion > request.latestVersion)) {
        throw new HttpError(400, `Version ${basedOnVersion} does not exist.`, "invalid_base_version");
      }

      const ids = input.items.map((item) => item.channel3ProductId);
      if (new Set(ids).size !== ids.length) {
        throw new HttpError(400, "Each product can only appear once in a version.", "duplicate_product");
      }

      const products = await Promise.all(ids.map((id) => resolve(userId, id)));
      const items = input.items.map((item, i) => snapshot(products[i]!, item.quantity, item.rationale));
      return insertVersion(userId, request, items, {
        basedOnVersion,
        summary: input.summary,
        instruction: input.instruction,
      });
    },

    async listVersions(userId: string, requestId: string) {
      const request = await findAccessibleRequest(userId, requestId);
      const versions = await Version.find({ requestId: request._id }).sort({ number: 1 });
      return versions.map((version) => ({
        number: version.number,
        basedOnVersion: version.basedOnVersion ?? null,
        summary: version.summary ?? null,
        instruction: version.instruction ?? null,
        itemCount: version.items.length,
        totalCents: version.totalCents,
        revision: version.revision,
        approved: Boolean(version.approval?.approvedAt),
        createdAt: version.createdAt,
        updatedAt: version.updatedAt,
      }));
    },

    /** Copies a version's saved items into a new latest version, without re-fetching products. */
    async copyVersion(
      userId: string,
      requestId: string,
      number: number,
      input: { summary?: string; expectedLatestVersion: number },
    ) {
      const request = await findAccessibleRequest(userId, requestId);
      if (request.status !== "draft") {
        throw new HttpError(409, "This request is no longer a draft.", "request_locked");
      }
      if (input.expectedLatestVersion !== request.latestVersion) throw versionConflict(request.latestVersion);
      const source = await findVersion(request, number);
      const items = (source.toObject().items as StoredItem[]).map((item) => ({ ...item, _id: new Types.ObjectId() }));
      if (items.length === 0) throw new HttpError(400, "That version has no items to copy.", "empty_version");
      return insertVersion(userId, request, items, {
        basedOnVersion: number,
        summary: input.summary || `Copy of v${number}`,
      });
    },

    updateItemQuantity(userId: string, requestId: string, number: number, itemId: string, quantity: number, expectedRevision: number) {
      return mutateItems(userId, requestId, number, expectedRevision, (items) => {
        const index = findItem(items, itemId);
        items[index] = { ...items[index]!, quantity };
        return items;
      });
    },

    removeItem(userId: string, requestId: string, number: number, itemId: string, expectedRevision: number) {
      return mutateItems(userId, requestId, number, expectedRevision, (items) => {
        const index = findItem(items, itemId);
        return items.filter((_, i) => i !== index);
      });
    },

    addItem(userId: string, requestId: string, number: number, input: ItemInput, expectedRevision: number) {
      return mutateItems(userId, requestId, number, expectedRevision, async (items) => {
        if (items.some((item) => item.channel3ProductId === input.channel3ProductId)) {
          throw new HttpError(409, "That product is already in this version. Change its quantity instead.", "duplicate_product");
        }
        if (items.length >= MAX_ITEMS_PER_VERSION) {
          throw new HttpError(400, `A version can have at most ${MAX_ITEMS_PER_VERSION} items.`, "too_many_items");
        }
        const product = await resolve(userId, input.channel3ProductId);
        return [...items, snapshot(product, input.quantity, input.rationale)];
      });
    },

    /** Signs off one exact version (number + revision) and locks the request until unapproved or paid. */
    async approveVersion(userId: string, requestId: string, number: number, expectedRevision: number) {
      const request = await findAccessibleRequest(userId, requestId);
      if (request.status === "approved") {
        throw new HttpError(409, `Version ${request.approvedVersion} is already approved. Unapprove it first.`, "already_approved", {
          approvedVersion: request.approvedVersion,
        });
      }
      if (request.status !== "draft") throw new HttpError(409, "This request has already been paid.", "request_locked");

      const version = await findVersion(request, number);
      if (version.revision !== expectedRevision) throw staleRevision(version.revision);
      const items = version.toObject().items as StoredItem[];
      if (items.length === 0 || version.totalCents <= 0) {
        throw new HttpError(422, "An empty sheet can't be approved.", "empty_version");
      }
      const outOfStock = items.filter((item) => item.availability !== "InStock");
      if (outOfStock.length) {
        throw new HttpError(422, "Remove or replace out-of-stock items before approving.", "out_of_stock", {
          items: outOfStock.map((item) => ({ id: String(item._id), title: item.title })),
        });
      }
      if (request.budgetCents && version.totalCents > request.budgetCents) {
        throw new HttpError(422, "This version is over budget and can't be approved.", "over_budget", {
          totalCents: version.totalCents,
          budgetCents: request.budgetCents,
        });
      }

      // Record this person's nod on exactly this revision (any edit clears all nods).
      let current = await Version.findOneAndUpdate(
        { _id: version._id, revision: expectedRevision, "nods.userId": { $ne: userId } },
        { $push: { nods: { userId, revision: expectedRevision, at: new Date() } } },
        { new: true },
      );
      if (!current) {
        current = await Version.findById(version._id);
        if (!current || current.revision !== expectedRevision) throw staleRevision(current?.revision ?? expectedRevision + 1);
      }

      const memberIds = memberIdsOf(request);
      const nodded = new Set(current.nods.filter((n) => n.revision === expectedRevision).map((n) => String(n.userId)));
      if (!memberIds.every((id) => nodded.has(id))) {
        return { finalized: false, request: presentRequest(request, userId), version: presentVersion(current, request.budgetCents) };
      }

      // Everyone has nodded: claim the request so concurrent edits and approvals are locked out.
      const claimed = await ProcurementRequest.findOneAndUpdate(
        { _id: request._id, status: "draft", members: { $size: request.members.length } },
        { $set: { status: "approved", approvedVersion: number, shares: equalShares(version.totalCents, memberIds) } },
        { new: true },
      );
      if (!claimed) throw new HttpError(409, "This request changed meanwhile. Reload and try again.", "request_locked");

      const approved = await Version.findOneAndUpdate(
        { _id: version._id, revision: expectedRevision },
        { $set: { approval: { approvedAt: new Date(), approvedRevision: expectedRevision, approvedTotalCents: version.totalCents } } },
        { new: true },
      );
      if (!approved) {
        await ProcurementRequest.updateOne(
          { _id: request._id, status: "approved" },
          { $set: { status: "draft", shares: [] }, $unset: { approvedVersion: 1 } },
        );
        const latest = await Version.findById(version._id);
        throw staleRevision(latest?.revision ?? expectedRevision + 1);
      }
      return { finalized: true, request: presentRequest(claimed, userId), version: presentVersion(approved, request.budgetCents) };
    },

    /** Takes back your own nod while the request is still a draft. */
    async withdrawNod(userId: string, requestId: string, number: number) {
      const request = await findAccessibleRequest(userId, requestId);
      if (request.status !== "draft") throw new HttpError(409, "This request is no longer a draft.", "request_locked");
      const version = await findVersion(request, number);
      const updated = await Version.findOneAndUpdate({ _id: version._id }, { $pull: { nods: { userId } } }, { new: true });
      return presentVersion(updated!, request.budgetCents);
    },

    /** Withdraws approval and cancels any unpaid PayPal order, returning the request to draft. */
    async unapprove(userId: string, requestId: string) {
      const request = await findAccessibleRequest(userId, requestId);
      if (request.status === "paid") throw new HttpError(409, "This request has already been paid.", "request_locked");
      if (request.status !== "approved") throw new HttpError(409, "Nothing is approved on this request.", "not_approved");
      if (await poolLocks(request._id)) {
        throw new HttpError(409, "A community pool is open on this request. Cancel the pool first.", "pool_open");
      }

      const inFlight = await Payment.exists({ requestId: request._id, status: { $in: ["capturing", "pending", "completed"] } });
      if (inFlight) {
        throw new HttpError(409, "A payment is already in progress for this request.", "payment_in_progress");
      }

      const reverted = await ProcurementRequest.findOneAndUpdate(
        { _id: request._id, status: "approved" },
        { $set: { status: "draft", shares: [] }, $unset: { approvedVersion: 1 } },
        { new: true },
      );
      if (!reverted) throw new HttpError(409, "This request changed meanwhile. Reload and try again.", "request_locked");
      await Promise.all([
        Version.updateOne({ requestId: request._id, number: request.approvedVersion }, { $unset: { approval: 1 }, $set: { nods: [] } }),
        Payment.updateMany({ requestId: request._id, status: "created" }, { $set: { status: "cancelled" } }),
      ]);
      return { request: presentRequest(reverted, userId) };
    },

    /** Deletes a draft or approved request with its versions and unpaid payment records. Paid requests are kept. */
    async deleteRequest(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      if (request.status === "paid") {
        throw new HttpError(409, "Paid requests can't be deleted; they're your payment record.", "request_paid");
      }
      if (await poolLocks(request._id)) {
        throw new HttpError(409, "A community pool is open on this request. Cancel the pool first.", "pool_open");
      }
      // Cancelling first stops a capture from claiming the order while we delete
      await Payment.updateMany({ requestId: request._id, status: "created" }, { $set: { status: "cancelled" } });
      const active = await Payment.exists({ requestId: request._id, status: { $in: ["capturing", "pending", "completed"] } });
      if (active) {
        throw new HttpError(409, "A payment for this request is in progress or complete, so it can't be deleted.", "payment_in_progress");
      }
      const deleted = await ProcurementRequest.deleteOne({ _id: request._id, status: { $in: ["draft", "approved"] } });
      if (deleted.deletedCount === 0) {
        throw new HttpError(409, "This request changed meanwhile. Reload and try again.", "request_locked");
      }
      await Promise.all([
        Version.deleteMany({ requestId: request._id }),
        Payment.deleteMany({ requestId: request._id, status: { $in: ["created", "cancelled", "failed"] } }),
      ]);
    },

    /** Owner creates (or rotates) the invite link token. */
    async createInvite(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      const inviteToken = randomBytes(18).toString("base64url");
      await ProcurementRequest.updateOne({ _id: request._id }, { $set: { inviteToken } });
      return { inviteToken };
    },

    async revokeInvite(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      await ProcurementRequest.updateOne({ _id: request._id }, { $unset: { inviteToken: 1 } });
    },

    async previewInvite(userId: string, token: string) {
      const request = await ProcurementRequest.findOne({ inviteToken: token });
      if (!request) throw new HttpError(404, "This invite link is no longer valid.", "invite_invalid");
      const owner = await User.findById(request.userId);
      return {
        requestId: String(request._id),
        prompt: request.prompt,
        ownerName: owner?.displayName ?? "Someone",
        memberCount: request.members.length + 1,
        status: request.status,
        alreadyMember: memberIdsOf(request).includes(userId),
      };
    },

    async joinByInvite(userId: string, token: string) {
      const request = await ProcurementRequest.findOne({ inviteToken: token });
      if (!request) throw new HttpError(404, "This invite link is no longer valid.", "invite_invalid");
      if (memberIdsOf(request).includes(userId)) return { requestId: String(request._id) };
      if (request.status !== "draft") {
        throw new HttpError(409, "This request is already approved, so no one else can join.", "request_locked");
      }
      if (request.members.length + 1 >= MAX_GROUP_SIZE) {
        throw new HttpError(409, `A group can have at most ${MAX_GROUP_SIZE} people.`, "group_full");
      }
      const joined = await ProcurementRequest.findOneAndUpdate(
        { _id: request._id, status: "draft", "members.userId": { $ne: userId } },
        { $push: { members: { userId, joinedAt: new Date() } } },
        { new: true },
      );
      if (!joined) throw new HttpError(409, "This request changed meanwhile. Try the link again.", "request_locked");
      // A new person has to nod too, so earlier nods no longer count.
      await Version.updateMany({ requestId: request._id }, { $set: { nods: [] } });
      return { requestId: String(request._id) };
    },

    /** Owner removes a member, or a member leaves. Only while the request is a draft. */
    async removeMember(userId: string, requestId: string, memberId: string) {
      const request = await findAccessibleRequest(userId, requestId);
      const isOwner = String(request.userId) === userId;
      if (!isOwner && memberId !== userId) throw new HttpError(403, "Only the owner can remove other people.", "forbidden");
      if (memberId === String(request.userId)) throw new HttpError(400, "The owner can't leave their own request.", "owner_cannot_leave");
      if (request.status !== "draft") throw new HttpError(409, "People can't leave once the request is approved.", "request_locked");
      const updated = await ProcurementRequest.updateOne(
        { _id: request._id, status: "draft" },
        { $pull: { members: { userId: memberId } } },
      );
      if (updated.modifiedCount === 0) throw notFound("Member");
      await Version.updateMany({ requestId: request._id }, { $pull: { nods: { userId: memberId } } });
    },

    /** Owner sets custom shares (must cover every member and sum to the approved total). */
    async setShares(userId: string, requestId: string, shares: { userId: string; amountCents: number }[]) {
      const request = await findOwnedRequest(userId, requestId);
      if (request.status !== "approved") throw new HttpError(409, "Shares can be set once everyone has nodded.", "not_approved");
      const version = await Version.findOne({ requestId: request._id, number: request.approvedVersion });
      if (!version) throw notFound("Version");
      const ids = memberIdsOf(request);
      const given = shares.map((s) => s.userId);
      if (new Set(given).size !== given.length || given.length !== ids.length || !ids.every((id) => given.includes(id))) {
        throw new HttpError(400, "Give exactly one share for each person in the group.", "invalid_shares");
      }
      if (shares.reduce((sum, s) => sum + s.amountCents, 0) !== version.totalCents) {
        throw new HttpError(400, "Shares must add up to the approved total.", "shares_total_mismatch", { totalCents: version.totalCents });
      }
      if (await Payment.exists({ requestId: request._id, status: { $in: ["created", "capturing", "pending", "completed"] } })) {
        throw new HttpError(409, "Someone has already started paying, so shares are locked.", "payment_in_progress");
      }
      const updated = await ProcurementRequest.findOneAndUpdate(
        { _id: request._id, status: "approved" },
        { $set: { shares } },
        { new: true },
      );
      if (!updated) throw new HttpError(409, "This request changed meanwhile. Reload and try again.", "request_locked");
      return { members: await presentMembers(updated, version) };
    },

    async diffVersions(userId: string, requestId: string, number: number, againstNumber: number) {
      const request = await findAccessibleRequest(userId, requestId);
      const [to, from] = await Promise.all([findVersion(request, number), findVersion(request, againstNumber)]);
      const toItems = to.toObject().items as StoredItem[];
      const fromItems = new Map((from.toObject().items as StoredItem[]).map((item) => [item.channel3ProductId, item]));

      const line = (item: StoredItem) => ({
        channel3ProductId: item.channel3ProductId,
        title: item.title,
        retailerDomain: item.retailerDomain,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: lineTotal(item),
      });

      const added = [];
      const changed = [];
      let unchanged = 0;
      for (const item of toItems) {
        const before = fromItems.get(item.channel3ProductId);
        fromItems.delete(item.channel3ProductId);
        if (!before) added.push(line(item));
        else if (before.quantity !== item.quantity || before.unitPriceCents !== item.unitPriceCents) {
          changed.push({ ...line(item), before: line(before) });
        } else unchanged++;
      }
      const removed = [...fromItems.values()].map(line);

      return {
        from: { number: from.number, totalCents: from.totalCents },
        to: { number: to.number, totalCents: to.totalCents },
        totalDeltaCents: to.totalCents - from.totalCents,
        added,
        removed,
        changed,
        unchangedCount: unchanged,
      };
    },
  };
}

export type RequestService = ReturnType<typeof createRequestService>;
