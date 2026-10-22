import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { deleteRequest, getVersion, listVersions } from "../api/requests";
import { AddProductDrawer } from "../components/AddProductDrawer";
import { AgentPanel } from "../components/AgentPanel";
import { PaymentCard } from "../components/PaymentCard";
import { SheetGrid } from "../components/SheetGrid";
import { StatusBadge } from "../components/StatusBadge";
import { VersionDiffPanel } from "../components/VersionDiffPanel";
import { VersionTimeline } from "../components/VersionTimeline";
import { useRequestWorkspace } from "../hooks/useRequestWorkspace";
import { formatCents, formatDate } from "../lib/format";
import type { GenerateResult, VersionItem } from "../types/api";
import styles from "./RequestPage.module.css";

export function RequestPage() {
  const { id = "" } = useParams();
  const ws = useRequestWorkspace(id);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const [agentResult, setAgentResult] = useState<GenerateResult | null>(null);
  const [compareFocus, setCompareFocus] = useState<{ against: number; nonce: number } | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteRequest(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["request", id] });
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
      navigate("/requests", { replace: true });
    },
  });

  const latestVersion = ws.query.data?.latestVersion ?? null;
  const latestNumber = latestVersion?.number ?? 0;
  const requested = Number(searchParams.get("v"));
  const viewingNumber =
    Number.isInteger(requested) && requested >= 1 && requested < latestNumber ? requested : latestNumber;
  const viewingOld = viewingNumber !== latestNumber;

  const versions = useQuery({
    queryKey: ["request", id, "versions"],
    queryFn: () => listVersions(id),
    enabled: latestNumber > 0,
  });
  const oldVersion = useQuery({
    queryKey: ["request", id, "version", viewingNumber],
    queryFn: () => getVersion(id, viewingNumber),
    enabled: viewingOld,
  });

  const selectVersion = useCallback(
    (n: number) =>
      setSearchParams(
        (params) => {
          if (n === latestNumber) params.delete("v");
          else params.set("v", String(n));
          return params;
        },
        { replace: true },
      ),
    [latestNumber, setSearchParams],
  );

  const version = viewingOld ? (oldVersion.data ?? null) : latestVersion;
  const existingIds = useMemo(() => new Set(version?.items.map((i) => i.channel3ProductId)), [version]);

  if (ws.query.isPending) return <p className="muted">Loading request…</p>;
  if (ws.query.error) return <p className="error">{ws.query.error.message}</p>;

  const { request } = ws.query.data;
  const editable = request.status === "draft" && !viewingOld;
  const budget = version?.budget ?? { budgetCents: request.budgetCents, remainingCents: null, overBudget: false };
  const total = version?.totalCents ?? 0;
  const usedPct = budget.budgetCents ? Math.min(100, Math.round((total / budget.budgetCents) * 100)) : 0;

  const onQuantityChange = (item: VersionItem, quantity: number) =>
    version && ws.updateQuantity.mutate({ n: version.number, itemId: item.id, quantity, revision: version.revision });
  const onGenerate = (instruction: string | undefined) =>
    ws.generate.mutate(
      { instruction, expectedLatestVersion: latestNumber },
      {
        onSuccess: (result) => {
          setAgentResult(result);
          setCompareFocus(null);
        },
      },
    );

  const onDelete = () => {
    const note = request.status === "approved" ? " Its approval and any unpaid PayPal order will be cancelled." : "";
    const scope = latestNumber === 0 ? "" : latestNumber === 1 ? " and its version" : ` and all ${latestNumber} versions`;
    if (window.confirm(`Delete this request${scope}?${note} This can't be undone.`)) remove.mutate();
  };
  const onRemove = (item: VersionItem) =>
    version && ws.removeItem.mutate({ n: version.number, itemId: item.id, revision: version.revision });

  return (
    <div className={styles.page}>
      <Link to="/requests" className={styles.back}>
        ← All requests
      </Link>

      <section className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.prompt}>{request.prompt}</h1>
          <div className={styles.titleActions}>
            <StatusBadge status={request.status} />
            {request.status !== "paid" && (
              <button type="button" className="danger" onClick={onDelete} disabled={remove.isPending || ws.busy}>
                {remove.isPending ? "Deleting…" : "Delete request"}
              </button>
            )}
          </div>
        </div>
        {remove.error && <p className="error">{remove.error.message}</p>}
        {request.summary && <p className="muted">{request.summary}</p>}
        <p className={styles.meta}>
          Created {formatDate(request.createdAt)}
          {version && (
            <>
              {" · "}Viewing version {version.number} of {latestNumber} · revision {version.revision}
            </>
          )}
        </p>
      </section>

      <section className={styles.stats}>
        <div className={styles.stat}>
          <span>Items</span>
          <strong>{version?.items.length ?? 0}</strong>
        </div>
        <div className={styles.stat}>
          <span>Total</span>
          <strong>{formatCents(total)}</strong>
        </div>
        <div className={`${styles.stat} ${styles.budgetStat}`}>
          <span>Budget</span>
          {budget.budgetCents ? (
            <>
              <strong className={budget.overBudget ? styles.over : undefined}>
                {budget.overBudget
                  ? `${formatCents(-(budget.remainingCents ?? 0))} over`
                  : `${formatCents(budget.remainingCents ?? budget.budgetCents)} left`}
              </strong>
              <div className={styles.bar} aria-label={`${usedPct}% of budget used`}>
                <div
                  className={`${styles.barFill} ${budget.overBudget ? styles.barOver : ""}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <small className="muted">
                {formatCents(total)} of {formatCents(budget.budgetCents)}
              </small>
            </>
          ) : (
            <strong className="muted">No budget set</strong>
          )}
        </div>
      </section>

      {ws.notice && (
        <div className={styles.notice} role="alert">
          <span>{ws.notice}</span>
          <button onClick={ws.clearNotice} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {request.status === "draft" && !viewingOld && (
        <AgentPanel
          hasSheet={latestNumber > 0}
          budgetCents={request.budgetCents}
          latestNumber={latestNumber}
          viewingNumber={viewingNumber}
          pending={ws.generate.isPending}
          disabled={ws.busy && !ws.generate.isPending}
          error={ws.generate.error}
          result={agentResult}
          onGenerate={onGenerate}
          onCompare={(_, against) => setCompareFocus({ against, nonce: Date.now() })}
          onDismissResult={() => setAgentResult(null)}
        />
      )}

      {versions.data && versions.data.length > 0 && (
        <VersionTimeline
          versions={versions.data}
          latest={latestNumber}
          viewing={viewingNumber}
          approvedVersion={request.approvedVersion}
          canCopy={request.status === "draft"}
          copying={ws.copyVersion.isPending}
          onSelect={selectVersion}
          onCopy={async (summary) => {
            await ws.copyVersion.mutateAsync({
              n: viewingNumber,
              summary: summary || undefined,
              expectedLatestVersion: latestNumber,
            });
            setSearchParams(
              (params) => {
                params.delete("v");
                return params;
              },
              { replace: true },
            );
          }}
        />
      )}

      {viewingOld ? (
        <div className={styles.historic}>
          <span>
            You're viewing <strong>v{viewingNumber}</strong>, an older version. It's read-only.
          </span>
          <button onClick={() => selectVersion(latestNumber)}>Back to latest (v{latestNumber})</button>
        </div>
      ) : (
        request.status !== "draft" && (
          <div className={styles.locked}>
            This request is <strong>{request.status}</strong>, so the sheet is read-only.
          </div>
        )
      )}

      {versions.data && (
        <VersionDiffPanel
          requestId={id}
          versions={versions.data}
          viewing={viewingNumber}
          latest={latestNumber}
          focus={compareFocus}
        />
      )}

      {versions.data && versions.data.length > 0 && (
        <PaymentCard request={request} viewing={version} versions={versions.data} />
      )}

      <section className={styles.sheet}>
        <div className={styles.sheetHead}>
          <h2>Sheet</h2>
          <div className={styles.sheetActions}>
            {ws.busy && <span className="muted">Saving…</span>}
            {editable && (
              <button className="primary" onClick={() => setDrawerOpen(true)}>
                + Add products
              </button>
            )}
          </div>
        </div>

        {viewingOld && oldVersion.isPending ? (
          <p className="muted">Loading v{viewingNumber}…</p>
        ) : oldVersion.error && viewingOld ? (
          <p className="error">{oldVersion.error.message}</p>
        ) : version && version.items.length > 0 ? (
          <SheetGrid
            items={version.items}
            totalCents={version.totalCents}
            editable={editable && !ws.busy}
            onQuantityChange={onQuantityChange}
            onRemove={onRemove}
          />
        ) : (
          <div className={styles.empty}>
            <p>
              <strong>No items yet.</strong>
            </p>
            <p className="muted">
              {editable ? "Ask the agent above to build it, or add products by hand." : "This version has no items."}
            </p>
            {editable && (
              <button className="primary" onClick={() => setDrawerOpen(true)}>
                Search products
              </button>
            )}
          </div>
        )}
      </section>

      <AddProductDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        existingProductIds={existingIds}
        adding={ws.addProduct.isPending}
        onAdd={(product, quantity) =>
          ws.addProduct.mutateAsync({ channel3ProductId: product.channel3ProductId, quantity, version })
        }
      />
    </div>
  );
}
