"use client";

import { useEffect, useRef, useState } from "react";
import { IconCopy } from "@tabler/icons-react";
import Link from "next/link";
import { trackEvent } from "@/lib/analytics";
import { startInstallPrompt } from "@/lib/support-integration-prompt";
import styles from "./landing-install.module.css";

export const CREATE_CHAT_URL = "/create";
export const TEMPL_SOURCE_URL = "https://github.com/usetempl/templ";

export function InstallPromptButton({ className }: { className?: string }) {
  const [status, setStatus] = useState<
    "idle" | "copying" | "copied" | "manual"
  >("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const prompt = startInstallPrompt();
  useEffect(() => {
    if (status !== "manual") return;
    field.current?.focus();
    field.current?.select();
  }, [status]);
  async function copy() {
    if (status === "copying") return;
    trackEvent("install_prompt_clicked");
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      setStatus("manual");
      return;
    }
    setStatus("copied");
    trackEvent("prompt_copied");

  }
  return (
    <div className={styles.install}>
      <button
        type="button"
        className={className}
        disabled={status === "copying"}
        onClick={() => void copy()}
      >
        <IconCopy aria-hidden="true" />
        {status === "copying"
          ? "Copying prompt"
          : status === "copied"
            ? "Prompt copied"
            : "Copy install prompt"}
      </button>
      {status === "manual" && (
        <textarea
          ref={field}
          className={styles.prompt}
          aria-label="Install prompt"
          readOnly
          value={prompt}
          rows={8}
        />
      )}
      {status !== "idle" && (
        <p className={styles.status} role="status">
          {status === "manual"
            ? "Select the prompt and copy it."
            : status === "copied"
              ? "Paste it into your AI coding tool, inside your app’s code."
              : "Copying prompt."}
        </p>
      )}
    </div>
  );
}

export function LandingActions({ id, selfHost = false }: {
  id: string;
  selfHost?: boolean;
}) {
  return (
    <div id={id} className={styles.actions}>
      <div className={styles.pair}>
        <Link href={CREATE_CHAT_URL} className={styles.cta} data-templ-conversion="create_clicked">Create your chat</Link>
        {selfHost && <a className={styles.secondary} href={TEMPL_SOURCE_URL + "#try-a-complete-conversation"}>
          Self-host Templ
        </a>}
      </div>
    </div>
  );
}
