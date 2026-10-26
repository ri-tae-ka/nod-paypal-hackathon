import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { joinInvite, previewInvite } from "../api/requests";
import styles from "./JoinPage.module.css";

export function JoinPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => previewInvite(token), retry: false });
  const join = useMutation({
    mutationFn: () => joinInvite(token),
    onSuccess: (r) => navigate(`/requests/${r.requestId}`, { replace: true }),
  });

  if (preview.isPending) return <p className="muted">Loading invite…</p>;
  if (preview.error) {
    return (
      <div className={styles.card}>
        <h1>Invite not valid</h1>
        <p className="muted">This link was revoked or never existed. Ask for a fresh one.</p>
        <Link to="/requests">Back to my requests</Link>
      </div>
    );
  }
  const invite = preview.data;
  if (invite.alreadyMember) return <Navigate to={`/requests/${invite.requestId}`} replace />;
  const open = invite.status === "draft";

  return (
    <div className={styles.card}>
      <h1>{invite.ownerName} invited you to a Group Nod</h1>
      <blockquote>{invite.prompt}</blockquote>
      <p className="muted">
        {invite.memberCount} {invite.memberCount === 1 ? "person" : "people"} in the group. Everyone nods on the final
        sheet and pays only their share.
      </p>
      {open ? (
        <button type="button" className="primary" disabled={join.isPending} onClick={() => join.mutate()}>
          {join.isPending ? "Joining…" : "Join the group"}
        </button>
      ) : (
        <p className="error">This request is already {invite.status}, so it can't take new members.</p>
      )}
      {join.error && <p className="error">{join.error.message}</p>}
    </div>
  );
}
