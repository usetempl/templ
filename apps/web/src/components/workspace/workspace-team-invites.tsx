"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamInvitation, TeamInviteRole } from "@templ/chat/team-invite";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { trackEvent } from "@/lib/analytics";
import { SITE } from "@/lib/site-environment";
import { Card, CopyInline, Field, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export function WorkspaceTeamInvites({
  context,
  prepareRole,
}: {
  context: WorkspaceContext;
  prepareRole: (roleId: TeamInviteRole) => Promise<void>;
}) {
  const { account, room } = context;
  const [invitations, setInvitations] = useState<TeamInvitation[]>();
  const [roleId, setRoleId] = useState<TeamInviteRole>("support-member");
  const [hours, setHours] = useState(24);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [link, setLink] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify({ roleId: "support-member", hours: 24 }),
  );
  const emailInput = useRef<HTMLInputElement>(null);
  const requestId = useRef<string | undefined>(undefined);
  const latestAccount = useRef(account);
  latestAccount.current = account;
  const inFlight = useRef(false);
  const lifetime = useRef(true);
  const read = () =>
    communityFetch<{ invitations: TeamInvitation[] }>(
      roomPath(room, "team-invites"),
    );
  useEffect(() => {
    lifetime.current = true;
    const controller = new AbortController();
    setError("");
    void communityFetch<{ invitations: TeamInvitation[] }>(
      roomPath(room, "team-invites"),
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (lifetime.current && !controller.signal.aborted)
          setInvitations(value.invitations);
      },
      () => {
        if (!controller.signal.aborted)
          setError("Team invitations could not load. Try again.");
      },
    );
    return () => {
      lifetime.current = false;
      controller.abort();
    };
  }, [room, account, attempt]);
  async function run(kind: "create" | "revoke", inviteId?: string) {
    if (inFlight.current || !account) return;
    const recipient = email.trim();
    if (kind === "create") {
      if (!confirmed) return;
      if (recipient && !emailInput.current?.checkValidity()) {
        setEmailError("Enter a valid email.");
        return;
      }
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    const actor = account;
    const assertCurrent = () => {
      if (!lifetime.current || latestAccount.current !== actor)
        throw new Error("Account changed.");
    };
    trackEvent(
      kind === "create"
        ? "team_invite_create_clicked"
        : "team_invite_revoke_clicked",
    );
    try {
      if (kind === "create") {
        await prepareRole(roleId);
        assertCurrent();
        if (recipient) requestId.current ??= crypto.randomUUID();
        const result = await chatMutation<{
          invitation: TeamInvitation;
          token?: string;
        }>(
          actor,
          roomPath(room, "team-invites"),
          {
            roleId,
            expiresInHours: hours,
            confirmed: true,
            ...(recipient
              ? { email: recipient, requestId: requestId.current }
              : {}),
          },
          assertCurrent,
        );
        assertCurrent();
        if (recipient) {
          if (!result.invitation.emailTargeted || result.token !== undefined)
            throw new Error("Email invitation could not be checked.");
          setLink("");
          setSaved(true);
          setEmail("");
          requestId.current = undefined;
        } else {
          if (!result.token) throw new Error("Invitation link is missing.");
          setLink(`${SITE.origin}/team-invite/${context.id}#${result.token}`);
        }
        setInvitations((current) => [
          result.invitation,
          ...(current ?? []).filter(
            (invite) => invite.id !== result.invitation.id,
          ),
        ]);
        setConfirmed(false);
        setBaseline(JSON.stringify({ roleId, hours }));
        trackEvent("team_invite_created");
      } else {
        await chatMutation(
          actor,
          roomPath(room, "team-invites/revoke"),
          { inviteId, confirmed: true },
          assertCurrent,
        );
        assertCurrent();
        setLink("");
        setInvitations((current) =>
          current?.map((invite) =>
            invite.id === inviteId ? { ...invite, status: "revoked" } : invite,
          ),
        );
        trackEvent("team_invite_revoked");
      }
      try {
        const value = await read();
        assertCurrent();
        setInvitations(value.invitations);
      } catch {
        assertCurrent();
        setError("The invitation list could not refresh. Reload the page.");
      }
    } catch {
      if (!lifetime.current) return;
      trackEvent("team_invite_failed");
      setError(
        "The invitation could not be saved. Check your sign-in and role, then try again.",
      );
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(false);
    }
  }
  return (
    <Card
      title="Invite your team"
      description={
        email.trim()
          ? "Your teammate gets access after signing in with this email."
          : "The first person who accepts gets the role you choose. Send the link only to that teammate."
      }
    >
      <UnsavedChanges
        dirty={Boolean(
          email.trim() ||
          confirmed ||
          baseline !== JSON.stringify({ roleId, hours }),
        )}
      />
      <div className={styles.inviteStack}>
        <Field
          label="Email"
          optional
          hint="Leave Email blank to create a single-use link."
          error={emailError}
        >
          <input
            ref={emailInput}
            className={ui.input}
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            disabled={busy}
            aria-invalid={Boolean(emailError)}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError("");
              setConfirmed(false);
              setSaved(false);
              requestId.current = undefined;
            }}
          />
        </Field>
        <div className={styles.row}>
          <Field label="Team role">
            <select
              className={ui.select}
              value={roleId}
              disabled={busy}
              onChange={(event) => {
                setRoleId(event.target.value as TeamInviteRole);
                setConfirmed(false);
                setSaved(false);
                requestId.current = undefined;
              }}
            >
              <option value="support-member">Team</option>
              <option value="support-lead">Support lead</option>
              <option value="support-admin">Admin</option>
            </select>
          </Field>
          <Field label="Invitation expires after">
            <select
              className={ui.select}
              value={hours}
              disabled={busy}
              onChange={(event) => {
                setHours(Number(event.target.value));
                setConfirmed(false);
                setSaved(false);
                requestId.current = undefined;
              }}
            >
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
            </select>
          </Field>
        </div>
        <label className={styles.row}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {roleId === "support-admin"
            ? "I give this teammate access to cases, workspace settings and team access."
            : roleId === "support-lead"
              ? "I give this teammate access to cases, assignments, saved replies and reports."
              : "I give this teammate access to read and answer all cases."}
        </label>
        <div>
          <button
            type="button"
            className="button"
            disabled={!confirmed || busy || !account}
            onClick={() => void run("create")}
          >
            {busy ? <Spinner /> : null}{" "}
            {email.trim() ? "Save email invitation" : "Create single-use link"}
          </button>
        </div>
        {saved && (
          <p role="status" className={styles.hint}>
            Invitation saved. Your teammate gets access after signing in with
            that email.
          </p>
        )}
        {link && (
          <div>
            <CopyInline value={link} label="Copy team invite link" />
            <p className={styles.hint}>
              This link appears once. Revoke it if you send it to the wrong
              person.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {error && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reload invitations
          </button>
        )}
        {invitations && invitations.length > 0 && (
          <ul className={styles.stack} aria-label="Team invitations">
            {invitations.map((invite) => (
              <li key={invite.id} className={styles.row}>
                <span className={styles.inviteRecipient}>
                  {invite.roleName} ({invite.status})
                  {invite.emailTargeted && invite.recipient
                    ? ` for ${invite.recipient}`
                    : ""}
                </span>
                <span className={styles.hint}>
                  Expires {new Date(invite.expiresAt).toLocaleString()}
                </span>
                {invite.status === "active" && (
                  <button
                    type="button"
                    className="button quiet"
                    disabled={busy}
                    onClick={() => void run("revoke", invite.id)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
