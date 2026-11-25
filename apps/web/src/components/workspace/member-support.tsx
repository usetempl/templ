"use client";

import Link from "next/link";
import { IconLock, IconMessageCircle, IconWallet } from "@tabler/icons-react";
import type { ChatRoomId, NativeRoom } from "@templ/chat/index";
import { TeamConversationsPane } from "@/components/team-conversations";
import { TemplLogo } from "@/components/brand/templ-mark";
import { AccountMenu, WorkspaceMark } from "./app-frame";
import styles from "./member-support.module.css";

/** A member's private thread with a protocol team. No staff tools, no
 * workspace navigation: the team's name, the disclosure and the thread. */
export function MemberSupportPage({
  room,
  workspace,
  revision,
  signedIn,
  onSignIn,
  signInError,
}: {
  room: ChatRoomId;
  workspace: NativeRoom;
  revision: number;
  signedIn: boolean;
  onSignIn: () => void;
  signInError: string;
}) {
  return (
    <div className={styles.page} data-templ-visitor-chat="">
      <header className={styles.top}>
        <div className={styles.identity}>
          <WorkspaceMark name={workspace.name} image={workspace.image} />
          <div>
            <strong>{workspace.name}</strong>
            <span>Support</span>
          </div>
        </div>
        {signedIn && (
          <div className={styles.account}>
            <AccountMenu placement="below" workspace={workspace} />
          </div>
        )}
      </header>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {signedIn ? (
          <TeamConversationsPane
            key={`${room}:${revision}`}
            room={room}
            communityName={workspace.name}
            view="mine"
            visibility={workspace.visibility}
            revision={revision}
          />
        ) : (
          <section className={styles.welcome} aria-labelledby="member-title">
            <span className={styles.welcomeIcon} aria-hidden="true">
              <IconMessageCircle />
            </span>
            <h1 id="member-title">Ask the {workspace.name} team</h1>
            <p>
              Sign in to start a private case. Only you and the team that
              handles support can read it, and you can come back to it any time.
            </p>
            <button type="button" className="button large" onClick={onSignIn}>
              <IconWallet aria-hidden="true" /> Sign in
            </button>
            {signInError && (
              <p role="alert" className={styles.error}>
                {signInError}
              </p>
            )}
          </section>
        )}
      </main>
      <footer className={styles.foot}>
        <IconLock size={14} aria-hidden="true" />
        <span>
          Never share a recovery phrase or private key. Support by{" "}
          <Link href="/" aria-label="Templ">
            <TemplLogo className={styles.logo} />
          </Link>
        </span>
      </footer>
    </div>
  );
}
