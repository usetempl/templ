"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconUser,
  IconWallet,
  IconX,
  IconMessages,
} from "@tabler/icons-react";
import type { ChatAuthorBadge, ChatAuthorFacts } from "@templ/chat/index";
import type { MemberProfile } from "@templ/chat/profiles";
import { getChatChain, type ChatChainId } from "@templ/chat/chains";
import { memberLabel } from "@/lib/member-profiles";
import { principalLabel } from "@templ/chat/principal";
import { copy, copy as t, type MessageKey, type Params } from "@/lib/copy";
import styles from "./member-identity.module.css";

/** How a member appears next to their messages.
 *
 * The name and picture are labels the account chose. Every badge comes from
 * `ChatAuthorFacts`, which the room service derives from its own records; the
 * component never reads a badge out of a name, and an account cannot give
 * itself one: only a workspace manager labels an AI agent. */
type MemberIdentitySize = "sm" | "md";
type MemberBadge = {
  key: ChatAuthorBadge | "role";
  label: string;
  title: string;
};
const BADGE_KEYS: Record<ChatAuthorBadge, MessageKey> = {
  manager: "room.identity.manager",
  moderator: "room.identity.moderator",
  bot: "room.identity.bot",
  team: "room.identity.team",
  managed: "room.identity.managed",
};
const BADGE_TITLE_KEYS: Record<ChatAuthorBadge, MessageKey> = {
  manager: "room.identity.managerTitle",
  moderator: "room.identity.moderatorTitle",
  bot: "room.identity.botTitle",
  // Current handling authority, granted by this community's
  // manager; a chosen name never produces it.
  team: "room.identity.teamTitle",
  managed: "room.identity.managedTitle",
};
const MAX_ROLE_BADGES = 4;
/** `t` for the plain helpers here; the English text when a caller passes none. */
type CopyFormatter = (key: MessageKey, params?: Params) => string;
const isAccount = (id: string) => id.startsWith("account:");
/** Badges to show for an author, from room facts only. Anything not in
 * `facts` is ignored, so a display name such as "Templ Admin" produces
 * nothing. */
export function memberBadges(
  facts: ChatAuthorFacts | undefined,
  t: CopyFormatter = copy,
): MemberBadge[] {
  const badges: MemberBadge[] = [];
  const seen = new Set<string>();
  for (const badge of facts?.badges ?? []) {
    if (!(badge in BADGE_KEYS) || seen.has(badge)) continue;
    seen.add(badge);
    badges.push({
      key: badge,
      label: t(BADGE_KEYS[badge]),
      title: t(BADGE_TITLE_KEYS[badge]),
    });
  }
  for (const name of (facts?.roleNames ?? []).slice(0, MAX_ROLE_BADGES)) {
    const label = typeof name === "string" ? name.trim() : "";
    if (!label || seen.has(`role:${label}`)) continue;
    seen.add(`role:${label}`);
    badges.push({
      key: "role",
      label,
      title: t("room.identity.roleTitle", { role: label }),
    });
  }
  return badges;
}

/** The picture inside an avatar frame. Callers supply the frame so the
 * message rail keeps its existing geometry. */
export function MemberAvatar({
  principalId,
  profile,
  size = "sm",
}: {
  principalId: string;
  profile?: MemberProfile | null;
  size?: MemberIdentitySize;
}) {
  const [broken, setBroken] = useState<string>();
  const src =
    profile?.avatar && broken !== profile.avatar ? profile.avatar : null;
  const iconSize = size === "md" ? 30 : 20;
  return src ? (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      loading="lazy"
      onError={() => setBroken(src)}
    />
  ) : isAccount(principalId) ? (
    <IconUser size={iconSize} aria-hidden="true" />
  ) : (
    <IconWallet size={iconSize} aria-hidden="true" />
  );
}

function MemberBadges({
  badges,
  className,
}: {
  badges: MemberBadge[];
  className?: string;
}) {
  if (!badges.length) return null;
  return (
    <>
      {badges.map((badge) => (
        <span
          key={`${badge.key}:${badge.label}`}
          className={className ?? styles.badge}
          data-badge={badge.key}
          title={badge.title}
        >
          {badge.label}
        </span>
      ))}
    </>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Details for one member. The raw principal is the only durable handle; the
 * name above it is whatever the account typed. */
function MemberInspection({
  principalId,
  profile,
  facts,
  chainId,
  viewer = false,
  onEditProfile,
  onAskTeam,
  onMessageAsTeam,
  onClose,
  labelledBy,
  anchor,
}: {
  principalId: string;
  profile?: MemberProfile | null;
  facts?: ChatAuthorFacts;
  chainId?: ChatChainId;
  viewer?: boolean;
  onEditProfile?: () => void;
  /** On a staff identity, opens the viewer's conversation with
   * the whole team; there is no private line to one moderator. */
  onAskTeam?: () => void;
  /** Staff with the power to start conversations write the first message of
   * this member's team thread from here; the thread then opens in the
   * stage. Never a private line: the whole team reads it. */
  onMessageAsTeam?: (text: string) => Promise<void>;
  onClose: () => void;
  labelledBy?: string;
  /** Clicks inside the anchor toggle the panel themselves. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [copied, setCopied] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const badges = memberBadges(facts, t);
  const label = memberLabel(profile, principalId);
  const account = isAccount(principalId);
  const explorer =
    !account && chainId ? getChatChain(chainId).explorer : undefined;
  // Only a room-derived staff badge offers the team thread; a chosen name
  // such as "Support" or "Admin" never does.
  const staff = Boolean(
    facts?.badges.some((badge) =>
      ["manager", "moderator", "team"].includes(badge),
    ),
  );
  // The panel is fixed so a scrolling message list cannot clip it. It sits
  // under the name when there is room and above it otherwise.
  useLayoutEffect(() => {
    const rect = anchor?.current?.getBoundingClientRect();
    const panel = dialog.current;
    if (!rect || !panel || typeof window === "undefined") return;
    const margin = 12;
    const width = panel.offsetWidth || 320;
    const height = panel.offsetHeight || 200;
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - width - margin),
    );
    const below = rect.bottom + 6;
    const top =
      below + height + margin <= window.innerHeight ||
      rect.top < height + margin
        ? below
        : rect.top - height - 6;
    panel.style.position = "fixed";
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }, [anchor]);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        element &&
        !element.contains(target) &&
        !anchor?.current?.contains(target)
      )
        onClose();
    };
    const moved = (event: Event) => {
      if (!element?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
      previous?.focus();
    };
  }, [onClose, anchor]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  function trap(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;
    const items = Array.from(
      dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <div
      ref={dialog}
      className={styles.inspection}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy ?? headingId}
      onKeyDown={trap}
    >
      <div className={styles.inspectionHeader}>
        <span className={styles.inspectionAvatar} data-size="md">
          <MemberAvatar principalId={principalId} profile={profile} size="md" />
        </span>
        <div className={styles.inspectionTitle}>
          <strong id={labelledBy ? undefined : headingId}>{label}</strong>
          <span className={styles.kind}>
            {account
              ? t("room.identity.memberAccount")
              : t("room.identity.walletAccount")}
          </span>
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label={t("room.identity.close")}
          onClick={onClose}
        >
          <IconX size={16} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.principalRow}>
        <code className={styles.principal} title={principalId}>
          {principalId}
        </code>
        <button
          type="button"
          className={styles.copy}
          title={t("room.identity.copyIdTitle", { id: principalId })}
          aria-label={t("room.identity.copyIdLabel", {
            id: principalLabel(principalId),
          })}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(principalId)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? (
            <IconCheck size={14} aria-hidden="true" />
          ) : (
            <IconCopy size={14} aria-hidden="true" />
          )}
          <span>
            {copied ? t("room.identity.copied") : t("room.identity.copy")}
          </span>
        </button>
      </div>
      <div className={styles.inspectionBadges}>
        {badges.length ? (
          <MemberBadges badges={badges} />
        ) : (
          <span className={styles.none}>{t("room.identity.noBadges")}</span>
        )}
      </div>
      <p className={styles.note}>{t("room.identity.badgesNote")}</p>
      <div className={styles.actions}>
        {explorer && (
          <a
            href={`${explorer}/address/${principalId}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("room.identity.explorer", {
              network: getChatChain(chainId!).name,
            })}
            <IconArrowUpRight size={14} aria-hidden="true" />
          </a>
        )}
        {viewer && onEditProfile && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onEditProfile();
            }}
          >
            {t("room.identity.editProfile")}
          </button>
        )}
        {staff && onAskTeam && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onAskTeam();
            }}
          >
            {t("room.identity.askTeam")}
          </button>
        )}
        {onMessageAsTeam && !composing && (
          <button type="button" onClick={() => setComposing(true)}>
            <IconMessages size={14} aria-hidden="true" />
            {t("room.identity.messageAsTeam")}
          </button>
        )}
      </div>
      {onMessageAsTeam && composing && (
        <form
          className={styles.teamForm}
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || sending) return;
            setSending(true);
            setSendError("");
            onMessageAsTeam(text)
              .then(() => onClose())
              .catch((reason: unknown) => {
                setSendError(
                  reason instanceof Error
                    ? reason.message
                    : t("room.team.errorGeneric"),
                );
                setSending(false);
              });
          }}
        >
          <label>
            <span>{t("room.identity.messageAsTeamHint")}</span>
            <textarea
              rows={3}
              maxLength={4000}
              autoFocus
              value={draft}
              disabled={sending}
              placeholder={t("room.identity.messageAsTeamPlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          {sendError && (
            <p className={styles.note} role="alert">
              {sendError}
            </p>
          )}
          <div className={styles.actions}>
            <button type="submit" disabled={sending || !draft.trim()}>
              {sending
                ? t("room.identity.messageAsTeamSending")
                : t("room.identity.messageAsTeamSend")}
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                setComposing(false);
                setDraft("");
                setSendError("");
              }}
            >
              {t("room.identity.messageAsTeamCancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Name, badges and, on request, the avatar. Clicking the name opens the
 * inspection panel. */
export function MemberIdentity({
  principalId,
  profile,
  facts,
  size = "sm",
  chainId,
  viewer = false,
  showAvatar = false,
  onEditProfile,
  onAskTeam,
  onMessageAsTeam,
  badgeClassName,
  nameClassName,
  children,
}: {
  principalId: string;
  profile?: MemberProfile | null;
  facts?: ChatAuthorFacts;
  size?: MemberIdentitySize;
  chainId?: ChatChainId;
  viewer?: boolean;
  showAvatar?: boolean;
  onEditProfile?: () => void;
  onAskTeam?: () => void;
  onMessageAsTeam?: (text: string) => Promise<void>;
  badgeClassName?: string;
  nameClassName?: string;
  /** Rendered after the name, inside the identity row. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const label = memberLabel(profile, principalId);
  const badges = memberBadges(facts, t);
  return (
    <span className={styles.identity} data-size={size} data-open={open}>
      {showAvatar && (
        <span className={styles.avatar} data-size={size}>
          <MemberAvatar
            principalId={principalId}
            profile={profile}
            size={size}
          />
        </span>
      )}
      <button
        ref={trigger}
        type="button"
        id={nameId}
        className={nameClassName ?? styles.name}
        title={
          profile?.displayName
            ? `${label} (${principalLabel(principalId)})`
            : principalId
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      <MemberBadges badges={badges} className={badgeClassName} />
      {children}
      {open && (
        <MemberInspection
          principalId={principalId}
          profile={profile}
          facts={facts}
          chainId={chainId}
          viewer={viewer}
          onEditProfile={onEditProfile}
          onAskTeam={onAskTeam}
          onMessageAsTeam={onMessageAsTeam}
          onClose={close}
          labelledBy={nameId}
          anchor={trigger}
        />
      )}
    </span>
  );
}
