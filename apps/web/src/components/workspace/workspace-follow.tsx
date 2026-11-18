"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconBookmark, IconBookmarkOff } from "@tabler/icons-react";
import type { NativeRoom } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { zeroAddress } from "viem";
import {
  communitySessionRevision,
  peekCommunitySession,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import { communityFetch } from "@/lib/community-client";
import { setChatSubscription } from "@/lib/chat-subscriptions";
import { nativeRoomKey } from "@/lib/chat-room-id";
import { Spinner } from "@/components/ui/ui";
import styles from "./rail.module.css";

/** Following changes the workspace list only. It grants and removes no access. */
export function WorkspaceFollowButton({
  workspace,
  account,
  hidden = false,
  menu = false,
}: {
  workspace: NativeRoom;
  account: ChatPrincipalId;
  hidden?: boolean;
  menu?: boolean;
}) {
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    communitySessionRevision,
  );
  return (
    <FollowMenuItem
      key={`${workspace.id}:${account}:${revision}`}
      workspace={workspace}
      account={account}
      revision={revision}
      hidden={hidden}
      menu={menu}
    />
  );
}

function FollowMenuItem({
  workspace,
  account,
  revision,
  hidden,
  menu,
}: {
  workspace: NativeRoom;
  account: ChatPrincipalId;
  revision: number;
  hidden: boolean;
  menu: boolean;
}) {
  const [followed, setFollowed] = useState<boolean | undefined>(
    hidden ? false : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    if (hidden) return () => current.abort();
    void communityFetch<{ subscribed: boolean; viewerPrincipalId: string }>(
      `/subscriptions/rooms/${workspace.id}`,
      undefined,
      current.signal,
    )
      .then((value) => {
        if (current.signal.aborted) return;
        if (
          typeof value.subscribed !== "boolean" ||
          value.viewerPrincipalId?.toLowerCase() !== account.toLowerCase() ||
          communitySessionRevision() !== revision ||
          !peekCommunitySession(account)
        )
          throw Error();
        setFollowed(value.subscribed);
        setError("");
      })
      .catch(() => {
        if (!current.signal.aborted)
          setError("Your workspace list could not load. Try again.");
      });
    return () => current.abort();
  }, [workspace.id, account, revision, retry, hidden]);

  async function toggle() {
    if (busy || followed === undefined) return;
    const current = controller.current;
    const previous = followed;
    const next = !previous;
    setFollowed(next);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await setChatSubscription({
        account,
        community: {
          address: nativeRoomKey(workspace.id),
          tokenAddress: zeroAddress,
          creator: workspace.creator,
          name: workspace.name,
          symbol: "",
          image: workspace.image ?? undefined,
          nativeRoom: workspace,
        },
        subscribed: next,
        assertCurrent: () => {
          if (
            communitySessionRevision() !== revision ||
            !peekCommunitySession(account)
          )
            throw Error("Sign in to continue.");
        },
      });
      if (!current?.signal.aborted)
        setNotice(
          next
            ? "Added to your workspaces."
            : "Hidden from your list. Your access is unchanged.",
        );
    } catch {
      if (!current?.signal.aborted) {
        setFollowed(previous);
        setError("Your change could not save. Try again.");
      }
    } finally {
      if (!current?.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        role={menu ? "menuitem" : undefined}
        className={menu ? styles.menuItem : "button secondary small"}
        aria-busy={busy || (followed === undefined && !error)}
        disabled={busy || (followed === undefined && !error)}
        onClick={() => {
          if (followed === undefined) {
            setError("");
            setRetry((value) => value + 1);
          } else void toggle();
        }}
      >
        {busy || (followed === undefined && !error) ? (
          <Spinner />
        ) : followed ? (
          <IconBookmarkOff aria-hidden="true" />
        ) : (
          <IconBookmark aria-hidden="true" />
        )}
        {followed === undefined
          ? error
            ? "Retry workspace list"
            : "Workspace list"
          : followed
            ? "Hide workspace"
            : "Show workspace"}
      </button>
      {error ? (
        <p className={styles.railError} role="alert">
          {error}
        </p>
      ) : notice ? (
        <p className={styles.railNote} role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}
