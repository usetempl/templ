"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import {
  peekCommunitySession,
  sameCommunitySession,
  type CommunitySession,
} from "@/lib/community-auth";
import { CommunityApiError } from "@/lib/community-client";
import {
  approveConnectRequest,
  denyConnectRequest,
  readConnectRequest,
  readConnectWorkspaces,
  type ConnectRequest,
  type ConnectWorkspace,
} from "@/lib/install-connect";
import { trackEvent } from "@/lib/analytics";
import { TemplMark } from "@/components/brand/templ-mark";
import { TalkToTempl } from "@/components/talk-to-templ";
import { Callout, Field, Spinner, ui } from "@/components/ui/ui";
import styles from "./connect-app.module.css";

type Step = "read" | "sign-in" | "workspaces" | "approve" | "deny";

function failure(reason: unknown, step: Step) {
  const status =
    reason instanceof CommunityApiError ? reason.status : undefined;
  const cause = isChatSignInCanceled(reason)
    ? "sign-in-cancelled"
    : status === 401
      ? "sign-in-required"
      : status === 403
        ? "wallet-refused"
        : status === 404
          ? "request-missing"
          : status === 409
            ? "request-used"
            : status === 410
              ? "request-expired"
              : status === 429
                ? "rate-limited"
                : status === 503
                  ? "feature-unavailable"
                  : reason instanceof TypeError
                    ? "connection-failed"
                    : "request-failed";
  console.warn(
    JSON.stringify({
      event: "TEMPL_SUPPORT_FAILURE",
      route: "connect",
      step,
      reason: cause,
    }),
  );
  trackEvent("connect_failed");
  if (
    reason instanceof Error &&
    reason.message ===
      "This connect code is invalid. Ask your AI tool for a new link."
  )
    return reason.message;
  if (isChatSignInCanceled(reason))
    return "Sign-in was cancelled. Your app is not connected.";
  if (status === 401) return "Sign in with your wallet again.";
  if (status === 403)
    return "This wallet cannot confirm this app. Use the wallet that signed in for this request.";
  if (status === 404)
    return "This link was not found. Ask your AI tool for a new link.";
  if (status === 409)
    return "This link was used. Ask your AI tool for a new link.";
  if (status === 410)
    return "This link expired. Ask your AI tool for a new link.";
  if (status === 429)
    return "Too many requests. Wait a minute, then try again.";
  if (status === 503)
    return "App connection is not available. Ask your AI tool to stop this install.";
  return step === "sign-in"
    ? "Your wallet could not sign in. Try again."
    : "The app request could not be checked. Try again.";
}

export function ConnectApp({ code }: { code: string }) {
  const auth = useChatAuth();
  const [request, setRequest] = useState<ConnectRequest>();
  const [loading, setLoading] = useState(true);
  const [boundSession, setBoundSession] = useState<CommunitySession>();
  const [workspaces, setWorkspaces] = useState<ConnectWorkspace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [selection, setSelection] = useState<"create" | "existing">();
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<Step>();
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<"approved" | "denied">();
  const [expired, setExpired] = useState(false);
  const inFlight = useRef(false);
  const lifetime = useRef(true);
  const current = Boolean(
    boundSession && sameCommunitySession(boundSession, auth.session),
  );

  useEffect(() => {
    lifetime.current = true;
    const controller = new AbortController();
    trackEvent("connect_opened");
    void readConnectRequest(code, controller.signal).then(
      (value) => {
        if (!lifetime.current) return;
        setRequest(value);
        setName(value.appName ?? new URL(value.origins[0]).hostname);
        setExpired(value.expiresAt <= Date.now() || value.status === "expired");
        setLoading(false);
      },
      (reason) => {
        if (!lifetime.current || controller.signal.aborted) return;
        setError(failure(reason, "read"));
        setLoading(false);
      },
    );
    return () => {
      lifetime.current = false;
      controller.abort();
    };
  }, [code]);

  useEffect(() => {
    if (!request || completed || expired) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, request.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [request, completed, expired]);

  function assertCurrent(session: CommunitySession, checkExpiry = true) {
    if (!lifetime.current || !sameCommunitySession(session, peekCommunitySession()))
      throw new CommunityApiError("The wallet changed.", 401);
    if (checkExpiry && (!request || request.expiresAt <= Date.now()))
      throw new CommunityApiError("The link expired.", 410);
  }

  async function loadWorkspaces(session: CommunitySession, next?: string) {
    assertCurrent(session);
    const page = await readConnectWorkspaces(code, next);
    assertCurrent(session);
    setWorkspaces((previous) =>
      next ? [...previous, ...page.workspaces] : page.workspaces,
    );
    setCursor(page.cursor);
    setWorkspaceError("");
  }

  async function signIn() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("sign-in");
    setError("");
    setWorkspaceError("");
    setWorkspaces([]);
    setCursor(null);
    setSelection(undefined);
    setWorkspaceId("");
    trackEvent("connect_sign_in_clicked");
    try {
      const session = await auth.signIn({ connectCode: code });
      assertCurrent(session);
      setBoundSession(session);
      try {
        await loadWorkspaces(session);
      } catch (reason) {
        if (lifetime.current) setWorkspaceError(failure(reason, "workspaces"));
      }
    } catch (reason) {
      if (lifetime.current) setError(failure(reason, "sign-in"));
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(undefined);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !boundSession || !selection) return;
    if (selection === "create" && (!request?.createAllowed || !name.trim()))
      return;
    if (
      selection === "existing" &&
      !workspaces.some((workspace) => workspace.id === workspaceId)
    )
      return;
    inFlight.current = true;
    setBusy("approve");
    setError("");
    trackEvent("connect_confirm_clicked");
    try {
      assertCurrent(boundSession);
      await approveConnectRequest(
        code,
        boundSession.principalId,
        selection === "create" ? { name: name.trim() } : { workspaceId },
      );
      assertCurrent(boundSession, false);
      setCompleted("approved");
      trackEvent("connect_completed");
    } catch (reason) {
      if (lifetime.current) setError(failure(reason, "approve"));
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(undefined);
    }
  }

  async function cancel() {
    if (inFlight.current || !boundSession) return;
    inFlight.current = true;
    setBusy("deny");
    setError("");
    trackEvent("connect_cancel_clicked");
    try {
      assertCurrent(boundSession);
      await denyConnectRequest(code, boundSession.principalId);
      assertCurrent(boundSession, false);
      setCompleted("denied");
      trackEvent("connect_cancelled");
    } catch (reason) {
      if (lifetime.current) setError(failure(reason, "deny"));
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(undefined);
    }
  }

  const used = request?.status === "approved";
  const denied = completed === "denied" || request?.status === "denied";
  const title =
    completed === "approved"
      ? "Your app is connected"
      : denied
        ? "App connection cancelled"
        : expired
          ? "This link expired"
          : used
            ? "This link was used"
            : "Connect your app";
  const active = Boolean(request && !completed && !expired && !used && !denied);
  return (
    <div className={styles.page} data-templ-connect-route="approval">
      <section className={styles.panel} aria-labelledby="connect-title">
        <header className={styles.header}>
          <TemplMark className={styles.mark} decorative />
          <h1 id="connect-title">{title}</h1>
          {completed === "approved" ? (
            <p role="status">
              Return to your AI tool. It will finish the widget install.
            </p>
          ) : denied ? (
            <p role="status">
              Your AI tool cannot use this link. You can close this page.
            </p>
          ) : expired || used ? (
            <p>Ask your AI tool for a new link.</p>
          ) : (
            <p>Check the app and sites before you sign in.</p>
          )}
        </header>
        <TalkToTempl label="Chat with Templ">Chat with Templ</TalkToTempl>
        {loading && (
          <p role="status">
            <Spinner /> Checking this app…
          </p>
        )}
        {active && request && (
          <>
            <dl className={styles.details}>
              <div>
                <dt>App</dt>
                <dd>
                  {request.appName ?? new URL(request.origins[0]).hostname}
                </dd>
              </div>
              <div>
                <dt>App websites</dt>
                <dd>
                  <ul className={styles.origins}>
                    {request.origins.map((origin) => (
                      <li key={origin}>{origin}</li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>Connect code</dt>
                <dd className={styles.code}>{code}</dd>
              </div>
            </dl>
            {!current ? (
              <>
                {boundSession && (
                  <Callout tone="danger" role="alert">
                    Your wallet changed. Sign in again before you confirm.
                  </Callout>
                )}
                <button
                  type="button"
                  className="button large"
                  disabled={Boolean(busy) || auth.restoring}
                  aria-busy={busy === "sign-in"}
                  onClick={() => void signIn()}
                >
                  {busy === "sign-in" && <Spinner />}
                  Sign in
                </button>
                <p className={styles.hint}>
                  Sign in with your wallet. Choose a workspace in the next step.
                </p>
              </>
            ) : (
              <form
                className={styles.form}
                onSubmit={(event) => void confirm(event)}
              >
                <fieldset className={styles.choices} disabled={Boolean(busy)}>
                  <legend>Choose a workspace</legend>
                  {request.createAllowed && (
                    <label className={styles.choice}>
                      <input
                        type="radio"
                        name="workspace-choice"
                        checked={selection === "create"}
                        onChange={() => {
                          setSelection("create");
                          trackEvent("connect_create_selected");
                        }}
                      />
                      Create workspace
                    </label>
                  )}
                  {selection === "create" && (
                    <Field
                      label="Workspace name"
                      hint="Create a workspace for this app."
                    >
                      <input
                        className={ui.input}
                        value={name}
                        maxLength={80}
                        required
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                  )}
                  {workspaces.length > 0 && (
                    <label className={styles.choice}>
                      <input
                        type="radio"
                        name="workspace-choice"
                        checked={selection === "existing"}
                        onChange={() => {
                          setSelection("existing");
                          trackEvent("connect_workspace_selected");
                        }}
                      />
                      Use existing workspace
                    </label>
                  )}
                  {selection === "existing" && (
                    <Field
                      label="Existing workspace"
                      hint="You can use only workspaces you manage."
                    >
                      <select
                        className={ui.input}
                        value={workspaceId}
                        required
                        onChange={(event) => {
                          setWorkspaceId(event.target.value);
                          trackEvent("connect_workspace_selected");
                        }}
                      >
                        <option value="">Choose a workspace</option>
                        {workspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </fieldset>
                {workspaceError && (
                  <Callout tone="danger" role="alert">
                    {workspaceError}
                    <button
                      type="button"
                      className="button small secondary"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!boundSession) return;
                        setBusy("workspaces");
                        void loadWorkspaces(boundSession)
                          .catch((reason) => {
                            if (lifetime.current)
                              setWorkspaceError(failure(reason, "workspaces"));
                          })
                          .finally(() => {
                            if (lifetime.current) setBusy(undefined);
                          });
                      }}
                    >
                      Retry
                    </button>
                  </Callout>
                )}
                {cursor && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!boundSession) return;
                      setBusy("workspaces");
                      void loadWorkspaces(boundSession, cursor)
                        .catch((reason) => {
                          if (lifetime.current)
                            setWorkspaceError(failure(reason, "workspaces"));
                        })
                        .finally(() => {
                          if (lifetime.current) setBusy(undefined);
                        });
                    }}
                  >
                    Load more
                  </button>
                )}
                {!request.createAllowed &&
                  workspaces.length === 0 &&
                  !workspaceError &&
                  !cursor && (
                    <p className={styles.hint}>
                      App connection is not available for your workspaces.
                    </p>
                  )}
                <p className={styles.hint}>
                  Confirming connects this app to the workspace. Your AI tool
                  receives only its public workspace ID.
                </p>
                <div className={styles.actions}>
                  <button
                    type="submit"
                    className="button"
                    disabled={
                      Boolean(busy) ||
                      !selection ||
                      (selection === "create" ? !name.trim() : !workspaceId)
                    }
                    aria-busy={busy === "approve"}
                  >
                    {busy === "approve" && <Spinner />}Confirm app
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void cancel()}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </section>
    </div>
  );
}
