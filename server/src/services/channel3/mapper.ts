import { z } from "zod";

// Only the fields we use. Unknown fields are ignored so upstream additions don't break us.
const priceSchema = z.looseObject({
  price: z.number().optional(),
  amount: z.number().optional(),
  compare_at_price: z.number().nullish(),
  currency: z.string(),
});

const offerSchema = z.looseObject({
  url: z.string(),
  domain: z.string(),
  price: priceSchema,
  availability: z.string(),
});

export const channel3ProductSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  brands: z.array(z.looseObject({ name: z.string() })).nullish(),
  images: z.array(z.looseObject({ url: z.string(), is_main_image: z.boolean().nullish() })).nullish(),
  category: z.looseObject({ title: z.string() }).nullish(),
  materials: z.array(z.string()).nullish(),
  key_features: z.array(z.string()).nullish(),
  offers: z.array(z.unknown()).nullish(),
  ratings: z.looseObject({ value: z.number(), count: z.number() }).nullish(),
});

export const channel3SearchResponseSchema = z.looseObject({
  products: z.array(z.unknown()),
});

export interface ProductCandidate {
  channel3ProductId: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  category: string | null;
  materials: string[];
  keyFeatures: string[];
  rating: { value: number; count: number } | null;
  retailerDomain: string;
  buyUrl: string;
  availability: "InStock" | "OutOfStock";
  currency: "USD";
  unitPriceCents: number;
  compareAtPriceCents: number | null;
  offerCount: number;
}

function toCents(amount: number | null | undefined): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

/**
 * Maps one raw Channel3 product to the shape we store and show.
 * Picks the cheapest in-stock USD offer (falling back to cheapest USD offer).
 * Returns null when the product is malformed or has no usable USD offer.
 */
export function toProductCandidate(raw: unknown): ProductCandidate | null {
  const parsed = channel3ProductSchema.safeParse(raw);
  if (!parsed.success) return null;
  const product = parsed.data;

  const offers = (product.offers ?? [])
    .map((offer) => offerSchema.safeParse(offer))
    .flatMap((result) => (result.success ? [result.data] : []))
    .filter((offer) => offer.price.currency.toUpperCase() === "USD")
    .map((offer) => ({
      offer,
      cents: toCents(offer.price.price ?? offer.price.amount),
      inStock: offer.availability === "InStock",
    }))
    .filter((entry): entry is typeof entry & { cents: number } => entry.cents !== null)
    .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.cents - b.cents);

  const best = offers[0];
  if (!best) return null;

  const images = product.images ?? [];
  const image = images.find((img) => img.is_main_image) ?? images[0];
  const compareAt = toCents(best.offer.price.compare_at_price);

  return {
    channel3ProductId: product.id,
    title: product.title,
    brand: product.brands?.[0]?.name ?? null,
    imageUrl: image?.url ?? null,
    category: product.category?.title ?? null,
    materials: product.materials ?? [],
    keyFeatures: product.key_features ?? [],
    rating:
      product.ratings && product.ratings.count > 0
        ? { value: product.ratings.value, count: product.ratings.count }
        : null,
    retailerDomain: best.offer.domain,
    buyUrl: best.offer.url,
    availability: best.inStock ? "InStock" : "OutOfStock",
    currency: "USD",
    unitPriceCents: best.cents,
    compareAtPriceCents: compareAt !== null && compareAt > best.cents ? compareAt : null,
    offerCount: offers.length,
  };
}
