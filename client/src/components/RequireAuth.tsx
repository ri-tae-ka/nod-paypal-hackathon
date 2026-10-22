import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useMe } from "../hooks/useAuth";

export function RequireAuth() {
  const { data: user, isPending, error } = useMe();
  const location = useLocation();

  if (isPending) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error.message}</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
