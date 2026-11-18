"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { useEffect, useState } from "react";
import {
  INSTALL_CHECK_IDS,
  INSTALL_CHECK_LABELS,
  installCheckComplete,
  type InstallCheckRecord,
} from "@templ/chat/support-install-check";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { communityFetch, roomPath } from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { trackEvent } from "@/lib/analytics";
import { Card, Field } from "@/components/ui/ui";
import controls from "@/components/ui/design-system.module.css";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";

export function WidgetInstallCheck({ context }: { context: WorkspaceContext }) {
  const [check, setCheck] = useState<InstallCheckRecord | null>(null);
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = roomPath(context.room, "widget/install-check");
  const admin = canManageWorkspace({
    isManager: context.manager,
    permissions: context.state?.viewer?.permissions,
  });
  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    const read = () =>
      void communityFetch<{ check: InstallCheckRecord | null }>(
        path,
        undefined,
        controller.signal,
      ).then(
        (data) => {
          if (!controller.signal.aborted) {
            setCheck(data.check);
            if (installCheckComplete(data.check))
              trackEvent("install_check_completed");
            setError("");
          }
        },
        () => {
          if (!controller.signal.aborted)
            setError("Install check results could not load. Retrying…");
        },
      );
    read();
    const timer = setInterval(read, FEATURE_LIMITS.installCheckPollMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, admin]);
  if (!admin) return null;
  async function start() {
    let origin: string;
    try {
      const value = website.trim();
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`,
      );
      if (
        url.username ||
        url.password ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw new Error();
      origin = url.origin;
    } catch {
      setError(
        "Enter an HTTPS website address. Localhost needs local testing enabled.",
      );
      return;
    }
    setBusy(true);
    setError("");
    trackEvent("install_check_started");
    const page = window.open("about:blank", "_blank");
    if (page) page.opener = null;
    try {
      const result = await chatMutation<{ token: string }>(
        context.account as never,
        path,
        { origin },
      );
      const target = `${origin}/#templ-check=${encodeURIComponent(result.token)}`;
      if (page) page.location.href = target;
      else {
        setError("Allow this page to open a new tab, then check again.");
        trackEvent("install_check_failed");
        console.warn("TEMPL_INSTALL_CHECK_FAILED", { cause: "popup-blocked" });
      }
    } catch {
      page?.close();
      setError("Could not start the install check. Try again.");
      trackEvent("install_check_failed");
      console.warn("TEMPL_INSTALL_CHECK_FAILED", { cause: "request-failed" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Check your install"
      description="Enter your app’s website. Open support there and follow the steps in the chat."
    >
      <div className={styles.stack}>
        <form
          className={styles.stack}
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <Field label="Website to check" error={error}>
            <input
              className={controls.input}
              type="text"
              inputMode="url"
              placeholder="https://app.example.com"
              value={website}
              onChange={(event) => {
                setWebsite(event.target.value);
                setError("");
              }}
              autoComplete="url"
              spellCheck={false}
              required
            />
          </Field>
          <button
            className="button"
            type="submit"
            disabled={!website.trim() || busy}
          >
            {busy ? "Opening check…" : "Check my install"}
          </button>
        </form>
        {check && (
          <ol>
            {INSTALL_CHECK_IDS.map((id) => {
              const row = check.results.find((item) => item.id === id);
              const copy = INSTALL_CHECK_LABELS[id];
              return (
                <li key={id}>
                  <strong>
                    {copy.label}:{" "}
                    {row ? (row.pass ? "Passed" : "Needs a fix") : "Waiting"}
                  </strong>
                  {row?.pass !== true && <p>{copy.fix}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
}
