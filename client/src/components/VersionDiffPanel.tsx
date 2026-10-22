import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { diffVersions } from "../api/requests";
import { formatCents } from "../lib/format";
import type { DiffLine, VersionSummary } from "../types/api";
import styles from "./VersionDiffPanel.module.css";

interface Props {
  requestId: string;
  versions: VersionSummary[];
  viewing: number;
  latest: number;
  /** Opens the panel against a given version; change `nonce` to trigger it again. */
  focus?: { against: number; nonce: number } | null;
}

function defaultAgainst(versions: VersionSummary[], viewing: number, latest: number) {
  if (viewing !== latest) return latest;
  const current = versions.find((v) => v.number === viewing);
  return current?.basedOnVersion ?? viewing - 1;
}

const qtyPrice = (line: DiffLine) => `${line.quantity} × ${formatCents(line.unitPriceCents)}`;

export function VersionDiffPanel({ requestId, versions, viewing, latest, focus }: Props) {
  const [open, setOpen] = useState(false);
  const [against, setAgainst] = useState(() => defaultAgainst(versions, viewing, latest));
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => setAgainst(defaultAgainst(versions, viewing, latest)), [versions, viewing, latest]);

  useEffect(() => {
    if (!focus) return;
    setAgainst(focus.against);
    setOpen(true);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focus]);

  const from = Math.min(viewing, against);
  const to = Math.max(viewing, against);
  const valid = against >= 1 && against !== viewing;

  const diff = useQuery({
    queryKey: ["request", requestId, "diff", to, from],
    queryFn: () => diffVersions(requestId, to, from),
    enabled: open && valid,
  });

  if (versions.length < 2) return null;

  const others = versions.filter((v) => v.number !== viewing);
  const d = diff.data;
  const pct = d && d.from.totalCents > 0 ? Math.round((Math.abs(d.totalDeltaCents) / d.from.totalCents) * 100) : null;

  return (
    <section className={styles.panel} ref={panelRef}>
      <div className={styles.head}>
        <span className={styles.label}>Compare v{viewing} with</span>
        <select value={against} onChange={(e) => setAgainst(Number(e.target.value))} aria-label="Compare against version">
          {others.map((v) => (
            <option key={v.number} value={v.number}>
              v{v.number}
              {v.number === latest ? " (latest)" : ""}
            </option>
          ))}
        </select>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide changes" : "Show changes"}
        </button>
      </div>

      {open && valid && (
        <div className={styles.body}>
          {diff.isPending && <p className="muted">Comparing…</p>}
          {diff.error && <p className="error">{diff.error.message}</p>}
          {d && (
            <>
              <p className={styles.summary}>
                From <strong>v{d.from.number}</strong> ({formatCents(d.from.totalCents)}) to{" "}
                <strong>v{d.to.number}</strong> ({formatCents(d.to.totalCents)}):{" "}
                <span
                  className={
                    d.totalDeltaCents < 0 ? styles.cheaper : d.totalDeltaCents > 0 ? styles.pricier : undefined
                  }
                >
                  {d.totalDeltaCents === 0
                    ? "same total"
                    : `${d.totalDeltaCents > 0 ? "+" : "−"}${formatCents(Math.abs(d.totalDeltaCents))}${
                        pct !== null ? ` (${pct}% ${d.totalDeltaCents > 0 ? "more" : "cheaper"})` : ""
                      }`}
                </span>
              </p>

              {d.added.length + d.removed.length + d.changed.length === 0 ? (
                <p className="muted">
                  No item changes. Both versions have the same {d.unchangedCount}{" "}
                  {d.unchangedCount === 1 ? "item" : "items"}.
                </p>
              ) : (
                <ul className={styles.lines}>
                  {d.added.map((line) => (
                    <li key={`a-${line.channel3ProductId}`} className={styles.added}>
                      <span className={styles.kind}>Added</span>
                      <span className={styles.title}>{line.title}</span>
                      <span className={styles.detail}>{qtyPrice(line)}</span>
                      <span className={styles.amount}>+{formatCents(line.lineTotalCents)}</span>
                    </li>
                  ))}
                  {d.removed.map((line) => (
                    <li key={`r-${line.channel3ProductId}`} className={styles.removed}>
                      <span className={styles.kind}>Removed</span>
                      <span className={styles.title}>{line.title}</span>
                      <span className={styles.detail}>{qtyPrice(line)}</span>
                      <span className={styles.amount}>−{formatCents(line.lineTotalCents)}</span>
                    </li>
                  ))}
                  {d.changed.map((line) => {
                    const delta = line.lineTotalCents - line.before.lineTotalCents;
                    const parts = [];
                    if (line.quantity !== line.before.quantity) parts.push(`Qty ${line.before.quantity} → ${line.quantity}`);
                    if (line.unitPriceCents !== line.before.unitPriceCents) {
                      parts.push(`Price ${formatCents(line.before.unitPriceCents)} → ${formatCents(line.unitPriceCents)}`);
                    }
                    return (
                      <li key={`c-${line.channel3ProductId}`} className={styles.changed}>
                        <span className={styles.kind}>Changed</span>
                        <span className={styles.title}>{line.title}</span>
                        <span className={styles.detail}>{parts.join(" · ")}</span>
                        <span className={styles.amount}>
                          {delta >= 0 ? "+" : "−"}
                          {formatCents(Math.abs(delta))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {d.unchangedCount > 0 && d.added.length + d.removed.length + d.changed.length > 0 && (
                <p className="muted">
                  {d.unchangedCount} other {d.unchangedCount === 1 ? "item is" : "items are"} unchanged.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
