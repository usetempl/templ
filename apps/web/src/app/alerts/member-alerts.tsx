"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { MemberAlertView } from "@templ/chat/support-alerts";
import {
  parseAlertTicket,
  readMemberAlerts,
  redeemAlertTicket,
  setMemberAlerts,
  startMemberEmail,
  verifyMemberEmail,
} from "@/lib/alerts-client";
import { MEMBER_PAGE as m } from "@/lib/copy/alerts";
import { Callout, Field, Spinner, ui } from "@/components/ui/ui";
import styles from "@/components/workspace/workspace-alerts.module.css";

const WORKSPACE_KEY = "templ:alert-workspace";
const remember = (workspace: string) => {
  try {
    sessionStorage.setItem(WORKSPACE_KEY, workspace);
  } catch {
    /* A private window keeps nothing; the grant still works on this load. */
  }
};
const remembered = () => {
  try {
    return sessionStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
};
const message = (reason: unknown) => (reason instanceof Error ? reason.message : m.expired);

/** The page a signed member opens from the widget to get an email when the
 * team replies. The ticket in the link's fragment never reaches a server
 * log: the page removes it from the address bar and posts it once. */
export function MemberAlerts() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [view, setView] = useState<MemberAlertView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "expired" | "none">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  useEffect(() => {
    const ticket = parseAlertTicket(window.location.hash);
    if (window.location.hash)
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const load = ticket
      ? redeemAlertTicket(ticket.workspace, ticket.ticket).then((data) => {
          remember(ticket.workspace);
          return { workspace: ticket.workspace, data };
        })
      : remembered()
        ? readMemberAlerts(remembered()!).then((data) => ({ workspace: remembered()!, data }))
        : Promise.reject(new Error("none"));
    load
      .then(({ workspace, data }) => {
        setWorkspace(workspace);
        setView(data);
        setState("ready");
      })
      .catch((reason) => setState(reason instanceof Error && reason.message === "none" ? "none" : "expired"));
  }, []);

  async function run<T>(work: () => Promise<T>) {
    setBusy(true);
    setError("");
    try {
      return await work();
    } catch (reason) {
      setError(message(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function toggle(enabled: boolean) {
    const next = await run(() => setMemberAlerts(workspace!, enabled));
    if (next) setView(next);
  }
  async function sendCode(event: FormEvent) {
    event.preventDefault();
    const sent = await run(() => startMemberEmail(workspace!, email.trim(), crypto.randomUUID()));
    if (sent) setCodeSent(true);
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    const verified = await run(() => verifyMemberEmail(workspace!, email.trim(), code));
    if (!verified?.emailVerified || !view) return;
    const next = await run(() => setMemberAlerts(workspace!, true));
    setView(next ?? { ...view, emailVerified: true, emailMasked: verified.emailMasked });
  }

  if (state === "loading")
    return (
      <p role="status">
        <Spinner /> {m.loading}
      </p>
    );
  if (state !== "ready" || !view)
    return <Callout role="alert">{state === "none" ? m.noTicket : m.expired}</Callout>;
  return (
    <>
      <h1>{m.title(view.workspaceName)}</h1>
      <ul className={styles.points}>
        {m.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {view.emailVerified ? (
        <div className={styles.actions}>
          <p role="status">
            {view.enabled && view.emailMasked ? m.on(view.emailMasked) : m.offLine}
          </p>
          <button
            type="button"
            className={view.enabled ? "button secondary" : "button"}
            disabled={busy}
            onClick={() => void toggle(!view.enabled)}
          >
            {busy && <Spinner />}
            {view.enabled ? m.turnOff : m.turnOn}
          </button>
        </div>
      ) : !codeSent ? (
        <form onSubmit={(event) => void sendCode(event)}>
          <Field label={m.email}>
            <input
              className={ui.input}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <button type="submit" className="button" disabled={busy || !email.includes("@")}>
            {busy && <Spinner />}
            {m.sendCode}
          </button>
        </form>
      ) : (
        <form onSubmit={(event) => void confirm(event)}>
          <Field label={m.code}>
            <input
              className={ui.input}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <button type="submit" className="button" disabled={busy || code.length !== 6}>
            {busy && <Spinner />}
            {m.verify}
          </button>
        </form>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
    </>
  );
}
