import type { RequestStatus } from "../types/api";
import styles from "./StatusBadge.module.css";

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`${styles.badge} ${styles[status]}`}>{status}</span>;
}
