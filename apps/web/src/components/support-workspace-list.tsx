"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { useHiddenWorkspaces } from "@/lib/chat-subscriptions";
import {
  IconArrowRight,
  IconInbox,
  IconPlus,
  IconWallet,
} from "@tabler/icons-react";
import { useCommunityDirectory } from "@/lib/community-directory";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { nativeRoomHref } from "@/lib/native-room";
import { walletError } from "@/lib/wallet";
import { copy as t } from "@/lib/copy";
import { TemplMark } from "./brand/templ-mark";
import { Badge, Callout, EmptyState, PageHeader, Skeleton } from "./ui/ui";
import { WorkspaceMark } from "./workspace/app-frame";
import { WorkspaceFollowButton } from "./workspace/workspace-follow";
import { startEarlyWorkspaceRead } from "./workspace/workspace-reads";
import styles from "./support-workspace-list.module.css";

export function SupportWorkspaceList() {
  const router = useRouter();
  const auth = useChatAuth();
  const directory = useCommunityDirectory();
  const [error, setError] = useState("");
  const account = auth.session?.principalId;
  const hidden = useSearchParams().get("hidden") === "1";
  const hiddenList = useHiddenWorkspaces(account, hidden);
  const items = hidden ? hiddenList.items : directory.joined;
  const workspaces = items.filter((item) => item.nativeRoom);
  const loading = hidden ? hiddenList.loading : directory.joinedLoading;
  const listError = hidden ? hiddenList.error : directory.joinedError;
  const hasMore = hidden ? hiddenList.hasMore : directory.hasMoreJoined;
  const refresh = hidden ? hiddenList.refresh : directory.refresh;
  const loadMore = hidden ? hiddenList.loadMore : directory.loadMoreJoined;
  const inboxHref =
    !hidden &&
    auth.session &&
    !auth.restoring &&
    !directory.joinedLoading &&
    !directory.joinedError &&
    !directory.hasMoreJoined &&
    workspaces.length === 1
      ? nativeRoomHref(workspaces[0].nativeRoom)
      : null;
  const inboxId = inboxHref ? workspaces[0].nativeRoom?.id : undefined;
  useEffect(() => {
    if (inboxHref && inboxId) {
      startEarlyWorkspaceRead(inboxId);
      router.replace(inboxHref);
    }
  }, [inboxHref, inboxId, router]);
  async function signIn() {
    setError("");
    try {
      await auth.signIn();
    } catch (reason) {
      if (!isChatSignInCanceled(reason))
        setError(walletError(reason) || "Sign-in failed. Try again.");
    }
  }
  if (inboxHref)
    return (
      <div className={styles.boot} role="status" aria-busy="true">
        <TemplMark className={styles.bootStamp} decorative />
        <p>{t("shell.loading.inbox")}</p>
      </div>
    );
  if (!auth.session && auth.restoring)
    return (
      <div className={styles.boot} role="status" aria-busy="true">
        <TemplMark className={styles.bootStamp} decorative />
        <p>{t("shell.loading.workspaces")}</p>
      </div>
    );
  if (!auth.session)
    return (
      <div className={styles.center}>
        <section className={styles.signIn} aria-labelledby="inbox-sign-in">
          <TemplMark className={styles.stamp} decorative />
          <h1 id="inbox-sign-in">Sign in to Templ</h1>
          <p>
            Sign in with the account your team invited to open its support inbox.
            You can also create a workspace.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className="button large"
              onClick={() => void signIn()}
            >
              <IconWallet aria-hidden="true" />
              Sign in
            </button>
            <Link href="/create" className="button secondary large">
              Create a workspace
            </Link>
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </section>
      </div>
    );
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Workspaces"
        title={hidden ? "Hidden workspaces" : "Your support workspaces"}
        description={
          hidden
            ? "Show a workspace to add it back to your list. Your access is unchanged."
            : "Each workspace has your app’s widget, team and inbox."
        }
        actions={
          <div className={styles.actions}>
            <Link
              href={hidden ? "/inbox" : "/inbox?hidden=1"}
              className="button secondary"
            >
              {hidden ? "Your workspaces" : "Hidden workspaces"}
            </Link>
            {!hidden && workspaces.length > 0 && (
              <Link href="/create" className="button">
                <IconPlus aria-hidden="true" /> New workspace
              </Link>
            )}
          </div>
        }
      />
      {hidden && hiddenList.mutationError && (
        <Callout tone="danger" role="alert">
          {hiddenList.mutationError}
        </Callout>
      )}
      {loading && workspaces.length === 0 ? (
        <div
          className={styles.grid}
          role="status"
          aria-label="Loading workspaces"
        >
          <Skeleton height={148} />
          <Skeleton height={148} />
          <Skeleton height={148} />
        </div>
      ) : listError ? (
        <Callout tone="danger" role="alert">
          {listError}{" "}
          <button
            type="button"
            className="button small secondary"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </Callout>
      ) : workspaces.length ? (
        <div className={styles.grid}>
          {workspaces.map((workspace) => {
            const room = workspace.nativeRoom;
            const owner =
              room.manager?.toLowerCase() === account?.toLowerCase();
            const content = (
              <>
                <div className={styles.cardTop}>
                  <WorkspaceMark name={room.name} image={room.image} />
                  <Badge tone={owner ? "brand" : "neutral"}>
                    {owner ? "Owner" : "Team"}
                  </Badge>
                </div>
                <strong>{room.name}</strong>
              </>
            );
            if (hidden)
              return (
                <section key={room.id} className={styles.card}>
                  {content}
                  <Link href={nativeRoomHref(room)} className={styles.cardFoot}>
                    <IconInbox aria-hidden="true" /> Open inbox
                    <IconArrowRight
                      aria-hidden="true"
                      className={styles.arrow}
                    />
                  </Link>
                  <WorkspaceFollowButton
                    workspace={room}
                    account={account as ChatPrincipalId}
                    hidden
                  />
                </section>
              );
            return (
              <Link
                key={room.id}
                href={nativeRoomHref(room)}
                className={styles.card}
              >
                {content}
                <span className={styles.cardFoot}>
                  <IconInbox aria-hidden="true" /> Open inbox
                  <IconArrowRight aria-hidden="true" className={styles.arrow} />
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyWrap}>
          <EmptyState
            icon={<IconInbox />}
            title={
              hidden
                ? "No hidden workspaces"
                : "Your first support inbox starts here"
            }
            actions={
              hidden ? undefined : (
                <Link href="/create" className="button large">
                  <IconPlus aria-hidden="true" /> Create a workspace
                </Link>
              )
            }
          >
            {hidden
              ? "Workspaces you hide appear here while you still have access."
              : "Create a workspace for your protocol and add the widget. Workspaces appear here when a teammate adds you."}
          </EmptyState>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {hasMore && (
        <button
          type="button"
          className="button secondary"
          style={{ marginTop: 20 }}
          onClick={() => void loadMore()}
        >
          Load more workspaces
        </button>
      )}
    </div>
  );
}
