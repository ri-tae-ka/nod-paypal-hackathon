import { InferSchemaType, Schema, model } from "mongoose";

// One guest's pledge to a pool, paid through its own PayPal order. No Nod account is needed.
const contributionSchema = new Schema(
  {
    poolId: { type: Schema.Types.ObjectId, ref: "Pool", required: true },
    name: { type: String, trim: true, maxlength: 60 },
    anonymous: { type: Boolean, default: false },
    message: { type: String, trim: true, maxlength: 200 },
    amountCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    currency: { type: String, enum: ["USD"], default: "USD" },
    paypalOrderId: { type: String, required: true, unique: true },
    paypalCaptureId: { type: String, sparse: true, unique: true },
    approveUrl: String,
    status: {
      type: String,
      enum: ["created", "capturing", "completed", "pending", "failed", "cancelled", "refunded"],
      default: "created",
    },
    payer: { email: String, payerId: String },
    capturedAt: Date,
    refundId: String,
    refundedAt: Date,
    failureReason: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

contributionSchema.index({ poolId: 1, status: 1, createdAt: -1 });

export type ContributionDoc = InferSchemaType<typeof contributionSchema>;
export const Contribution = model("Contribution", contributionSchema);
