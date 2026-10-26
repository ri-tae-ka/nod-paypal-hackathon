import { InferSchemaType, Schema, model } from "mongoose";

const cents = { type: Number, required: true, min: 0, validate: Number.isInteger };

// Product details are snapshotted at selection time because live prices change.
const itemSchema = new Schema(
  {
    channel3ProductId: { type: String, required: true },
    title: { type: String, required: true, maxlength: 500 },
    brand: { type: String, maxlength: 200 },
    category: { type: String, maxlength: 200 },
    imageUrl: String,
    materials: { type: [{ type: String, maxlength: 200 }], default: undefined },
    keyFeatures: { type: [{ type: String, maxlength: 500 }], default: undefined },
    rating: {
      type: new Schema({ value: { type: Number, min: 0, max: 5 }, count: { type: Number, min: 0 } }, { _id: false }),
      default: undefined,
    },
    retailerDomain: { type: String, required: true },
    buyUrl: { type: String, required: true },
    availability: { type: String, enum: ["InStock", "OutOfStock"], required: true },
    currency: { type: String, enum: ["USD"], default: "USD" },
    unitPriceCents: cents,
    compareAtPriceCents: { type: Number, min: 0, validate: Number.isInteger },
    quantity: { type: Number, required: true, min: 1, max: 1000, validate: Number.isInteger },
    rationale: { type: String, maxlength: 1000 },
  },
  { timestamps: false },
);

const versionSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "ProcurementRequest", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    number: { type: Number, required: true, min: 1, validate: Number.isInteger },
    basedOnVersion: { type: Number, min: 1 },
    instruction: { type: String, maxlength: 2000 },
    summary: { type: String, maxlength: 2000 },
    items: { type: [itemSchema], validate: (items: unknown[]) => items.length <= 50 },
    totalCents: cents,
    // Incremented on every edit so stale AI results and stale approvals can be rejected
    revision: { type: Number, default: 0, min: 0 },
    // Each member's nod on a specific revision; cleared by any edit. Approval is final once all have nodded.
    nods: {
      type: [
        new Schema(
          { userId: { type: Schema.Types.ObjectId, ref: "User", required: true }, revision: { type: Number, required: true }, at: { type: Date, default: Date.now } },
          { _id: false },
        ),
      ],
      default: [],
    },
    approval: {
      approvedAt: Date,
      approvedRevision: Number,
      approvedTotalCents: Number,
    },
  },
  { timestamps: true },
);

versionSchema.index({ requestId: 1, number: 1 }, { unique: true });

export type VersionDoc = InferSchemaType<typeof versionSchema>;
export const Version = model("Version", versionSchema);
