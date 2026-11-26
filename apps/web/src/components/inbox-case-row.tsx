import type { ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import styles from "./team-conversations.module.css";

/** The same readable case row in the staff inbox and the landing's sample. */
export function InboxCaseRow({
  label,
  avatar,
  time,
  requestPreview,
  verified = false,
  selected = false,
  unread = false,
  busy = false,
  humanRequest = false,
  onOpen,
  selectionChecked,
  disabled,
  children,
}: {
  label: string;
  avatar: ReactNode;
  time: ReactNode;
  requestPreview?: string;
  verified?: boolean;
  selected?: boolean;
  unread?: boolean;
  busy?: boolean;
  humanRequest?: boolean;
  onOpen?: () => void;
  selectionChecked?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const preview = requestPreview?.trim();
  const content = (
    <>
      <span className={styles.rowAvatar}>{avatar}</span>
      <span className={styles.rowBody}>
        <span className={styles.rowTop}>
          <strong title={label || preview}>
            {label || preview}
            {verified && (
              <IconCheck
                className={styles.verifiedMark}
                size={14}
                aria-hidden="true"
              />
            )}
          </strong>
          {time}
        </span>
        {label && preview && (
          <span className={styles.rowPreview}>
            <span className={styles.srOnly}>Latest user message: </span>
            {preview}
          </span>
        )}
        {children}
      </span>
    </>
  );
  const state = {
    className: styles.row,
    "data-selected": selected,
    "data-unread": unread,
    "data-human-request": humanRequest,
  };
  return onOpen ? (
    <button
      {...state}
      type="button"
      aria-busy={busy || undefined}
      aria-current={selectionChecked === undefined && selected ? "true" : undefined}
      aria-pressed={selectionChecked}
      disabled={disabled}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <div {...state} data-static="true">
      {content}
    </div>
  );
}
