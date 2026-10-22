import { useState, type FormEvent } from "react";
import { formatCents, formatDate } from "../lib/format";
import type { VersionSummary } from "../types/api";
import styles from "./VersionTimeline.module.css";

interface Props {
  versions: VersionSummary[];
  latest: number;
  viewing: number;
  approvedVersion: number | null;
  /** Whether a new version can be saved (request is still a draft). */
  canCopy: boolean;
  copying: boolean;
  onSelect: (n: number) => void;
  onCopy: (summary: string) => Promise<unknown>;
}

const label = (v: VersionSummary) =>
  v.summary ?? (v.instruction ? `“${v.instruction}”` : v.basedOnVersion ? `Based on v${v.basedOnVersion}` : "Untitled");

export function VersionTimeline({ versions, latest, viewing, approvedVersion, canCopy, copying, onSelect, onCopy }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [note, setNote] = useState("");
  const restoring = viewing !== latest;
  const viewed = versions.find((v) => v.number === viewing);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onCopy(note.trim());
      setNote("");
      setFormOpen(false);
    } catch {
      // The workspace hook shows the error notice
    }
  };

  return (
    <section className={styles.timeline} aria-label="Version history">
      <div className={styles.head}>
        <h2>Versions</h2>
        {canCopy && viewed && viewed.itemCount > 0 && !formOpen && (
          <button onClick={() => setFormOpen(true)}>
            {restoring ? `Restore v${viewing} as v${latest + 1}` : "Save as new version"}
          </button>
        )}
      </div>

      {formOpen && (
        <form className={styles.form} onSubmit={submit}>
          <span>
            {restoring ? `Copy v${viewing} into a new v${latest + 1}` : `Snapshot v${viewing} as v${latest + 1}`}
          </span>
          <input
            autoFocus
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Note (optional), e.g. "Before cutting costs"`}
          />
          <button type="submit" className="primary" disabled={copying}>
            {copying ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setFormOpen(false)} disabled={copying}>
            Cancel
          </button>
        </form>
      )}

      <ol className={styles.list}>
        {versions.map((v) => {
          const classes = [styles.card];
          if (v.number === viewing) classes.push(styles.active);
          return (
            <li key={v.number}>
              <button
                className={classes.join(" ")}
                onClick={() => onSelect(v.number)}
                aria-current={v.number === viewing ? "true" : undefined}
                title={formatDate(v.createdAt)}
              >
                <span className={styles.top}>
                  <strong>v{v.number}</strong>
                  {v.number === latest && <span className={styles.tagLatest}>Latest</span>}
                  {v.number === approvedVersion && <span className={styles.tagApproved}>Approved</span>}
                </span>
                <span className={styles.label}>{label(v)}</span>
                <span className={styles.meta}>
                  {v.itemCount} {v.itemCount === 1 ? "item" : "items"} · {formatCents(v.totalCents)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
