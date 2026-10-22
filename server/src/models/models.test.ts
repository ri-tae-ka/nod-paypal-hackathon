import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { Payment } from "./Payment.js";
import { ProcurementRequest } from "./ProcurementRequest.js";
import { User } from "./User.js";
import { Version } from "./Version.js";

const id = () => new Types.ObjectId();
const item = {
  channel3ProductId: "p1",
  title: "Desk lamp",
  retailerDomain: "shop.example.com",
  buyUrl: "https://shop.example.com/lamp",
  availability: "InStock",
  unitPriceCents: 2599,
  quantity: 2,
};

describe("model validation (no database required)", () => {
  it("normalizes and requires user fields", () => {
    const user = new User({ email: "  Ada@Example.COM ", passwordHash: "hash", displayName: "Ada" });
    expect(user.validateSync()).toBeUndefined();
    expect(user.email).toBe("ada@example.com");
    expect(new User({}).validateSync()?.errors).toHaveProperty("email");
  });

  it("accepts a valid version and rejects bad money and quantities", () => {
    const base = { requestId: id(), userId: id(), number: 1, totalCents: 5198 };
    expect(new Version({ ...base, items: [item] }).validateSync()).toBeUndefined();
    const bad = (override: object) => new Version({ ...base, items: [{ ...item, ...override }] }).validateSync();
    expect(bad({ unitPriceCents: 25.99 })).toBeDefined();
    expect(bad({ unitPriceCents: -1 })).toBeDefined();
    expect(bad({ quantity: 0 })).toBeDefined();
    expect(bad({ quantity: 1.5 })).toBeDefined();
    expect(bad({ availability: "Maybe" })).toBeDefined();
  });

  it("limits request budgets to positive whole cents and valid statuses", () => {
    const make = (o: object) => new ProcurementRequest({ userId: id(), prompt: "chairs", ...o }).validateSync();
    expect(make({ budgetCents: 400000 })).toBeUndefined();
    expect(make({ budgetCents: 10.5 })).toBeDefined();
    expect(make({ status: "shipped" })).toBeDefined();
  });

  it("restricts payments to USD and known statuses", () => {
    const make = (o: object) =>
      new Payment({
        userId: id(), requestId: id(), versionId: id(), versionNumber: 1, approvedRevision: 1,
        paypalOrderId: "ORDER1", amountCents: 5198, ...o,
      }).validateSync();
    expect(make({})).toBeUndefined();
    expect(make({ currency: "EUR" })).toBeDefined();
    expect(make({ status: "refunded" })).toBeDefined();
    expect(make({ amountCents: 0 })).toBeDefined();
  });

  it("keeps the password hash out of default queries", () => {
    expect(User.schema.path("passwordHash").options.select).toBe(false);
  });
});
