import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRequest } from "../api/requests";
import { parseDollars } from "../lib/format";
import styles from "./RequestsPage.module.css";

export function NewRequestPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetError, setBudgetError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: createRequest,
    onSuccess: (request) => {
      queryClient.invalidateQueries({ queryKey: ["requests"] });
      navigate(`/requests/${request.id}`);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const budgetCents = budget.trim() ? parseDollars(budget) : undefined;
    if (budgetCents === null) return setBudgetError("Enter a dollar amount, e.g. 1500");
    setBudgetError(null);
    create.mutate({ prompt: prompt.trim(), ...(budgetCents && { budgetCents }) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>New request</h1>
          <p className="muted">Describe what you need. The agent will source products and build an editable sheet.</p>
        </div>
        <Link to="/requests" className="button">
          My requests
        </Link>
      </div>

      <section className={styles.panel}>
        <form className={styles.form} onSubmit={onSubmit}>
          <label>
            What do you need?
            <textarea
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Home office for 2 remote engineers: desks, ergonomic chairs, monitors, good lighting"
              required
              minLength={3}
              maxLength={4000}
            />
          </label>
          <label>
            Budget (USD, optional)
            <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="1500" inputMode="decimal" />
          </label>
          {budgetError && <p className="error">{budgetError}</p>}
          {create.error && <p className="error">{create.error.message}</p>}
          <div className={styles.formActions}>
            <button type="submit" className="primary" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create request"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
