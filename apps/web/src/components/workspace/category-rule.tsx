"use client";

import { useEffect, useState } from "react";
import type { SupportQualityOverview } from "@templ/chat/support-quality";
import { readQuality, saveQuality } from "@/lib/knowledge-client";
import { Card, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import { UnsavedChanges } from "./unsaved-changes";
import layout from "./workspace-settings.module.css";

export function CategoryRule({ context }: { context: WorkspaceContext }) {
  const [overview, setOverview] = useState<SupportQualityOverview>();
  const [chosen, setChosen] = useState<boolean>();
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    readQuality(context.room, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setOverview(value);
          setError("");
        }
      },
      () => {
        if (!controller.signal.aborted)
          setError("The category rule could not load.");
      },
    );
    return () => controller.abort();
  }, [context.room, attempt]);
  const settings = overview?.settings;
  const value = chosen ?? settings?.requireCategory ?? false;
  const dirty = Boolean(settings && value !== settings.requireCategory);
  async function save() {
    if (!settings || !overview?.canEdit || !dirty || !confirmed || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveQuality(
        context.room,
        context.account,
        { requireCategory: value },
        true,
      );
      setOverview(result);
      setChosen(undefined);
      setConfirmed(false);
      setNotice("Category rule saved.");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The category rule could not save.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Category before resolving"
      description="Choose whether your team must pick a category before resolving each case."
    >
      <UnsavedChanges dirty={dirty} />
      {!settings ? (
        error ? null : (
          <Spinner />
        )
      ) : (
        <div className={layout.panelBody}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={value}
              disabled={busy || !overview?.canEdit}
              onChange={(event) => {
                setChosen(event.target.checked);
                setConfirmed(false);
                setNotice("");
              }}
            />
            Require a category
          </label>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!dirty || busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I checked these settings.
          </label>
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={!dirty || !confirmed || busy}
              onClick={() => void save()}
            >
              {busy && <Spinner />}Save category rule
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className={layout.feedback}>
          {error}
        </p>
      )}
      {error && !settings && (
        <button
          type="button"
          className="button secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      )}
      {notice && (
        <p role="status" className={layout.feedback}>
          {notice}
        </p>
      )}
    </Card>
  );
}
