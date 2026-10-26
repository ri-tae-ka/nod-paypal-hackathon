import { InferSchemaType, Schema, model } from "mongoose";

const procurementRequestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    prompt: { type: String, required: true, trim: true, maxlength: 4000 },
    summary: { type: String, trim: true, maxlength: 1000 },
    budgetCents: { type: Number, min: 1, validate: Number.isInteger },
    status: { type: String, enum: ["draft", "approved", "paid"], default: "draft" },
    latestVersion: { type: Number, default: 0, min: 0 },
    // Set while status is "approved" or "paid"; the version number that was signed off
    approvedVersion: { type: Number, min: 1 },
    // Group Nod: people besides the owner (userId). Solo requests have none.
    members: {
      type: [
        new Schema(
          { userId: { type: Schema.Types.ObjectId, ref: "User", required: true }, joinedAt: { type: Date, default: Date.now } },
          { _id: false },
        ),
      ],
      default: [],
    },
    inviteToken: { type: String, index: { unique: true, sparse: true } },
    // What each person pays once everyone has nodded; sums to the approved total
    shares: {
      type: [
        new Schema(
          { userId: { type: Schema.Types.ObjectId, ref: "User", required: true }, amountCents: { type: Number, required: true, min: 1 } },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

procurementRequestSchema.index({ userId: 1, createdAt: -1 });
procurementRequestSchema.index({ "members.userId": 1, createdAt: -1 });

export type ProcurementRequestDoc = InferSchemaType<typeof procurementRequestSchema>;
export const ProcurementRequest = model("ProcurementRequest", procurementRequestSchema);
