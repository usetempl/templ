"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  IconChevronDown,
  IconHandStop,
  IconRobot,
  IconUserShare,
} from "@tabler/icons-react";
import type { TeamConversation } from "@templ/chat/index";
import {
  SUPPORT_AI_MODES,
  SUPPORT_HANDOFF_REASONS,
  type SupportAiMode,
  type SupportAiModeCause,
  type SupportAiView,
  type SupportHandoffReason,
} from "@templ/chat/support";
import { copy as t, type MessageKey } from "@/lib/copy";
import { aiDraftModeLabel } from "@/lib/copy/room";
import { handoffChip, type StateLineValue } from "@/lib/inbox-turn";
import { StateLine } from "./state-line";
import styles from "./ai-control.module.css";

/** The AI mode of one request, for people on the team. The server enforces
 * it on the workspace's registered AI agent; these controls only ask for a
 * change. Members never see any of it. */

const MODE_KEYS: Record<SupportAiMode, MessageKey> = {
  answers: "room.ai.answers",
  drafts: "room.ai.drafts",
  off: "room.ai.off",
};
const MODE_HINT_KEYS: Record<SupportAiMode, MessageKey> = {
  answers: "room.ai.answersHint",
  drafts: "room.ai.draftsHint",
  off: "room.ai.offHint",
};
const CAUSE_KEYS: Record<SupportAiModeCause, MessageKey> = {
  "person-set": "room.ai.cause.personSet",
  "take-over": "room.ai.cause.takeOver",
  "person-reply": "room.ai.cause.personReply",
  "person-claim": "room.ai.cause.personClaim",
  "person-assign": "room.ai.cause.personAssign",
  "person-typing": "room.ai.cause.personTyping",
  "person-thread": "room.ai.cause.personThread",
  transaction: "room.ai.cause.transaction",
};
/** Staff labels for every handoff reason. Exhaustive, so a new code fails
 * the type check until it has a label. */
const REASON_KEYS: Record<SupportHandoffReason, MessageKey> = {
  quote: "room.handoff.reason.quote",
  privacy: "room.handoff.reason.privacy",
  account: "room.handoff.reason.account",
  billing: "room.handoff.reason.billing",
  legal: "room.handoff.reason.legal",
  safety: "room.handoff.reason.safety",
  transaction: "room.handoff.reason.transaction",
  bug: "room.handoff.reason.bug",
  person: "room.handoff.reason.person",
  unsure: "room.handoff.reason.unsure",
  other: "room.handoff.reason.other",
  strategy: "room.handoff.reason.strategy",
  access: "room.handoff.reason.access",
  recovery: "room.handoff.reason.recovery",
  decision: "room.handoff.reason.decision",
  internal: "room.handoff.reason.internal",
};
export function aiModeLabel(mode: SupportAiMode, draftsEnabled = false) {
  return mode === "drafts"
    ? aiDraftModeLabel(draftsEnabled)
    : t(MODE_KEYS[mode]);
}
/** Why the mode last changed, with the person's label when a person did. */
export function aiCauseText(cause: SupportAiModeCause, name?: string) {
  return t(CAUSE_KEYS[cause], { name: name ?? t("room.ai.someone") });
}
export function handoffReasonLabel(reason: SupportHandoffReason) {
  return t(REASON_KEYS[reason]);
}
export function isHandoffReason(value: unknown): value is SupportHandoffReason {
  return SUPPORT_HANDOFF_REASONS.includes(value as SupportHandoffReason);
}

const since = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const sinceDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
/** "a moment ago", "5 minutes ago", "2 hours ago", then the date. */
function sinceText(value: string, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "a moment ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return since.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return since.format(-hours, "hour");
  return sinceDay.format(new Date(time));
}

/** The AI mode and why it changed, or its workspace default. */
export function aiStatusText(
  ai: SupportAiView,
  name: (principalId: string) => string,
  now = Date.now(),
  draftsEnabled = false,
): StateLineValue {
  const state = aiModeLabel(ai.mode, draftsEnabled);
  if (!ai.set || !ai.cause) return { state, detail: t("room.ai.defaultLine") };
  const detail = [
    aiCauseText(ai.cause, ai.changedBy ? name(ai.changedBy) : undefined),
    ai.changedAt ? sinceText(ai.changedAt, now) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { state, detail };
}

/** Why "AI answers" can't be picked now, or null when it can. */
function aiAnswersBlocked(
  handoff: TeamConversation["handoff"],
  replyHasText: boolean,
) {
  if (handoff?.by === "member") return t("room.ai.memberAsked");
  if (replyHasText) return t("room.ai.clearFirst");
  return null;
}

/** One open popover at a time, closed by Escape, a click outside or a pick. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return { open, setOpen, close, root, trigger };
}
/** Arrow keys, Home and End move between the menu's items; Escape closes. */
function menuKeys(
  event: KeyboardEvent<HTMLElement>,
  close: (restoreFocus: boolean) => void,
) {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"],[role="menuitem"]',
    ),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const move = (index: number) => {
    event.preventDefault();
    items[(index + items.length) % items.length]?.focus();
  };
  if (event.key === "ArrowDown") move(at + 1);
  else if (event.key === "ArrowUp") move(at < 0 ? items.length - 1 : at - 1);
  else if (event.key === "Home") move(0);
  else if (event.key === "End") move(items.length - 1);
  else if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    close(event.key === "Escape");
  }
}

/** The AI control: the mode, takeover action and change reason share one
 * menu. The header keeps one
 * state line. Hidden while the workspace has no registered AI agent. */
export function AiControl({
  draftsEnabled = false,
  ai,
  handoff,
  replyHasText,
  teammateWriting,
  canManage,
  busy,
  name,
  onChoose,
  onGenerate,
}: {
  ai: SupportAiView | null | undefined;
  draftsEnabled?: boolean;
  handoff: TeamConversation["handoff"];
  /** The viewer's own reply box has text: their next presence ping would
   * switch the AI back to drafts only. */
  replyHasText: boolean;
  /** Another person's presence says they are composing a reply here. */
  teammateWriting: boolean;
  /** Shows the Settings link for the workspace default. */
  canManage: boolean;
  busy: boolean;
  name: (principalId: string) => string;
  onChoose: (mode: SupportAiMode, takeOver?: true) => void;
  onGenerate?: () => void;
}) {
  const { open, setOpen, close, root, trigger } = usePopover();
  const menuId = useId();
  const hintId = useId();
  const blockedId = useId();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.focus({ preventScroll: true });
  }, [open]);
  if (!ai?.agentRegistered) return null;
  const blocked = aiAnswersBlocked(handoff, replyHasText);
  const generating = ai.generation === "queued" || ai.generation === "dispatched";
  const takeOver = ai.mode === "answers" || handoff?.by === "agent";
  const choose = (mode: SupportAiMode) => {
    if (mode === "answers" && blocked) return;
    close(true);
    if (mode !== ai.mode) onChoose(mode);
  };
  const quick = takeOver ? (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={styles.item}
      disabled={busy}
      onClick={() => {
        close(true);
        onChoose("drafts", true);
      }}
    >
      <IconHandStop size={16} aria-hidden="true" /> {t("room.ai.takeOver")}
    </button>
  ) : ai.mode === "drafts" ? (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={styles.item}
      aria-disabled={blocked ? true : undefined}
      aria-describedby={blocked ? blockedId : undefined}
      disabled={busy}
      onClick={() => {
        if (!blocked) {
          close(true);
          onChoose("answers");
        }
      }}
    >
      <IconRobot size={16} aria-hidden="true" /> {t("room.ai.letAnswer")}
    </button>
  ) : null;
  return (
    <div className={styles.control}>
      <div className={styles.actions}>
        <div className={styles.anchor} ref={root}>
          <button
            ref={trigger}
            type="button"
            className={styles.menuButton}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={`${t("room.ai.menu")}: ${aiModeLabel(ai.mode, draftsEnabled)}`}
            disabled={busy}
            onClick={() => setOpen(!open)}
          >
            <IconRobot size={15} aria-hidden="true" />
            <span>{aiModeLabel(ai.mode, draftsEnabled)}</span>
            <IconChevronDown size={14} aria-hidden="true" />
          </button>
          {open && (
            <div className={styles.popover} data-align="start">
              <p className={styles.popoverTitle}>{t("room.ai.menu")}</p>
              <p className={styles.status}>
                <StateLine
                  value={aiStatusText(ai, name, undefined, draftsEnabled)}
                />
              </p>
              <div
                ref={list}
                id={menuId}
                role="menu"
                aria-label={t("room.ai.menu")}
                className={styles.menu}
                onKeyDown={(event) => menuKeys(event, close)}
              >
                {quick}
                {SUPPORT_AI_MODES.map((mode) => {
                  const disabled = mode === "answers" && Boolean(blocked);
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={ai.mode === mode}
                      aria-disabled={disabled || undefined}
                      aria-describedby={`${hintId}-${mode}`}
                      tabIndex={ai.mode === mode ? 0 : -1}
                      className={styles.item}
                      onClick={() => choose(mode)}
                    >
                      <span className={styles.itemLabel}>
                        {aiModeLabel(mode, draftsEnabled)}
                      </span>
                      <span id={`${hintId}-${mode}`} className={styles.hint}>
                        {disabled ? blocked : t(MODE_HINT_KEYS[mode])}
                      </span>
                    </button>
                  );
                })}
              </div>
              {blocked && ai.mode === "drafts" && !takeOver && (
                <p id={blockedId} className={styles.fine}>
                  {blocked}
                </p>
              )}
              {teammateWriting && (
                <p className={styles.warn}>{t("room.ai.teammateWriting")}</p>
              )}
              <p className={styles.fine}>{t("room.ai.rule")}</p>
              <p className={styles.fine}>
                {canManage
                  ? t.rich(
                      "room.ai.defaultManager",
                      {
                        settings: (chunks) => (
                          <a href="?tab=knowledge#ai-agent">{chunks}</a>
                        ),
                      },
                      { mode: aiModeLabel(ai.default, draftsEnabled) },
                    )
                  : t("room.ai.defaultStaff", {
                      mode: aiModeLabel(ai.default, draftsEnabled),
                    })}
              </p>
            </div>
          )}
        </div>
        {onGenerate && ai.generateAvailable && ai.mode === "answers" && (
          <button type="button" className={styles.menuButton} disabled={busy || Boolean(blocked) || generating || ["failed", "cancelled", "answered", "handed-off"].includes(ai.generation ?? "")} onClick={onGenerate}>
            <IconRobot size={15} aria-hidden="true" />
            {generating ? t("room.ai.preparing") : t("room.ai.generate")}
          </button>
        )}
      </div>
      {onGenerate && ai.generation === "failed" && <p role="status" className={styles.warn}>{t("room.ai.generationFailed")}</p>}
      {onGenerate && generating && <p role="status" className={styles.fine}>{t("room.ai.generationPending")}</p>}
      {teammateWriting && !open && (
        <p className={styles.warn}>{t("room.ai.teammateWriting")}</p>
      )}
    </div>
  );
}

/** "Hand off" for people: a menu of fixed reasons. It posts no message and
 * the member sees that the team will reply. */
export function HandOffMenu({
  agentRegistered,
  busy,
  onHandOff,
}: {
  agentRegistered: boolean;
  busy: boolean;
  onHandOff: (reason: SupportHandoffReason) => void;
}) {
  const { open, setOpen, close, root, trigger } = usePopover();
  const titleId = useId();
  const menuId = useId();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div className={styles.anchor} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="button small secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        <IconUserShare size={16} aria-hidden="true" />{" "}
        {t("room.handoff.button")}
      </button>
      {open && (
        <div className={styles.popover} data-align="start">
          <p id={titleId} className={styles.popoverTitle}>
            {t("room.handoff.menuTitle")}
          </p>
          <p className={styles.fine}>
            {agentRegistered
              ? t("room.handoff.help")
              : t("room.handoff.helpNoAgent")}
          </p>
          <div
            ref={list}
            id={menuId}
            role="menu"
            aria-labelledby={titleId}
            className={`${styles.menu} ${styles.reasons}`}
            onKeyDown={(event) => menuKeys(event, close)}
          >
            {SUPPORT_HANDOFF_REASONS.map((reason, index) => (
              <button
                key={reason}
                type="button"
                role="menuitem"
                tabIndex={index === 0 ? 0 : -1}
                className={styles.item}
                onClick={() => {
                  close(true);
                  onHandOff(reason);
                }}
              >
                <span className={styles.itemLabel}>
                  {handoffReasonLabel(reason)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function HandoffBanner({
  handoff,
}: {
  handoff: NonNullable<TeamConversation["handoff"]>;
}) {
  const titleId = useId();
  const time = sinceText(handoff.at);
  const byline =
    handoff.by === "member"
      ? t("room.handoff.byMember", { time })
      : handoff.by === "agent"
        ? t("room.handoff.byAgent", { time })
        : t("room.handoff.byPerson", { time });
  return (
    <section className={styles.banner} aria-labelledby={titleId}>
      <div className={styles.bannerText}>
        <strong id={titleId}>{handoffChip(handoff)}</strong>
        <span>
          <time
            dateTime={handoff.at}
            title={new Date(handoff.at).toLocaleString()}
          >
            {byline}
          </time>
        </span>
      </div>
    </section>
  );
}
