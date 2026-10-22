import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import {
  approveVersion,
  checkout,
  listPayments,
  unapprove,
} from "../api/payments";
import { formatCents, formatDate } from "../lib/format";
import type {
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

export function PaymentCard({ request, viewing, versions }: Props) {
  if (request.status === "draft")
    return <ApproveStep request={request} version={viewing} />;
  const approved =
    versions.find((v) => v.number === request.approvedVersion) ?? null;
  return <PayStep request={request} approved={approved} />;
}

function ApproveStep({
  request,
  version,
}: {
  request: ProcurementRequest;
  version: Version | null;
}) {
  const invalidate = useInvalidateRequest(request.id);
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
            Approving signs off exactly this version and locks the sheet. You
            can unapprove any time before paying.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={!!blocker || approve.isPending || !version}
          onClick={() => version && approve.mutate(version)}
        >
          {approve.isPending
            ? "Approving…"
            : version
              ? `Approve v${version.number} · ${formatCents(version.totalCents)}`
              : "Approve"}
        </button>
      </div>
      {blocker && <p className={styles.hint}>{blocker}</p>}
      {approve.error && <p className="error">{approve.error.message}</p>}
    </section>
  );
}

function PayStep({
  request,
  approved,
}: {
  request: ProcurementRequest;
  approved: VersionSummary | null;
}) {
  const invalidate = useInvalidateRequest(request.id);
  const payments = useQuery({
    queryKey: ["request", request.id, "payments"],
    queryFn: () => listPayments(request.id),
  });
  const completed = payments.data?.find((p) => p.status === "completed");
  const pending = payments.data?.find(
    (p) => p.status === "pending" || p.status === "capturing",
  );

  if (request.status === "paid" || completed) {
    return completed ? (
      <Receipt payment={completed} />
    ) : (
      <section className={styles.card}>Loading receipt…</section>
    );
  }
  if (pending) {
    return (
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
    );
  }
  return <Checkout request={request} approved={approved} onDone={invalidate} />;
}

function Checkout({
  request,
  approved,
  onDone,
}: {
  request: ProcurementRequest;
  approved: VersionSummary | null;
  onDone: () => void;
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

  const amount = approved ? formatCents(approved.totalCents) : "";
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
            Pay {amount} for v{request.approvedVersion}
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
