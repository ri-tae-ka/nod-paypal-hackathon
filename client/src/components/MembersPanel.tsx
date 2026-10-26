import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createInvite, removeMember, revokeInvite } from "../api/requests";
import type { Member, ProcurementRequest } from "../types/api";
import styles from "./MembersPanel.module.css";

interface Props {
  request: ProcurementRequest;
  members: Member[];
  inviteToken: string | null;
  meId: string;
  nods: string[];
}

export function MembersPanel({ request, members, inviteToken, meId, nods }: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const isOwner = request.role !== "member";
  const draft = request.status === "draft";
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["request", request.id] });
    void queryClient.invalidateQueries({ queryKey: ["requests"] });
  };

  const invite = useMutation({ mutationFn: () => createInvite(request.id), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: () => revokeInvite(request.id), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (userId: string) => removeMember(request.id, userId),
    onSuccess: (_, userId) => (userId === meId ? navigate("/requests") : refresh()),
  });

  const link = inviteToken ? `${window.location.origin}/join/${inviteToken}` : null;
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  if (members.length <= 1 && (!isOwner || !draft)) return null;

  return (
    <section className={styles.panel} aria-label="Group">
      <div className={styles.head}>
        <h2>{members.length > 1 ? `Group · ${members.length}` : "Shop together"}</h2>
        {isOwner && draft && !link && (
          <button type="button" className="primary" disabled={invite.isPending} onClick={() => invite.mutate()}>
            Invite people
          </button>
        )}
      </div>
      {members.length <= 1 && !link && (
        <p className="muted">Invite friends or family to split this order. Everyone nods, everyone pays their share.</p>
      )}
      {link && draft && (
        <div className={styles.invite}>
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
          <button type="button" className="danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            Revoke
          </button>
        </div>
      )}
      {members.length > 1 && (
        <ul className={styles.list}>
          {members.map((m) => (
            <li key={m.userId}>
              <span className={styles.avatar} aria-hidden>{m.displayName.slice(0, 1).toUpperCase()}</span>
              <span className={styles.name}>
                {m.displayName}
                {m.userId === meId && " (you)"}
                {m.role === "owner" && <em className={styles.tag}>Owner</em>}
              </span>
              {draft && (
                <span className={nods.includes(m.userId) ? styles.nodded : styles.waiting}>
                  {nods.includes(m.userId) ? "Nodded" : "Not yet"}
                </span>
              )}
              {draft && ((isOwner && m.role !== "owner") || (!isOwner && m.userId === meId)) && (
                <button type="button" className={styles.linkBtn} onClick={() => remove.mutate(m.userId)}>
                  {m.userId === meId ? "Leave" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(invite.error || revoke.error || remove.error) && (
        <p className="error">{(invite.error ?? revoke.error ?? remove.error)?.message}</p>
      )}
    </section>
  );
}
