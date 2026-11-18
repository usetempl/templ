"use client";

import { useEffect, useState } from "react";
import { IconDeviceMobile, IconDeviceMobileOff } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import { copy as t } from "@/lib/copy";
import {
  disablePush,
  enablePush,
  PushBlocked,
  pushSupported,
  readPushStatus,
  syncPush,
} from "@/lib/staff-push";
import styles from "./rail.module.css";

type View =
  | { kind: "hidden" }
  | { kind: "ready"; publicKey: string; on: boolean };

/** "Push alerts on this device": a push with no text when a request needs
 * someone, for this workspace in this browser. It shows only where the
 * service sends pushes and this browser can take them. On means the
 * service holds this browser's address: it is checked on every load. */
export function PushAlertsToggle({ room, enabled = false }: { room: ChatRoomId; enabled?: boolean }) {
  const [view, setView] = useState<View>({ kind: "hidden" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<
    "phone.push.blocked" | "phone.push.failed" | null
  >(null);

  useEffect(() => {
    if (!enabled || !pushSupported()) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const status = await readPushStatus(room, controller.signal);
        if (controller.signal.aborted || !status.available || !status.publicKey)
          return;
        const on = await syncPush(room, status.publicKey);
        if (!controller.signal.aborted)
          setView({ kind: "ready", publicKey: status.publicKey, on });
      } catch {
        // No answer: nothing to offer.
      }
    })();
    return () => controller.abort();
  }, [room, enabled]);

  if (!enabled || view.kind === "hidden") return null;
  const { on, publicKey } = view;
  async function toggle() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      if (on) await disablePush(room);
      else await enablePush(room, publicKey);
      setView({ kind: "ready", publicKey, on: !on });
    } catch (reason) {
      setNote(
        reason instanceof PushBlocked
          ? "phone.push.blocked"
          : "phone.push.failed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.navGroup}>
      <button
        type="button"
        className={styles.navItem}
        aria-pressed={on}
        aria-busy={busy}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {on ? (
          <IconDeviceMobile aria-hidden="true" />
        ) : (
          <IconDeviceMobileOff aria-hidden="true" />
        )}
        <span className={styles.navText}>{t("phone.push.label")}</span>
        {on && (
          <span className={styles.navBadge} aria-hidden="true">
            On
          </span>
        )}
      </button>
      {note ? (
        <p className={styles.railNote} role="status">
          {t(note)}
        </p>
      ) : (
        on && <p className={styles.railNote}>{t("phone.push.privacy")}</p>
      )}
    </div>
  );
}
