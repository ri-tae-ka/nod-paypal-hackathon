import { formatCents } from "../lib/format";
import type { Pool } from "../types/api";
import styles from "./PoolProgress.module.css";

export function daysLeft(deadline: string | null): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return "Deadline passed";
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  return `${Math.ceil(hours / 24)} days left`;
}

/** Raised vs goal, readable by screen readers as a progress bar. */
export function PoolProgress({ pool, large = false }: { pool: Pool; large?: boolean }) {
  const pct = Math.min(100, Math.floor((pool.raisedCents / pool.goalCents) * 100));
  const left = daysLeft(pool.deadline);
  return (
    <div className={`${styles.wrap} ${large ? styles.large : ""}`}>
      <div className={styles.numbers}>
        <strong>{formatCents(pool.raisedCents)}</strong>
        <span>raised of {formatCents(pool.goalCents)}</span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label="Funding progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${formatCents(pool.raisedCents)} of ${formatCents(pool.goalCents)} raised, ${pct} percent`}
      >
        <div className={`${styles.fill} ${pool.status === "funded" ? styles.funded : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.meta}>
        <span>{pct}% funded</span>
        <span>
          {pool.contributorCount} supporter{pool.contributorCount === 1 ? "" : "s"}
        </span>
        {pool.status === "open" && left && <span>{left}</span>}
      </div>
    </div>
  );
}
