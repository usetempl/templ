"use client";

import { useRef, useState, type FormEvent } from "react";
import { Card, Field, ui } from "@/components/ui/ui";
import { trackEvent } from "@/lib/analytics";
import { addKnowledge } from "@/lib/knowledge-client";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";

export function OnboardingSource({ context }: { context: WorkspaceContext }) {
  const { room, account, go } = context;
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || !url.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const page = await addKnowledge(room, account, {
        action: "add-doc", url: url.trim(), era: "current", visibility: "member-safe",
      });
      if (!("status" in page)) throw new Error("Missing page status");
      trackEvent("brain_source_added");
      if (page.status === "ready") setNotice("Page ready for AI replies. You can add another page.");
      else if (page.status === "pending") setNotice("Page saved. Templ will read it before AI can use it.");
      else setError("This page is unavailable for AI replies. Open Sources to check it.");
      setUrl("");
    } catch {
      setError("Could not add this page. Check the public web address and try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Card title="Add pages for your support AI" description="Choose public pages from your website or docs that visitors can use.">
      <form className={styles.fields} onSubmit={save}>
        <Field label="Public page URL">
          <input className={ui.input} type="url" autoComplete="off" placeholder="https://"
            required value={url} disabled={busy} onChange={event => setUrl(event.target.value)} />
        </Field>
        <div className={styles.row}>
          <button type="submit" className="button" disabled={busy || !account || !url.trim()}>
            {busy ? "Adding page…" : "Add page"}
          </button>
          <button type="button" className="button secondary" onClick={() => go("knowledge")}>Open Sources</button>
        </div>
      </form>
      {notice && <p className={styles.status} role="status">{notice}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </Card>
  );
}
