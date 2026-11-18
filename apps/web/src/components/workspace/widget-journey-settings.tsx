"use client";

import { useEffect, useRef, useState } from "react";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import { trackEvent } from "@/lib/analytics";
import { chatMutation } from "@/lib/chat-api";
import { Card, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

type Settings = {
  walletFallback: boolean;
  askPerson: boolean;
  hostedPage: boolean;
};
type ReadSettings = Partial<Settings> & { options?: { hostedPage?: boolean } };
const checked = (data: ReadSettings): Settings => ({
  walletFallback: data.walletFallback !== false,
  askPerson: data.askPerson !== false,
  hostedPage: data.hostedPage === true,
});
const fields = [
  {
    key: "walletFallback",
    label: "Let people ask when their wallet won't connect",
    detail:
      "They appear as Guest with a wallet connection note. Other cases still need the wallet level you chose.",
  },
  {
    key: "askPerson",
    label: "Show Talk to a person",
    detail: "Asking for a person stops AI replies on that case.",
  },
] as const;

export function WidgetJourneySettings({
  context,
}: {
  context: WorkspaceContext;
}) {
  const { room, account } = context;
  const scope = `${room}:${account ?? "signed-out"}`;
  const current = useRef(scope);
  const [settings, setSettings] = useState<Settings>();
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [attempt, setAttempt] = useState(0);
  const [hostedAvailable, setHostedAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    current.current = scope;
    void communityFetch<ReadSettings>(
      roomPath(room, "widget"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setSettings(checked(data));
          setHostedAvailable(data.options?.hostedPage === true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load guest support settings.");
      });
    return () => controller.abort();
  }, [room, scope, attempt]);
  const selected = settings ? { ...settings, ...draft } : undefined;
  const changed = settings
    ? (Object.keys(draft) as (keyof Settings)[]).filter(
        (key) => draft[key] !== settings[key],
      )
    : [];
  const edit = (key: keyof Settings, value: boolean) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setNotice("");
  };
  async function save() {
    if (!settings || !changed.length || busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const data = await chatMutation<ReadSettings>(
        account as never,
        roomPath(room, "widget"),
        {
          ...Object.fromEntries(changed.map((key) => [key, draft[key]])),
          confirmed: true,
        },
      );
      if (current.current !== scope) return;
      setSettings(checked(data));
      setDraft({});
      setNotice("Saved.");
      for (const key of changed)
        trackEvent(
          key === "hostedPage"
            ? "widget_hosted_page_saved"
            : key === "askPerson"
              ? "widget_person_control_saved"
              : "widget_wallet_fallback_saved",
        );
    } catch (reason) {
      trackEvent("widget_journey_settings_failed");
      console.warn(
        JSON.stringify({
          event: "TEMPL_SUPPORT_FAILURE",
          route: "widget-journey-settings",
          reason:
            reason instanceof CommunityApiError
              ? "service-refused"
              : "connection-failed",
        }),
      );
      if (current.current === scope)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not save the setting.",
        );
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  return (
    <Card title="Guest support">
      <UnsavedChanges dirty={changed.length > 0} />
      <div className={styles.stack}>
        {!settings && !error && (
          <p role="status">
            <Spinner /> Loading settings…
          </p>
        )}
        {settings &&
          fields.map(({ key, label, detail }) => (
            <div key={key}>
              <label className={ui.check}>
                <input
                  type="checkbox"
                  checked={selected![key]}
                  disabled={busy}
                  onChange={(event) => edit(key, event.target.checked)}
                />
                {label}
              </label>
              <p className={styles.small}>{detail}</p>
            </div>
          ))}
        {settings && (hostedAvailable || settings.hostedPage) && (
          <div>
            <label className={ui.check}>
              <input
                type="checkbox"
                checked={selected!.hostedPage}
                disabled={busy}
                onChange={(event) => edit("hostedPage", event.target.checked)}
              />
              Host a support page on Templ
            </label>
            <p className={styles.small}>
              People can ask there if your app is down. Guests can use this page
              without a wallet.
            </p>
            {hostedAvailable && settings.hostedPage && (
              <a href={`/help/${context.id}`}>Open your support page</a>
            )}
          </div>
        )}
        {settings && (
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !changed.length}
              onClick={() => void save()}
            >
              {busy && <Spinner />}Save guest support
            </button>
          </div>
        )}
        {!settings && error && (
          <div>
            <button
              type="button"
              className="button secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {(notice || error) && (
          <p
            role={error ? "alert" : "status"}
            className={error ? styles.error : styles.status}
          >
            {error || notice}
          </p>
        )}
      </div>
    </Card>
  );
}
