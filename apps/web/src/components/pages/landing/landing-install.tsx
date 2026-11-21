"use client";

import { useEffect, useRef, useState } from "react";
import { IconCopy } from "@tabler/icons-react";
import { SITE_FUNNEL_PATHS } from "@templ/chat/funnel";
import { TemplSupportLink } from "@/components/templ-support";
import { trackEvent } from "@/lib/analytics";
import { startInstallPrompt } from "@/lib/support-integration-prompt";
import { SITE } from "@/lib/site-environment";
import styles from "./landing-install.module.css";

export const CONTACT_LABEL = "Try the chat";
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
    try {
      if (location.origin === SITE.origin)
        void fetch(`${SITE.community}${SITE_FUNNEL_PATHS.prompt_copied}`, {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          keepalive: true,
          referrerPolicy: "no-referrer",
        }).catch(() => {});
    } catch {
      // Optional measurement never blocks the copied prompt.
    }
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

export function LandingActions({
  id = "install",
  tone = "page",
  showContact = true,
  secondary = "install",
}: {
  id?: string;
  tone?: "page" | "band";
  showContact?: boolean;
  secondary?: "install" | "source";
}) {
  return (
    <div
      id={id}
      className={`${styles.actions} ${tone === "band" ? styles.band : ""}`}
    >
      <div className={styles.pair}>
        {showContact && (
          <TemplSupportLink className={styles.cta}>
            {CONTACT_LABEL}
          </TemplSupportLink>
        )}
        <a
          className={styles.secondary}
          href={secondary === "source" ? TEMPL_SOURCE_URL : "#install"}
        >
          {secondary === "source" ? "View source" : "Install in your app"}
        </a>
      </div>
    </div>
  );
}
