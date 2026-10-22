import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listRequests } from "../api/requests";
import { StatusBadge } from "../components/StatusBadge";
import { formatCents, formatDate } from "../lib/format";
import styles from "./RequestsPage.module.css";

export function RequestsPage() {
  const requests = useQuery({ queryKey: ["requests"], queryFn: listRequests });

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

      {requests.isPending && <p className="muted">Loading…</p>}
      {requests.error && <p className="error">{requests.error.message}</p>}
      {requests.data?.length === 0 && (
        <div className={styles.empty}>
          <p className="muted">No requests yet.</p>
          <Link to="/requests/new" className="button primary">
            Create your first request
          </Link>
        </div>
      )}
      <ul className={styles.list}>
        {requests.data?.map((request) => (
          <li key={request.id}>
            <Link to={`/requests/${request.id}`} className={styles.item}>
              <div className={styles.itemTop}>
                <span className={styles.prompt}>{request.prompt}</span>
                <StatusBadge status={request.status} />
              </div>
              <div className={styles.meta}>
                <span>{request.latestVersion ? `v${request.latestVersion}` : "No sheet yet"}</span>
                {request.budgetCents !== null && <span>Budget {formatCents(request.budgetCents)}</span>}
                <span>{formatDate(request.createdAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
