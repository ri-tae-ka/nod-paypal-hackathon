import { InferSchemaType, Schema, model } from "mongoose";

const paymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ProcurementRequest", required: true },
    versionId: { type: Schema.Types.ObjectId, ref: "Version", required: true },
    versionNumber: { type: Number, required: true, min: 1 },
    approvedRevision: { type: Number, required: true },
    paypalOrderId: { type: String, required: true, unique: true },
    paypalCaptureId: { type: String, sparse: true, unique: true },
    // Where the buyer approves the order on PayPal (redirect flow)
    approveUrl: String,
    amountCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    currency: { type: String, enum: ["USD"], default: "USD" },
    status: {
      type: String,
      // "capturing" guards against unapprove racing an in-flight capture
      enum: ["created", "capturing", "completed", "pending", "failed", "cancelled", "refunded"],
      default: "created",
    },
    refundId: String,
    refundedAt: Date,
    payer: {
      email: String,
      payerId: String,
    },
    capturedAt: Date,
    failureReason: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

paymentSchema.index({ requestId: 1, createdAt: -1 });

export type PaymentDoc = InferSchemaType<typeof paymentSchema>;
export const Payment = model("Payment", paymentSchema);
