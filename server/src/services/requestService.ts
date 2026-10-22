import { type HydratedDocument, Types, isValidObjectId } from "mongoose";
import { HttpError } from "../middleware/errorHandler.js";
import { Payment } from "../models/Payment.js";
import { ProcurementRequest, type ProcurementRequestDoc } from "../models/ProcurementRequest.js";
import { Version, type VersionDoc } from "../models/Version.js";
import type { ProductCandidate } from "./channel3/mapper.js";
import type { ProductSearchService } from "./productSearch.js";

export const MAX_ITEMS_PER_VERSION = 50;

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

function presentRequest(request: RequestDocument) {
  return {
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
    const request = await findOwnedRequest(userId, requestId);
    const version = await findVersion(request, number);
    assertEditable(request, version);
    if (version.revision !== expectedRevision) throw staleRevision(version.revision);

    const items = await mutate(version.toObject().items as StoredItem[]);
    const updated = await Version.findOneAndUpdate(
      { _id: version._id, revision: expectedRevision },
      { $set: { items, totalCents: sumTotal(items) }, $inc: { revision: 1 }, $unset: { approval: 1 } },
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
      return presentRequest(request);
    },

    async listRequests(userId: string) {
      const requests = await ProcurementRequest.find({ userId }).sort({ createdAt: -1 }).limit(100);
      return requests.map(presentRequest);
    },

    async getRequest(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      const latest =
        request.latestVersion > 0 ? await Version.findOne({ requestId: request._id, number: request.latestVersion }) : null;
      return {
        request: presentRequest(request),
        latestVersion: latest ? presentVersion(latest, request.budgetCents) : null,
      };
    },

    async getVersion(userId: string, requestId: string, number: number) {
      const request = await findOwnedRequest(userId, requestId);
      return presentVersion(await findVersion(request, number), request.budgetCents);
    },

    async createVersion(userId: string, requestId: string, input: CreateVersionInput) {
      const request = await findOwnedRequest(userId, requestId);
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
      const request = await findOwnedRequest(userId, requestId);
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
      const request = await findOwnedRequest(userId, requestId);
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
      const request = await findOwnedRequest(userId, requestId);
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

      // Claim the request first so concurrent edits and approvals are locked out.
      const claimed = await ProcurementRequest.findOneAndUpdate(
        { _id: request._id, status: "draft" },
        { $set: { status: "approved", approvedVersion: number } },
        { new: true },
      );
      if (!claimed) throw new HttpError(409, "This request changed meanwhile. Reload and try again.", "request_locked");

      const approved = await Version.findOneAndUpdate(
        { _id: version._id, revision: expectedRevision },
        { $set: { approval: { approvedAt: new Date(), approvedRevision: expectedRevision, approvedTotalCents: version.totalCents } } },
        { new: true },
      );
      if (!approved) {
        await ProcurementRequest.updateOne({ _id: request._id, status: "approved" }, { $set: { status: "draft" }, $unset: { approvedVersion: 1 } });
        const current = await Version.findById(version._id);
        throw staleRevision(current?.revision ?? expectedRevision + 1);
      }
      return { request: presentRequest(claimed), version: presentVersion(approved, request.budgetCents) };
    },

    /** Withdraws approval and cancels any unpaid PayPal order, returning the request to draft. */
    async unapprove(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      if (request.status === "paid") throw new HttpError(409, "This request has already been paid.", "request_locked");
      if (request.status !== "approved") throw new HttpError(409, "Nothing is approved on this request.", "not_approved");

      const inFlight = await Payment.exists({ requestId: request._id, status: { $in: ["capturing", "pending", "completed"] } });
      if (inFlight) {
        throw new HttpError(409, "A payment is already in progress for this request.", "payment_in_progress");
      }

      const reverted = await ProcurementRequest.findOneAndUpdate(
        { _id: request._id, status: "approved" },
        { $set: { status: "draft" }, $unset: { approvedVersion: 1 } },
        { new: true },
      );
      if (!reverted) throw new HttpError(409, "This request changed meanwhile. Reload and try again.", "request_locked");
      await Promise.all([
        Version.updateOne({ requestId: request._id, number: request.approvedVersion }, { $unset: { approval: 1 } }),
        Payment.updateMany({ requestId: request._id, status: "created" }, { $set: { status: "cancelled" } }),
      ]);
      return { request: presentRequest(reverted) };
    },

    /** Deletes a draft or approved request with its versions and unpaid payment records. Paid requests are kept. */
    async deleteRequest(userId: string, requestId: string) {
      const request = await findOwnedRequest(userId, requestId);
      if (request.status === "paid") {
        throw new HttpError(409, "Paid requests can't be deleted; they're your payment record.", "request_paid");
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

    async diffVersions(userId: string, requestId: string, number: number, againstNumber: number) {
      const request = await findOwnedRequest(userId, requestId);
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
