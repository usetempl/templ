"use client";

import { useRef, useState, type FormEvent } from "react";
import { IconArrowUpRight, IconFileText, IconSitemap } from "@tabler/icons-react";
import { Card, Field, ui } from "@/components/ui/ui";
import { trackEvent } from "@/lib/analytics";
import { addKnowledge } from "@/lib/knowledge-client";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./knowledge-sources.module.css";
import layout from "./workspace-settings.module.css";
import { TrialAiPractice } from "./trial-ai-practice";

export function OnboardingSource({ context, practice }: { context: WorkspaceContext; practice?: boolean }) {
  return (
    <Card
      id="ai-setup"
      title="Set up your support AI"
      description="Add a public page your team uses to answer questions."
      actions={
        <button type="button" className={styles.openSetup} onClick={() => context.go("knowledge")}>
          Open AI setup <IconArrowUpRight aria-hidden="true" size={16} />
        </button>
      }
    >
      <SourceUrlForm context={context} />
      {practice && <TrialAiPractice context={context} />}
    </Card>
  );
}

export function SourceUrlForm({
  context,
  onSaved,
}: {
  context: WorkspaceContext;
  onSaved?: () => void;
}) {
  const { room, account } = context;
  const [sourceType, setSourceType] = useState<"page" | "sitemap">("page");
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
      const result = await addKnowledge(room, account, {
        action: sourceType === "sitemap" ? "add-sitemap" : "add-doc",
        url: url.trim(),
        era: "current",
        visibility: "member-safe",
      });
      if ("added" in result) {
        setNotice(
          `${result.added} ${result.added === 1 ? "page" : "pages"} added from this sitemap.`,
        );
      } else if (
        result.status === "ready" &&
        result.chunks > 0 &&
        !result.error
      ) {
        setNotice("Page ready for AI replies.");
      } else if (result.status === "pending") {
        setNotice("Page saved. Templ will read it before AI can use it.");
      } else {
        setError(
          "This page has no usable text yet. Check the address or add another page.",
        );
      }
      if (!("added" in result) || result.added > 0)
        trackEvent("brain_source_added");
      setUrl("");
      onSaved?.();
    } catch {
      setError(
        "Could not add this page. Check the public web address and try again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <form className={styles.sourceForm} onSubmit={save}>
        <div className={styles.sourceTypes} role="group" aria-label="Source type">
          {(["page", "sitemap"] as const).map((type) => (
            <button
              key={type}
              type="button"
              disabled={busy}
              aria-pressed={sourceType === type}
              onClick={() => {
                setSourceType(type);
                setNotice("");
                setError("");
              }}
            >
              {type === "page" ? <IconFileText aria-hidden="true" size={16} /> : <IconSitemap aria-hidden="true" size={16} />}
              {type === "page" ? "Web page" : "Sitemap"}
            </button>
          ))}
        </div>
        <div className={styles.sourceEntry}>
          <Field
            label={
              sourceType === "page" ? "Public page URL" : "Public sitemap URL"
            }
          >
            <input
              className={ui.input}
              type="url"
              autoComplete="off"
              placeholder={
                sourceType === "page"
                  ? "https://example.com/docs"
                  : "https://example.com/sitemap.xml"
              }
              required
              value={url}
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <button
            type="submit"
            className="button"
            disabled={busy || !account || !url.trim()}
          >
            {busy
              ? "Adding…"
              : sourceType === "page"
                ? "Add page"
                : "Add sitemap"}
          </button>
        </div>
      </form>
      {notice && (
        <p className={layout.feedback} role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={layout.feedback} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
