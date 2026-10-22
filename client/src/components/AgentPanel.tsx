import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/http";
import { formatCents } from "../lib/format";
import type { GenerateResult, UnmetNeed } from "../types/api";
import styles from "./AgentPanel.module.css";

const QUICK_ACTIONS = [
  "Cut the total cost by 20% while keeping the essentials",
  "Upgrade to higher quality, better-rated products",
  "Bring the sheet within budget",
  "Find cheaper alternatives for the most expensive items",
  "Add anything important that's missing",
];

const PROGRESS = ["Planning what you need…", "Searching products on Channel3…", "Choosing the best matches…"];

interface Props {
  hasSheet: boolean;
  budgetCents: number | null;
  latestNumber: number;
  viewingNumber: number;
  pending: boolean;
  disabled: boolean;
  error: Error | null;
  result: GenerateResult | null;
  onGenerate: (instruction: string | undefined) => void;
  onCompare: (versionNumber: number, against: number) => void;
  onDismissResult: () => void;
}

function describeError(error: Error): { title: string; hint?: string; unmet?: UnmetNeed[] } {
  if (!(error instanceof ApiError)) return { title: error.message };
  switch (error.code) {
    case "ai_not_configured":
    case "ai_unavailable":
      return { title: "The AI agent can't be reached right now.", hint: "You can keep building the sheet by hand with “Add products”." };
    case "ai_busy":
      return { title: "The AI service is busy.", hint: "Wait a minute and try again." };
    case "ai_quota_exhausted":
      return { title: "The AI service is out of credits.", hint: "Add products by hand for now." };
    case "ai_limit_reached":
      return { title: error.message, hint: "Add products by hand for now." };
    case "ai_no_result": {
      const unmet = (error.details as { unmet?: UnmetNeed[] } | undefined)?.unmet;
      return { title: error.message, unmet };
    }
    case "version_conflict":
    case "request_locked":
      return { title: error.message, hint: "The sheet has been refreshed. Check it and try again." };
    default:
      return { title: error.message };
  }
}

export function AgentPanel(props: Props) {
  const { hasSheet, budgetCents, latestNumber, viewingNumber, pending, disabled, error, result } = props;
  const [instruction, setInstruction] = useState("");
  const [step, setStep] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!pending) return;
    setStep(0);
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, PROGRESS.length - 1)), 6000);
    return () => clearInterval(timer);
  }, [pending]);

  const trimmed = instruction.trim();
  const canSubmit = !pending && !disabled && (hasSheet ? trimmed.length >= 2 : trimmed.length === 0 || trimmed.length >= 2);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    props.onGenerate(trimmed || undefined);
  };

  useEffect(() => {
    if (result) setInstruction("");
  }, [result]);

  const pickAction = (text: string) => {
    setInstruction(text);
    inputRef.current?.focus();
  };

  const err = error ? describeError(error) : null;
  const showResult = result && result.version.number === viewingNumber && viewingNumber === latestNumber;

  return (
    <section className={styles.panel} aria-label="AI agent">
      <div className={styles.head}>
        <span className={styles.badge} aria-hidden>
          ✦
        </span>
        <div>
          <h2 className={styles.title}>{hasSheet ? "Ask the agent to revise the sheet" : "Let the agent build your sheet"}</h2>
          <p className={styles.sub}>
            {hasSheet
              ? `Each instruction creates v${latestNumber + 1}; v${latestNumber} stays untouched.`
              : `It plans what you need, searches real products and picks them${budgetCents ? ` within your ${formatCents(budgetCents)} budget` : ""}.`}
          </p>
        </div>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <textarea
          ref={inputRef}
          rows={2}
          maxLength={500}
          value={instruction}
          disabled={pending || disabled}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
          placeholder={
            hasSheet
              ? "e.g. Swap the chairs for something more ergonomic and keep us under budget"
              : "Optional: any preferences, e.g. prefer well-reviewed brands, white finishes"
          }
          aria-label="Instruction for the agent"
        />
        <button type="submit" className="primary" disabled={!canSubmit}>
          {pending ? "Working…" : hasSheet ? `Create v${latestNumber + 1}` : "Generate sheet"}
        </button>
      </form>

      {hasSheet && (
        <div className={styles.chips} role="group" aria-label="Quick actions">
          {QUICK_ACTIONS.map((text) => (
            <button key={text} type="button" className={styles.chip} onClick={() => pickAction(text)} disabled={pending || disabled}>
              {text}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <p className={styles.progress} role="status">
          <span className={styles.spinner} aria-hidden />
          {PROGRESS[step]} <span className="muted">This usually takes 10–40 seconds.</span>
        </p>
      )}

      {err && !pending && (
        <div className={styles.error} role="alert">
          <strong>{err.title}</strong>
          {err.hint && <span>{err.hint}</span>}
          {err.unmet && err.unmet.length > 0 && (
            <ul>
              {err.unmet.map((n) => (
                <li key={n.key}>{n.description}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showResult && !pending && (
        <div className={styles.result}>
          <div className={styles.resultHead}>
            <strong>Created v{result.version.number}</strong>
            <button type="button" className={styles.dismiss} onClick={props.onDismissResult} aria-label="Dismiss result">
              ✕
            </button>
          </div>
          {result.version.summary && <p className={styles.summary}>{result.version.summary}</p>}
          <p className={styles.facts}>
            {result.version.items.length} {result.version.items.length === 1 ? "item" : "items"} ·{" "}
            {formatCents(result.version.totalCents)}
            {result.diff && (
              <>
                {" · "}
                <span className={result.diff.totalDeltaCents < 0 ? styles.cheaper : result.diff.totalDeltaCents > 0 ? styles.pricier : undefined}>
                  {result.diff.totalDeltaCents === 0
                    ? "same total"
                    : `${result.diff.totalDeltaCents > 0 ? "+" : "−"}${formatCents(Math.abs(result.diff.totalDeltaCents))} vs v${result.diff.from.number}`}
                </span>
              </>
            )}
            {" · "}
            {result.agent.searches === 0
              ? "no new searches needed"
              : `${result.agent.searches} product ${result.agent.searches === 1 ? "search" : "searches"}`}
            <span className="muted"> · {result.agent.model}</span>
          </p>
          {result.agent.unmet.length > 0 && (
            <div className={styles.unmet}>
              <span>Couldn't fill:</span>
              <ul>
                {result.agent.unmet.map((n) => (
                  <li key={n.key}>
                    {n.description}
                    <span className="muted">
                      {n.reason === "no_results" ? " (no products found)" : " (nothing suitable in budget)"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.diff && (
            <button type="button" onClick={() => props.onCompare(result.version.number, result.diff!.from.number)}>
              Compare with v{result.diff.from.number}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
