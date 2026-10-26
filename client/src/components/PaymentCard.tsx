import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import {
  approveVersion,
  cancelGroupPayment,
  checkout,
  listPayments,
  setShares,
  unapprove,
  withdrawNod,
} from "../api/payments";
import { formatCents, formatDate } from "../lib/format";
import type {
  Member,
  Payment,
  ProcurementRequest,
  Version,
  VersionSummary,
} from "../types/api";
import styles from "./PaymentCard.module.css";

interface Props {
  request: ProcurementRequest;
  /** The version currently on screen (the approve candidate while in draft). */
  viewing: Version | null;
  versions: VersionSummary[];
  members: Member[];
  meId: string;
}

function useInvalidateRequest(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["request", id] });
    void queryClient.invalidateQueries({ queryKey: ["requests"] });
  };
}

function approveBlocker(
  request: ProcurementRequest,
  version: Version | null,
): string | null {
  if (!version || version.items.length === 0)
    return "Add items to the sheet before approving.";
  const outOfStock = version.items.filter(
    (i) => i.availability !== "InStock",
  ).length;
  if (outOfStock)
    return `Remove or replace ${outOfStock} out-of-stock ${outOfStock === 1 ? "item" : "items"} first.`;
  if (request.budgetCents && version.totalCents > request.budgetCents) {
    return `This version is ${formatCents(version.totalCents - request.budgetCents)} over budget.`;
  }
  return null;
}

export function PaymentCard({ request, viewing, versions, members, meId }: Props) {
  if (request.status === "draft")
    return <ApproveStep request={request} version={viewing} members={members} meId={meId} />;
  const approved =
    versions.find((v) => v.number === request.approvedVersion) ?? null;
  return <PayStep request={request} approved={approved} members={members} meId={meId} />;
}

function ApproveStep({
  request,
  version,
  members,
  meId,
}: {
  request: ProcurementRequest;
  version: Version | null;
  members: Member[];
  meId: string;
}) {
  const isGroup = members.length > 1;
  const nods = version?.nods ?? [];
  const iNodded = nods.includes(meId);
  const waiting = members.filter((m) => !nods.includes(m.userId));
  const invalidate = useInvalidateRequest(request.id);
  const withdraw = useMutation({
    mutationFn: (v: Version) => withdrawNod(request.id, v.number),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const approve = useMutation({
    mutationFn: (v: Version) =>
      approveVersion(request.id, v.number, v.revision),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const blocker = approveBlocker(request, version);

  return (
    <section className={styles.card} aria-label="Review and pay">
      <div className={styles.steps} aria-hidden>
        <span className={styles.active}>1 · Approve</span>
        <span>2 · Pay with PayPal</span>
        <span>3 · Receipt</span>
      </div>
      <div className={styles.row}>
        <div>
          <h2 className={styles.title}>Ready to buy?</h2>
          <p className={styles.sub}>
            {isGroup
              ? "Everyone in the group has to nod on this exact version. Any edit resets the nods."
              : "Approving signs off exactly this version and locks the sheet. You can unapprove any time before paying."}
          </p>
          {isGroup && (
            <p className={styles.sub}>
              <strong>
                {members.length - waiting.length} of {members.length} nodded
              </strong>
              {waiting.length > 0 && <> · waiting on {waiting.map((m) => m.displayName).join(", ")}</>}
            </p>
          )}
        </div>
        {iNodded && version ? (
          <button type="button" onClick={() => withdraw.mutate(version)} disabled={withdraw.isPending}>
            {withdraw.isPending ? "Withdrawing…" : "Withdraw my nod"}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!!blocker || approve.isPending || !version}
            onClick={() => version && approve.mutate(version)}
          >
            {approve.isPending
              ? "Approving…"
              : version
                ? `${isGroup ? "Nod" : "Approve"} v${version.number} · ${formatCents(version.totalCents)}`
                : "Approve"}
          </button>
        )}
      </div>
      {blocker && <p className={styles.hint}>{blocker}</p>}
      {approve.error && <p className="error">{approve.error.message}</p>}
    </section>
  );
}

function PayStep({
  request,
  approved,
  members,
  meId,
}: {
  request: ProcurementRequest;
  approved: VersionSummary | null;
  members: Member[];
  meId: string;
}) {
  const isGroup = members.length > 1;
  const isOwner = request.role !== "member";
  const invalidate = useInvalidateRequest(request.id);
  const payments = useQuery({
    queryKey: ["request", request.id, "payments"],
    queryFn: () => listPayments(request.id),
  });
  const mine = (payments.data ?? []).filter((p) => !isGroup || p.userId === meId);
  const completed = mine.find((p) => p.status === "completed");
  const pending = mine.find((p) => p.status === "pending" || p.status === "capturing");
  const paidIds = new Set((payments.data ?? []).filter((p) => p.status === "completed").map((p) => p.userId));
  const myShare = members.find((m) => m.userId === meId)?.shareCents ?? null;

  const groupStatus = isGroup && (
    <GroupStatus
      request={request}
      members={members}
      paidIds={paidIds}
      isOwner={isOwner}
      anyPaid={paidIds.size > 0}
      onDone={invalidate}
    />
  );

  if (request.status === "paid" || completed) {
    return (
      <>
        {completed ? <Receipt payment={completed} /> : <section className={styles.card}>Loading receipt…</section>}
        {groupStatus}
      </>
    );
  }
  if (pending) {
    return (
      <>
      <section className={styles.card} aria-label="Payment status">
        <h2 className={styles.title}>
          Payment{" "}
          {pending.status === "pending"
            ? "pending at PayPal"
            : "being captured"}
        </h2>
        <p className={styles.sub}>
          {formatCents(pending.amountCents)} for v{pending.versionNumber}.
          PayPal is still processing this payment; check back shortly.
        </p>
        <button type="button" onClick={invalidate}>
          Refresh status
        </button>
      </section>
      {groupStatus}
      </>
    );
  }
  return (
    <>
      <Checkout request={request} approved={approved} onDone={invalidate} shareCents={isGroup ? myShare : null} isGroup={isGroup} />
      {groupStatus}
    </>
  );
}

/** Splits totalCents by basis-point weights using largest remainder so the parts sum exactly. */
function splitCents(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sum);
  const parts = exact.map(Math.floor);
  let left = totalCents - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((x, y) => y.frac - x.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}

function GroupStatus({
  request,
  members,
  paidIds,
  isOwner,
  anyPaid,
  onDone,
}: {
  request: ProcurementRequest;
  members: Member[];
  paidIds: Set<string | undefined>;
  isOwner: boolean;
  anyPaid: boolean;
  onDone: () => void;
}) {
  const cancel = useMutation({
    mutationFn: () => cancelGroupPayment(request.id),
    onSuccess: onDone,
    onError: onDone,
  });
  const paidCount = members.filter((m) => paidIds.has(m.userId)).length;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const total = members.reduce((sum, m) => sum + (m.shareCents ?? 0), 0);
  const bp = (v: string | undefined) => {
    const n = Math.round(parseFloat(v || "0") * 100);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const percentTotal = members.reduce((sum, m) => sum + bp(draft[m.userId]), 0);
  const cents = splitCents(total, members.map((m) => bp(draft[m.userId])));
  const save = useMutation({
    mutationFn: () => setShares(request.id, members.map((m, i) => ({ userId: m.userId, amountCents: cents[i] ?? 0 }))),
    onSuccess: () => {
      setEditing(false);
      onDone();
    },
  });
  const startEdit = () => {
    const n = members.length;
    const base = Math.floor(10000 / n);
    const extra = 10000 - base * n;
    setDraft(Object.fromEntries(members.map((m, i) => [m.userId, ((base + (i < extra ? 1 : 0)) / 100).toFixed(2)])));
    setEditing(true);
  };
  const canEdit = isOwner && request.status === "approved" && !anyPaid && !editing;
  return (
    <section className={styles.card} aria-label="Group payments">
      <h2 className={styles.title}>
        {paidCount} of {members.length} paid
      </h2>
      <ul className={styles.shares}>
        {members.map((m) => (
          <li key={m.userId}>
            <span>{m.displayName}</span>
            {editing ? (
              <span className={styles.pctEdit}>
                <input
                  className={styles.shareInput}
                  inputMode="decimal"
                  aria-label={`${m.displayName}'s share percent`}
                  value={draft[m.userId] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [m.userId]: e.target.value })}
                />
                % = {formatCents(cents[members.indexOf(m)] ?? 0)}
              </span>
            ) : (
              <span>{m.shareCents != null ? formatCents(m.shareCents) : "—"}</span>
            )}
            <span className={paidIds.has(m.userId) ? styles.paidTag : styles.dueTag}>
              {paidIds.has(m.userId) ? "Paid" : "Due"}
            </span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className={styles.actionBar}>
          <button type="button" onClick={startEdit}>Edit split</button>
        </div>
      )}
      {editing && (
        <div className={styles.actionBar}>
          <span className={percentTotal === 10000 ? styles.paidTag : styles.dueTag}>
            {percentTotal === 10000
              ? "Adds up to 100%"
              : `${(Math.abs(10000 - percentTotal) / 100).toFixed(2)}% ${percentTotal < 10000 ? "left to assign" : "over"}`}
          </span>
          <span>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>{" "}
            <button type="button" className="primary" disabled={percentTotal !== 10000 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save split"}
            </button>
          </span>
        </div>
      )}
      {save.error && <p className="error">{save.error.message}</p>}
      {isOwner && anyPaid && request.status !== "draft" && (
        <div className={styles.actionBar}>
          <button type="button" className="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "Refunding…" : "Cancel and refund paid shares"}
          </button>
        </div>
      )}
      {cancel.error && <p className="error">{cancel.error.message}</p>}
    </section>
  );
}

function Checkout({
  request,
  approved,
  onDone,
  shareCents,
  isGroup,
}: {
  request: ProcurementRequest;
  approved: VersionSummary | null;
  onDone: () => void;
  shareCents: number | null;
  isGroup: boolean;
}) {
  const location = useLocation();
  const cancelled =
    (location.state as { paymentCancelled?: boolean } | null)
      ?.paymentCancelled === true;
  const [error, setError] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: () => unapprove(request.id),
    onSuccess: onDone,
    onError: onDone,
  });
  const pay = useMutation({
    mutationFn: () => checkout(request.id),
    onMutate: () => setError(null),
    onSuccess: (payment) => {
      if (payment.approveUrl) window.location.assign(payment.approveUrl);
      else setError("PayPal didn't return an approval link. Please try again.");
    },
    onError: (e) => setError(e.message),
  });

  const amount = shareCents != null ? formatCents(shareCents) : approved ? formatCents(approved.totalCents) : "";
  // Stays "busy" after success too, while the browser leaves for PayPal.
  const leaving = pay.isPending || pay.isSuccess;

  return (
    <section className={styles.card} aria-label="Review and pay">
      <div className={styles.steps} aria-hidden>
        <span className={styles.done}>1 · Approved</span>
        <span className={styles.active}>2 · Pay with PayPal</span>
        <span>3 · Receipt</span>
      </div>
      <div className={styles.row}>
        <div>
          <h2 className={styles.title}>
            Pay {isGroup ? "your share, " : ""}{amount} for v{request.approvedVersion}
          </h2>
          <p className={styles.sub}>
            {approved
              ? `${approved.itemCount} ${approved.itemCount === 1 ? "item" : "items"} · `
              : ""}
            You'll finish on PayPal's <strong>sandbox</strong> site with a
            sandbox buyer account, then come back here for the receipt. No real
            money moves.
          </p>
        </div>
      </div>
      <div className={styles.actionBar}>
        <button
          type="button"
          onClick={() => revoke.mutate()}
          disabled={revoke.isPending || leaving}
        >
          {revoke.isPending ? "Unapproving…" : "Unapprove and edit"}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => pay.mutate()}
          disabled={leaving || revoke.isPending}
        >
          {leaving ? "Opening PayPal…" : `Pay ${amount} with PayPal`}
        </button>
      </div>
      {revoke.error && <p className="error">{revoke.error.message}</p>}
      {cancelled && !error && (
        <p className={styles.hint}>
          Payment cancelled on PayPal. Nothing was charged; you can try again.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
function Receipt({ payment }: { payment: Payment }) {
  return (
    <section
      className={`${styles.card} ${styles.receipt}`}
      aria-label="Payment receipt"
    >
      <div className={styles.steps} aria-hidden>
        <span className={styles.done}>1 · Approved</span>
        <span className={styles.done}>2 · Paid</span>
        <span className={styles.active}>3 · Receipt</span>
      </div>
      <div className={styles.receiptHead}>
        <span className={styles.check} aria-hidden>
          ✓
        </span>
        <div>
          <h2 className={styles.title}>
            Paid {formatCents(payment.amountCents)}
          </h2>
          <p className={styles.sub}>
            Version {payment.versionNumber} ·{" "}
            {payment.capturedAt
              ? formatDate(payment.capturedAt)
              : formatDate(payment.updatedAt)}{" "}
            · <span className={styles.sandbox}>PayPal sandbox</span>
          </p>
        </div>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Amount</dt>
          <dd>
            {formatCents(payment.amountCents)} {payment.currency}
          </dd>
        </div>
        <div>
          <dt>Payer</dt>
          <dd>{payment.payer?.email ?? payment.payer?.payerId ?? "—"}</dd>
        </div>
        <div>
          <dt>PayPal order</dt>
          <dd className={styles.mono}>{payment.paypalOrderId}</dd>
        </div>
        <div>
          <dt>Capture ID</dt>
          <dd className={styles.mono}>{payment.paypalCaptureId ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
