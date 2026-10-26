import { InferSchemaType, Schema, model } from "mongoose";

// A community pool: anyone with the public link can chip in toward one approved version.
// All or nothing: once contributions reach the goal it is funded; if it is cancelled or the
// deadline passes first, every captured contribution is refunded.
const poolSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "ProcurementRequest", required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    versionId: { type: Schema.Types.ObjectId, ref: "Version", required: true },
    versionNumber: { type: Number, required: true, min: 1 },
    approvedRevision: { type: Number, required: true, min: 0 },
    goalCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    token: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    story: { type: String, trim: true, maxlength: 2000 },
    // AI-written plain-language summary of what the money buys
    pitch: { type: String, maxlength: 1000 },
    pitchByAi: { type: Boolean, default: false },
    // Public display name; the owner's email itself is never shown
    organizer: { type: String, required: true, maxlength: 60 },
    deadline: Date,
    status: { type: String, enum: ["open", "closing", "funded", "cancelled", "expired"], default: "open", index: true },
    fundedAt: Date,
    closedAt: Date,
    // Set while open, closing or funded; a partial unique index allows one live pool per request
    active: { type: Boolean },
  },
  { timestamps: true },
);

poolSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "one_active_pool" });

/** Open (or closing) pools lock the request: no unapprove, checkout or delete. */
export const poolLocks = (requestId: unknown) => Pool.exists({ requestId, status: { $in: ["open", "closing"] } });

export type PoolDoc = InferSchemaType<typeof poolSchema>;
export const Pool = model("Pool", poolSchema);
