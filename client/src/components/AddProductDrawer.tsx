import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { searchProducts } from "../api/requests";
import { formatCents, parseDollars } from "../lib/format";
import type { ProductCandidate } from "../types/api";
import styles from "./AddProductDrawer.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  existingProductIds: Set<string>;
  adding: boolean;
  onAdd: (product: ProductCandidate, quantity: number) => Promise<unknown>;
}

export function AddProductDrawer({ open, onClose, existingProductIds, adding, onAdd }: Props) {
  const [query, setQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const search = useMutation({ mutationFn: searchProducts });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const maxPriceCents = maxPrice.trim() ? parseDollars(maxPrice) : undefined;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (maxPriceCents === null) return;
    search.mutate({ query: query.trim(), maxPriceCents, limit: 12 });
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <aside className={styles.drawer} onClick={(e) => e.stopPropagation()} aria-label="Add products">
        <div className={styles.head}>
          <h2>Add products</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="muted">Search real products through Channel3 and add them to the sheet.</p>

        <form className={styles.form} onSubmit={onSubmit}>
          <input
            placeholder="e.g. ergonomic office chair"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            minLength={2}
            required
            autoFocus
          />
          <input
            placeholder="Max $"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            className={styles.price}
            inputMode="decimal"
          />
          <button type="submit" className="primary" disabled={search.isPending || maxPriceCents === null}>
            {search.isPending ? "Searching…" : "Search"}
          </button>
        </form>
        {maxPriceCents === null && <p className="error">Enter a valid max price, e.g. 250.</p>}
        {search.error && <p className="error">{search.error.message}</p>}
        {search.data && (
          <p className={styles.meta}>
            {search.data.products.length} results · {search.data.searchesRemainingToday} searches left today
            {search.data.cached && " · cached"}
          </p>
        )}

        <ul className={styles.results}>
          {search.data?.products.map((p) => {
            const inSheet = existingProductIds.has(p.channel3ProductId);
            const qty = quantities[p.channel3ProductId] ?? 1;
            return (
              <li key={p.channel3ProductId} className={styles.result}>
                {p.imageUrl ? <img src={p.imageUrl} alt="" className={styles.thumb} /> : <span className={styles.thumb} />}
                <div className={styles.info}>
                  <a href={p.buyUrl} target="_blank" rel="noreferrer" className={styles.title}>
                    {p.title}
                  </a>
                  <span className="muted">
                    {[p.brand, p.retailerDomain].filter(Boolean).join(" · ")}
                    {p.rating && ` · ★ ${p.rating.value.toFixed(1)} (${p.rating.count})`}
                  </span>
                  <span className={styles.priceTag}>
                    {formatCents(p.unitPriceCents)}
                    {p.compareAtPriceCents && p.compareAtPriceCents > p.unitPriceCents && (
                      <s className="muted"> {formatCents(p.compareAtPriceCents)}</s>
                    )}
                    {p.availability === "OutOfStock" && <span className="error"> · Out of stock</span>}
                  </span>
                </div>
                <div className={styles.addBox}>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={qty}
                    onChange={(e) =>
                      setQuantities((q) => ({
                        ...q,
                        [p.channel3ProductId]: Math.min(1000, Math.max(1, Math.trunc(Number(e.target.value)) || 1)),
                      }))
                    }
                    aria-label="Quantity"
                    disabled={inSheet}
                  />
                  <button
                    className="primary"
                    disabled={inSheet || adding || p.availability === "OutOfStock"}
                    onClick={() => void onAdd(p, qty).catch(() => undefined)}
                  >
                    {inSheet ? "Added" : "Add"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
