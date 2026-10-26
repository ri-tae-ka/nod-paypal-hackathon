import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cancelPool, openPool, ownerContributions } from "../api/pools";
import { formatCents, formatDate } from "../lib/format";
import type { Member, Pool, ProcurementRequest } from "../types/api";
import styles from "./PoolPanel.module.css";
import { PoolProgress } from "./PoolProgress";

interface Props {
  request: ProcurementRequest;
  pool: Pool | null;
  members: Member[];
}

const DEADLINES = [
  { days: 0, label: "No deadline" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
];

export const poolIsLive = (pool: Pool | null | undefined) =>
  !!pool && (pool.status === "open" || pool.status === "closing" || pool.status === "funded");

/** Owner-side card: offer to crowdfund an approved sheet, then track and manage the pool. */
export function PoolPanel({ request, pool, members }: Props) {
  const isOwner = request.role !== "member";
  if (poolIsLive(pool)) return <LivePool request={request} pool={pool!} isOwner={isOwner} />;
  const canOpen = isOwner && request.status === "approved" && members.length <= 1;
  if (!canOpen) return null;
  return <OpenPool request={request} lastPool={pool} />;
}

function useInvalidate(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["request", id] });
    void queryClient.invalidateQueries({ queryKey: ["requests"] });
  };
}

function OpenPool({ request, lastPool }: { request: ProcurementRequest; lastPool: Pool | null }) {
  const [expanded, setExpanded] = useState(false);
  const [story, setStory] = useState("");
  const [days, setDays] = useState(14);
  const invalidate = useInvalidate(request.id);
  const open = useMutation({
    mutationFn: () =>
      openPool(request.id, {
        ...(story.trim() && { story: story.trim() }),
        ...(days > 0 && { deadline: new Date(Date.now() + days * 86_400_000).toISOString() }),
      }),
    onSuccess: invalidate,
  });

  return (
    <section className={`${styles.card} ${styles.offer}`} aria-label="Community pool">
      <div className={styles.row}>
        <div>
          <span className={styles.kicker}>Community pool</span>
          <h2 className={styles.title}>Raise it together instead</h2>
          <p className={styles.sub}>
            Share a public link so neighbours, classmates or donors can chip in toward v{request.approvedVersion}, no Nod
            account needed. All or nothing: if you cancel or the deadline passes, everyone is refunded through PayPal.
          </p>
          {lastPool && (
            <p className={styles.sub}>
              Your last pool was {lastPool.status} {lastPool.closedAt ? `on ${formatDate(lastPool.closedAt)}` : ""}; its
              contributions were refunded.
            </p>
          )}
        </div>
        {!expanded && (
          <button type="button" onClick={() => setExpanded(true)}>
            Open a community pool
          </button>
        )}
      </div>
      {expanded && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            open.mutate();
          }}
        >
          <label>
            <span>
              Why does this matter? <span className="muted">(optional; the AI uses it to write your pitch)</span>
            </span>
            <textarea
              rows={3}
              maxLength={2000}
              value={story}
              onChange={(e) => setStory(e.target.value)}
              placeholder="e.g. Our block is building a shared pollinator garden for the school next door."
            />
          </label>
          <fieldset className={styles.deadlines}>
            <legend>Deadline</legend>
            {DEADLINES.map((d) => (
              <label key={d.days} className={days === d.days ? styles.chipOn : styles.chip}>
                <input type="radio" name="deadline" checked={days === d.days} onChange={() => setDays(d.days)} />
                {d.label}
              </label>
            ))}
          </fieldset>
          <div className={styles.actions}>
            <button type="button" onClick={() => setExpanded(false)} disabled={open.isPending}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={open.isPending}>
              {open.isPending ? "Writing your pitch…" : "Open pool and get link"}
            </button>
          </div>
          {open.error && <p className="error">{open.error.message}</p>}
        </form>
      )}
    </section>
  );
}

function LivePool({ request, pool, isOwner }: { request: ProcurementRequest; pool: Pool; isOwner: boolean }) {
  const invalidate = useInvalidate(request.id);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/pool/${pool.token}`;
  const contributions = useQuery({
    queryKey: ["request", request.id, "pool-contributions"],
    queryFn: () => ownerContributions(request.id),
    enabled: isOwner,
    refetchInterval: pool.status === "open" ? 15_000 : false,
  });
  const cancel = useMutation({
    mutationFn: () => cancelPool(request.id),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const supporters = (contributions.data ?? []).filter((c) => c.status === "completed");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", link);
    }
  };
  const onCancel = () => {
    const note = pool.raisedCents
      ? ` ${formatCents(pool.raisedCents)} from ${pool.contributorCount} supporter${pool.contributorCount === 1 ? "" : "s"} will be refunded through PayPal.`
      : "";
    if (window.confirm(`Cancel this pool?${note} The request goes back to draft.`)) cancel.mutate();
  };

  return (
    <section className={`${styles.card} ${pool.status === "funded" ? styles.funded : ""}`} aria-label="Community pool">
      <div className={styles.row}>
        <div>
          <span className={styles.kicker}>Community pool · v{pool.versionNumber}</span>
          <h2 className={styles.title}>{pool.status === "funded" ? "Fully funded!" : "Your pool is live"}</h2>
          {pool.pitch && <p className={styles.pitch}>“{pool.pitch}”</p>}
        </div>
        <a className={styles.viewLink} href={`/pool/${pool.token}`} target="_blank" rel="noreferrer">
          View public page ↗
        </a>
      </div>
      <PoolProgress pool={pool} />
      {pool.status === "open" && (
        <div className={styles.share}>
          <input readOnly value={link} aria-label="Public pool link" onFocus={(e) => e.target.select()} />
          <button type="button" className="primary" onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </button>
        </div>
      )}
      {supporters.length > 0 && (
        <ul className={styles.supporters} aria-label="Supporters">
          {supporters.slice(0, 8).map((c) => (
            <li key={c.id}>
              <span>
                <strong>{c.name}</strong>
                {c.message && <span className="muted"> · {c.message}</span>}
              </span>
              <span>{formatCents(c.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {isOwner && pool.status === "open" && (
        <div className={styles.actions}>
          <span className="muted">
            {pool.deadline ? `Closes ${formatDate(pool.deadline)}` : "No deadline"} · funds settle when the goal is met
          </span>
          <button type="button" className="danger" onClick={onCancel} disabled={cancel.isPending}>
            {cancel.isPending ? "Refunding…" : pool.raisedCents ? "Cancel & refund everyone" : "Cancel pool"}
          </button>
        </div>
      )}
      {cancel.error && <p className="error">{cancel.error.message}</p>}
    </section>
  );
}
