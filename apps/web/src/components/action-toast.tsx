"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconInfoCircle, IconX } from "@tabler/icons-react";
import { copy as t } from "@/lib/copy";
import styles from "./action-toast.module.css";

/** Render the notice inside its dialog so it stays in the same top layer.
 * The caller supplies the notice text; this adds its dismiss control. */
export function useActionToast() {
  const [notice, setNotice] = useState<{ text: string; id: number }>();
  const nextId = useRef(0);
  const dismiss = useCallback(() => setNotice(undefined), []);
  const show = useCallback((text: string) => {
    setNotice({ text, id: ++nextId.current });
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismiss, 6_000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  const toast = (
    <div
      className={styles.region}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {notice && (
        <div className={styles.toast} key={notice.id}>
          <IconInfoCircle size={22} aria-hidden="true" />
          <span>{notice.text}</span>
          <button
            type="button"
            aria-label={t("shell.toast.dismiss")}
            onClick={dismiss}
          >
            <IconX size={18} />
          </button>
        </div>
      )}
    </div>
  );
  return { show, toast };
}
