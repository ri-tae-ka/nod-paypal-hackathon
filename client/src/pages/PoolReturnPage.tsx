import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { captureContribution } from "../api/pools";

/** PayPal sends guests back here with ?token=ORDER_ID; capture, then show the pool with a thank-you. */
export function PoolReturnPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const orderId = params.get("token");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!orderId) {
      navigate(`/pool/${token}`, { replace: true });
      return;
    }
    captureContribution(token, orderId).then(
      ({ contribution }) => {
        void queryClient.invalidateQueries({ queryKey: ["pool", token] });
        navigate(`/pool/${token}`, {
          replace: true,
          state: { thanked: { amountCents: contribution.amountCents, name: contribution.name } },
        });
      },
      (e: Error) => setError(e.message),
    );
  }, [orderId, token, navigate, queryClient]);

  return (
    <div style={{ display: "grid", gap: "0.75rem", justifyItems: "start" }} aria-live="polite">
      {error ? (
        <>
          <p className="error">{error}</p>
          <Link to={`/pool/${token}`}>Back to the pool</Link>
        </>
      ) : (
        <p className="muted">Confirming your contribution with PayPal…</p>
      )}
    </div>
  );
}
