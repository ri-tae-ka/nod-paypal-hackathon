import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { contribute, getPool } from "../api/pools";
import { daysLeft, PoolProgress } from "../components/PoolProgress";
import { SheetGrid } from "../components/SheetGrid";
import { formatCents, formatDate, parseDollars } from "../lib/format";
import styles from "./PoolPage.module.css";

const PRESETS = [500, 1000, 2500];
const noop = () => {};

/** Public page anyone with the link can open: see what the money buys and chip in through PayPal. */
export function PoolPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const thanked = (location.state as { thanked?: { amountCents: number; name: string } } | null)?.thanked;
  const cancelled = params.get("cancelled") === "1";

  const query = useQuery({
    queryKey: ["pool", token],
    queryFn: () => getPool(token),
    refetchInterval: (q) => (q.state.data?.pool.status === "open" ? 20_000 : false),
  });

  if (query.isPending) return <p className="muted">Loading pool…</p>;
  if (query.error) {
    return (
      <div className={styles.missing}>
        <h1>Pool not found</h1>
        <p className="muted">This link may be mistyped, or the organiser removed the pool.</p>
        <Link to="/">Go to Nod</Link>
      </div>
    );
  }

  const { pool, items, supporters, minContributionCents } = query.data;
  const isOpen = pool.status === "open" && daysLeft(pool.deadline) !== "Deadline passed";
  const total = items.reduce((sum, item) => sum + item.lineTotalCents, 0);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <span className={styles.kicker}>Community pool · PayPal sandbox</span>
        <h1>{pool.title}</h1>
        <p className={styles.by}>
          Organised by <strong>{pool.organizer}</strong> · started {formatDate(pool.createdAt)}
        </p>
      </header>

      <div aria-live="polite">
        {thanked && (pool.status === "open" || pool.status === "funded") && (
          <div className={`${styles.banner} ${styles.thanks}`} role="status">
            <strong>Thank you{thanked.name !== "Anonymous" ? `, ${thanked.name}` : ""}!</strong> Your{" "}
            {formatCents(thanked.amountCents)} was captured through PayPal.
          </div>
        )}
        {cancelled && !thanked && (
          <div className={styles.banner} role="status">
            You cancelled on PayPal. Nothing was charged; you can try again any time.
          </div>
        )}
        {pool.status === "funded" && (
          <div className={`${styles.banner} ${styles.thanks}`} role="status">
            <strong>Fully funded!</strong> Thanks to {pool.contributorCount} supporter
            {pool.contributorCount === 1 ? "" : "s"}, {pool.organizer} can now buy everything on the list.
          </div>
        )}
        {(pool.status === "cancelled" || pool.status === "expired") && (
          <div className={`${styles.banner} ${styles.closed}`} role="status">
            This pool {pool.status === "expired" ? "reached its deadline" : "was cancelled by the organiser"} before the goal.
            Every contribution was refunded through PayPal.
          </div>
        )}
      </div>

      <div className={styles.layout}>
        <div className={styles.main}>
          {pool.pitch && (
            <section className={styles.card} aria-labelledby="pitch-heading">
              <h2 id="pitch-heading" className={styles.sectionTitle}>
                Why this matters {pool.pitchByAi && <span className={styles.ai}>✦ summarised by AI</span>}
              </h2>
              <p className={styles.pitch}>{pool.pitch}</p>
              {pool.story && (
                <details className={styles.story}>
                  <summary>Read the organiser's own words</summary>
                  <p>{pool.story}</p>
                </details>
              )}
            </section>
          )}
          <section className={styles.card} aria-labelledby="list-heading">
            <h2 id="list-heading" className={styles.sectionTitle}>
              What your money buys <span className="muted">· {items.length} item{items.length === 1 ? "" : "s"}, {formatCents(total)}</span>
            </h2>
            <p className="muted">
              This exact list was built by Nod's AI agent and approved by the organiser.
              {pool.status === "open" && " It can't change while the pool is open."}
            </p>
            <SheetGrid items={items} totalCents={total} editable={false} onQuantityChange={noop} onRemove={noop} />
          </section>
        </div>

        <aside className={styles.side}>
          <section className={styles.card} aria-label="Progress">
            <PoolProgress pool={pool} large />
            {isOpen && <ChipIn token={token} remainingCents={pool.remainingCents} minCents={minContributionCents} />}
            <p className={styles.fine}>
              All or nothing: if the goal isn't met by the deadline, or the organiser cancels, PayPal refunds everyone
              automatically. Sandbox only: use a PayPal sandbox buyer account, no real money moves.
            </p>
          </section>
          <section className={styles.card} aria-labelledby="supporters-heading">
            <h2 id="supporters-heading" className={styles.sectionTitle}>
              Supporters
            </h2>
            {supporters.length === 0 ? (
              <p className="muted">No one yet. Be the first!</p>
            ) : (
              <ul className={styles.supporters}>
                {supporters.map((s) => (
                  <li key={s.id}>
                    <span className={styles.avatar} aria-hidden>
                      {s.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <strong>{s.name}</strong> <span className="muted">{formatCents(s.amountCents)}</span>
                      {s.status === "refunded" && <span className={styles.refunded}> refunded</span>}
                      {s.message && <p>{s.message}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ChipIn({ token, remainingCents, minCents }: { token: string; remainingCents: number; minCents: number }) {
  const presets = useMemo(() => {
    const list = PRESETS.filter((p) => p < remainingCents);
    return [...list, remainingCents];
  }, [remainingCents]);
  const [selected, setSelected] = useState<number | "custom">(presets[Math.min(1, presets.length - 1)]!);
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [message, setMessage] = useState("");
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selected === "custom") customRef.current?.focus();
  }, [selected]);

  const amountCents = selected === "custom" ? parseDollars(custom) : selected;
  const minimum = Math.min(minCents, remainingCents);
  const invalid =
    amountCents === null
      ? "Enter an amount like 12 or 12.50."
      : amountCents < minimum
        ? `The minimum is ${formatCents(minimum)}.`
        : amountCents > remainingCents
          ? `Only ${formatCents(remainingCents)} is left to raise.`
          : null;

  const pay = useMutation({
    mutationFn: () =>
      contribute(token, {
        amountCents: amountCents!,
        ...(name.trim() && { name: name.trim() }),
        anonymous,
        ...(message.trim() && { message: message.trim() }),
      }),
    onSuccess: (result) => {
      if (result.approveUrl) window.location.assign(result.approveUrl);
    },
  });
  const leaving = pay.isPending || (pay.isSuccess && !!pay.data.approveUrl);

  return (
    <form
      className={styles.chipIn}
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) pay.mutate();
      }}
    >
      <fieldset className={styles.amounts}>
        <legend>Choose an amount</legend>
        {presets.map((cents, i) => (
          <label key={cents} className={selected === cents ? styles.amountOn : styles.amount}>
            <input type="radio" name="amount" checked={selected === cents} onChange={() => setSelected(cents)} />
            {i === presets.length - 1 && presets.length > 1 ? `Finish it: ${formatCents(cents)}` : formatCents(cents)}
          </label>
        ))}
        <label className={selected === "custom" ? styles.amountOn : styles.amount}>
          <input type="radio" name="amount" checked={selected === "custom"} onChange={() => setSelected("custom")} />
          Other
        </label>
      </fieldset>
      {selected === "custom" && (
        <label className={styles.field}>
          Amount in USD
          <input
            ref={customRef}
            inputMode="decimal"
            placeholder="e.g. 15"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-invalid={!!invalid}
            aria-describedby="amount-error"
          />
        </label>
      )}
      <label className={styles.field}>
        <span>
          Your name <span className="muted">(optional)</span>
        </span>
        <input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
        Show me as "Anonymous"
      </label>
      <label className={styles.field}>
        <span>
          Message <span className="muted">(optional)</span>
        </span>
        <input maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Good luck!" />
      </label>
      <p id="amount-error" className={styles.inlineError} aria-live="polite">
        {selected === "custom" && custom && invalid}
      </p>
      <button type="submit" className="primary" disabled={!!invalid || leaving}>
        {leaving ? "Opening PayPal…" : `Chip in ${amountCents && !invalid ? formatCents(amountCents) : ""} with PayPal`}
      </button>
      {pay.error && (
        <p className="error" role="alert">
          {pay.error.message}
        </p>
      )}
    </form>
  );
}
