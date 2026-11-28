"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { TeamInvitePreview } from "@templ/chat/team-invite";
import { useChatAuth } from "@/lib/chat-auth";
import {
  peekCommunitySession,
  sameCommunitySession,
  type CommunitySession,
} from "@/lib/community-auth";
import { chatMutation } from "@/lib/chat-api";
import { isNativeRoomId } from "@/lib/native-room";
import { trackEvent } from "@/lib/analytics";
import { CommunityApiError } from "@/lib/community-client";
import { Card, Callout, Spinner } from "@/components/ui/ui";
import styles from "./team-invite-app.module.css";

function failure(reason: unknown) {
  if (emailProofRequired(reason))
    return "Sign in with email again. Then review this link.";
  if (reason instanceof CommunityApiError && reason.status === 401)
    return "Sign in again.";
  if (reason instanceof CommunityApiError && reason.status === 403)
    return "This account cannot use a team link. Ask the workspace manager to add it directly.";
  if (reason instanceof CommunityApiError && reason.status === 409)
    return "Your access or the team role changed. Ask the workspace manager for help.";
  if (reason instanceof CommunityApiError && reason.status === 503)
    return "Team links are not available in this workspace yet.";
  if (reason instanceof CommunityApiError && [404, 410].includes(reason.status))
    return "This link expired, was revoked, or was already used. Ask the workspace manager for a new link.";
  return "The team link could not be checked. Try again.";
}
function emailProofRequired(reason: unknown) {
  return (
    reason instanceof CommunityApiError &&
    reason.status === 403 &&
    !!reason.details &&
    typeof reason.details === "object" &&
    (reason.details as { reason?: unknown }).reason === "email-sign-in-required"
  );
}
export function TeamInviteApp({ workspace }: { workspace: string }) {
  const auth = useChatAuth();
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<TeamInvitePreview>();
  const [boundSession, setBoundSession] = useState<CommunitySession>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joined, setJoined] = useState(false);
  const [refreshEmail, setRefreshEmail] = useState(false);
  const inFlight = useRef(false);
  const lifetime = useRef(true);
  const fragmentRead = useRef(false);
  const validWorkspace = isNativeRoomId(workspace);
  const current = boundSession && sameCommunitySession(boundSession, auth.session);
  useEffect(() => {
    lifetime.current = true;
    if (!fragmentRead.current) {
      fragmentRead.current = true;
      const fragment = window.location.hash.slice(1);
      // The credential stays in memory after opening the link, never in routing or logs.
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      if (validWorkspace && /^[a-f0-9]{64}$/.test(fragment)) setToken(fragment);
      else
        setError(
          "This team link is incomplete. Ask the workspace manager to send it again.",
        );
    }
    return () => {
      lifetime.current = false;
    };
  }, [validWorkspace]);
  async function readLink() {
    if (inFlight.current || !token) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const session = await (refreshEmail
        ? auth.signIn({ refreshEmail: true })
        : auth.signIn());
      const assertCurrent = () => {
        if (!lifetime.current || !sameCommunitySession(session, peekCommunitySession()))
          throw new CommunityApiError("Account changed.", 401);
      };
      assertCurrent();
      const result = await chatMutation<TeamInvitePreview>(
        session.principalId,
        `/rooms/${workspace}/team-invites/check`,
        { token, confirmed: true },
        assertCurrent,
      );
      assertCurrent();
      setBoundSession(session);
      setPreview(result);
      setRefreshEmail(false);
    } catch (reason) {
      if (lifetime.current) {
        if (emailProofRequired(reason)) {
          setRefreshEmail(true);
          setPreview(undefined);
          setBoundSession(undefined);
        }
        trackEvent("team_invite_failed");
        setError(failure(reason));
      }
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(false);
    }
  }
  async function accept() {
    if (inFlight.current || !token || !preview || !boundSession || !current)
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    trackEvent("team_invite_accept_clicked");
    try {
      const assertCurrent = () => {
        if (
          !lifetime.current ||
          !sameCommunitySession(boundSession, peekCommunitySession())
        )
          throw new CommunityApiError("Account changed.", 401);
      };
      await chatMutation(
        boundSession.principalId,
        `/rooms/${workspace}/team-invites/accept`,
        { token, confirmed: true },
        assertCurrent,
      );
      assertCurrent();
      setJoined(true);
      setToken("");
      trackEvent("team_invite_accepted");
    } catch (reason) {
      if (lifetime.current) {
        if (emailProofRequired(reason)) {
          setRefreshEmail(true);
          setPreview(undefined);
          setBoundSession(undefined);
        }
        trackEvent("team_invite_failed");
        setError(failure(reason));
      }
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(false);
    }
  }
  return (
    <main className={styles.page}>
      <Card
        className={styles.panel}
        title={joined ? "You joined the team" : "Join a support team"}
      >
        <div className={styles.stack}>
          {joined ? (
            <>
              <p>You can now read and answer the cases your role allows.</p>
              <Link className="button" href={`/inbox/${workspace}`}>
                Open workspace
              </Link>
            </>
          ) : (
            <>
              <p>
                The workspace manager chose your role. Sign in with email or
                your wallet, then review your access.
              </p>
              {preview && (
                <>
                  <p>
                    Your role is <strong>{preview.roleName}</strong>.
                  </p>
                  <p>
                    {preview.roleId === "support-lead"
                      ? "You can read and answer all cases, assign cases, and edit support settings."
                      : "You can read and answer all cases."}
                  </p>
                  <p>
                    Link expires {new Date(preview.expiresAt).toLocaleString()}.
                  </p>
                </>
              )}
              {preview && current ? (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  {busy && <Spinner />} Accept team access
                </button>
              ) : (
                token && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void readLink()}
                  >
                    {busy && <Spinner />} Sign in to review access
                  </button>
                )
              )}
              {preview && !current && (
                <p>Your account changed. Sign in again to review this link.</p>
              )}
            </>
          )}
          {error && (
            <Callout tone="warning">
              <p role="alert">{error}</p>
            </Callout>
          )}
        </div>
      </Card>
    </main>
  );
}
