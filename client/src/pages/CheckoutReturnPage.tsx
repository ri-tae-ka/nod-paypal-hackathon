import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { capturePayment } from "../api/payments";

/** Landing page for PayPal's redirect flow: captures on return, or just goes back on cancel. */
export function CheckoutReturnPage({
  cancelled = false,
}: {
  cancelled?: boolean;
}) {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const orderId = params.get("token");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const back = () => {
      void queryClient.invalidateQueries({ queryKey: ["request", id] });
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
      navigate(`/requests/${id}`, {
        replace: true,
        state: cancelled ? { paymentCancelled: true } : undefined,
      });
    };
    if (cancelled || !orderId) return back();
    capturePayment(orderId).then(back, (e: Error) => setError(e.message));
  }, [cancelled, orderId, id, navigate, queryClient]);

  return (
    <div style={{ display: "grid", gap: "0.75rem", justifyItems: "start" }}>
      {error ? (
        <>
          <p className="error">{error}</p>
          <Link to={`/requests/${id}`}>Back to the request</Link>
        </>
      ) : (
        <p className="muted">
          {cancelled
            ? "Returning to your request…"
            : "Confirming your payment with PayPal…"}
        </p>
      )}
    </div>
  );
}
