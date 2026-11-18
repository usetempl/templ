"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconPrompt,
} from "@tabler/icons-react";
import styles from "./integration-prompt.module.css";

/** What the status line says after a copy. */
export const COPIED_LINE =
  "Copied. Paste it into your AI coding tool, in your app’s repo.";
export const MANUAL_LINE = "Select the prompt and copy it.";
/** How many lines of the prompt the closed card shows. */
const PREVIEW_LINES = 3;

/** The install prompt as a card: the first lines, one copy button and a
 * text toggle that shows the whole prompt. After a copy the status line
 * says where to paste it, then `next`, and stays until the page changes. */
export function IntegrationPrompt({
  prompt,
  label,
  primary = false,
  againLabel,
  copied = false,
  manualEvent,
  families,
  note,
  compact = false,
  next,
  onCopied,
}: {
  prompt: string;
  label: string;
  primary?: boolean;
  /** The button's label once the prompt is copied. With it, the button
   * stops being primary after a copy, so `next` is the card's one action. */
  againLabel?: string;
  /** The prompt was copied elsewhere on this page: show `next` here too. */
  copied?: boolean;
  /** A window event that opens the whole prompt, selected, for a copy by
   * hand, as after a failed copy from this card. */
  manualEvent?: string;
  /** Wallet families the prompt covers, shown as chips. */
  families?: readonly string[];
  /** A line under the button before the first copy. */
  note?: ReactNode;
  /** Keep the hero's prompt closed and compact on phones. */
  compact?: boolean;
  /** The next step, shown after a successful copy. */
  next?: ReactNode;
  /** Runs once per successful clipboard write. */
  onCopied?: () => void;
}) {
  const fieldId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "copying" | "copied" | "manual"
  >("idle");
  // The button shows its check for a moment; the next step stays.
  const [flash, setFlash] = useState(false);
  // Counts manual requests, so a second one focuses the field again.
  const [manualTick, setManualTick] = useState(0);
  useEffect(() => {
    if (!manualEvent) return;
    const openManual = () => {
      setExpanded(true);
      setStatus("manual");
      setManualTick((tick) => tick + 1);
    };
    window.addEventListener(manualEvent, openManual);
    return () => window.removeEventListener(manualEvent, openManual);
  }, [manualEvent]);
  useEffect(() => {
    if (status !== "manual" || !field.current) return;
    field.current.focus({ preventScroll: true });
    field.current.select();
    field.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [status, manualTick]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), 3000);
    return () => window.clearTimeout(timer);
  }, [flash]);
  async function copy() {
    if (status === "copying") return;
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      setExpanded(true);
      setStatus("manual");
      setManualTick((tick) => tick + 1);
      return;
    }
    setStatus("copied");
    setFlash(true);
    onCopied?.();
  }
  const done = status === "copied" || (copied && status !== "manual");
  const lowered = done && againLabel !== undefined;
  const preview = prompt
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, PREVIEW_LINES);
  return (
    <div className={`${styles.promptCard} ${compact ? styles.compact : ""}`}>
      <div className={styles.promptHead}>
        <p className={styles.promptLabel}>
          <IconPrompt aria-hidden="true" /> Prompt for your AI coding tool
        </p>
        {families && families.length > 0 && (
          <ul className={styles.families} aria-label="Works in">
            {families.map((family) => (
              <li key={family}>{family}</li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.promptPreview} aria-hidden={expanded}>
        {preview.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className={styles.promptToolbar}>
        <button
          type="button"
          className={styles.promptRead}
          aria-expanded={expanded}
          aria-controls={fieldId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide the prompt" : "Read it first"}
          <IconChevronDown aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${styles.promptCopy} ${primary && !lowered ? styles.promptPrimary : ""}`}
          disabled={status === "copying"}
          onClick={() => void copy()}
        >
          {flash ? (
            <IconCheck aria-hidden="true" />
          ) : (
            <IconCopy aria-hidden="true" />
          )}
          {status === "copying"
            ? "Copying prompt"
            : flash
              ? "Prompt copied"
              : lowered
                ? againLabel
                : label}
        </button>
      </div>
      <div className={styles.promptSource} hidden={!expanded}>
        <textarea
          ref={field}
          id={fieldId}
          aria-label="Prompt text"
          readOnly
          value={prompt}
          rows={12}
          spellCheck={false}
        />
      </div>
      <div role="status" className={styles.promptStatus}>
        {status === "copying" ? (
          <p>Copying prompt.</p>
        ) : status === "manual" ? (
          <p>{MANUAL_LINE}</p>
        ) : done ? (
          <>
            <p>{COPIED_LINE}</p>
            {next && <p className={styles.next}>{next}</p>}
          </>
        ) : (
          note && <p className={styles.note}>{note}</p>
        )}
      </div>
    </div>
  );
}
