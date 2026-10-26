import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listRequests } from "../api/requests";
import { RequestsGrid } from "../components/RequestsGrid";
import styles from "./RequestsPage.module.css";

export function RequestsPage() {
  const requests = useQuery({ queryKey: ["requests"], queryFn: listRequests });
  const [tab, setTab] = useState<"all" | "mine" | "group" | "pool">("all");

  const all = requests.data ?? [];
  const isGroup = (request: (typeof all)[number]) => request.memberCount > 1;
  const isPool = (request: (typeof all)[number]) => !!request.poolStatus;
  const kind = (r: (typeof all)[number]) => (isPool(r) ? "pool" : isGroup(r) ? "group" : "mine");
  const counts = {
    all: all.length,
    mine: all.filter((r) => kind(r) === "mine").length,
    group: all.filter((r) => kind(r) === "group").length,
    pool: all.filter((r) => kind(r) === "pool").length,
  };
  const shown = all.filter((r) => tab === "all" || kind(r) === tab);
  const tabs = [
    ["all", "All"],
    ["mine", "Solo"],
    ["group", "Group"],
    ["pool", "Pools"],
  ] as const;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>My requests</h1>
          <p className="muted">Open a request to edit its sheet, review versions, approve and pay.</p>
        </div>
        <Link to="/requests/new" className="button primary">
          New request
        </Link>
      </div>

      <div className={styles.tabs} role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => setTab(key)}
          >
            {label} <span className={styles.count}>{counts[key]}</span>
          </button>
        ))}
      </div>

      {requests.isPending && <p className="muted">Loading…</p>}
      {requests.error && <p className="error">{requests.error.message}</p>}
      {requests.data && requests.data.length > 0 && shown.length === 0 && (
        <p className="muted">{tab === "group" ? "No group requests yet. Open a request and invite people to make one." : "Nothing here."}</p>
      )}
      {requests.data?.length === 0 && (
        <div className={styles.empty}>
          <p className="muted">No requests yet.</p>
          <Link to="/requests/new" className="button primary">
            Create your first request
          </Link>
        </div>
      )}
      {shown.length > 0 && <RequestsGrid requests={shown} />}
    </div>
  );
}
