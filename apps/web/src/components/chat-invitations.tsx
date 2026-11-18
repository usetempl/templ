"use client";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconLink, IconLock } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import { useChatAuth } from "@/lib/chat-auth";
import { peekCommunitySession } from "@/lib/community-auth";
import {
  acceptInvitation,
  previewInvitation,
  takeChatInvitation,
} from "@/lib/chat-invitations";
import { copy as t } from "@/lib/copy";
import { walletError } from "@/lib/wallet";
import { ChatSkeleton, LoadingSpinner } from "./loading-state";
import styles from "./chat-invitations.module.css";

export function InvitationEntry({
  room,
  children,
}: {
  room: ChatRoomId;
  children: ReactNode;
}) {
  const auth = useChatAuth();
  const [secret, setSecret] = useState<string>();
  const [checked, setChecked] = useState(false);
  const [valid, setValid] = useState(false);
  // The preview found no live invitation; the text is chosen at render so
  // the effect below never re-runs for a language change.
  const [missing, setMissing] = useState(false);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const value = takeChatInvitation(window.location, (path) =>
      window.history.replaceState(window.history.state, "", path),
    );
    setSecret(value);
    setChecked(true);
    if (value !== undefined)
      void previewInvitation(room, value)
        .then(() => {
          if (alive.current) setValid(true);
        })
        .catch(() => {
          if (alive.current) setMissing(true);
        });
    return () => {
      alive.current = false;
    };
  }, [room]);
  async function join() {
    if (!valid || secret === undefined || busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await auth.signIn();
      const guard = () => {
        if (
          !alive.current ||
          peekCommunitySession()?.principalId !== session.principalId
        )
          throw new Error(t("room.invite.accountChanged"));
      };
      guard();
      await acceptInvitation(room, session.principalId, secret, guard);
      setSecret(undefined);
      setJoined(true);
    } catch (reason) {
      if (alive.current && !isChatSignInCanceled(reason))
        setError(walletError(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!checked) return <ChatSkeleton />;
  if (secret === undefined || joined) return children;
  const shownError = error || (missing ? t("room.invite.notFound") : "");
  return (
    <section className={styles.entry}>
      <IconLock size={36} aria-hidden="true" />
      <h1>{t("room.invite.invited")}</h1>
      <p>{t("room.invite.joinPrivate")}</p>
      {shownError && (
        <p role="alert" className={styles.error}>
          {shownError}
        </p>
      )}
      <button
        className="button"
        type="button"
        disabled={!valid || busy || auth.restoring}
        onClick={() => void join()}
      >
        {busy ? <LoadingSpinner /> : <IconLink size={18} />}
        {busy ? t("room.invite.joining") : t("room.invite.join")}
      </button>
    </section>
  );
}
