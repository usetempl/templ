"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconHelpCircle,
  IconKey,
  IconLayoutGrid,
  IconLogout,
  IconMenu2,
  IconPlus,
  IconUserCircle,
  IconX,
  type Icon,
} from "@tabler/icons-react";
import type { NativeRoom } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import { useWallet, walletError } from "@/lib/wallet";
import { TemplLogo } from "@/components/brand/templ-mark";
import { AppThemeChoice } from "@/components/app-theme";
import { TemplSupportButton } from "@/components/templ-support";
import { PROFILE_SETTINGS_EVENT } from "@/components/profile-settings-event";
import { Identicon } from "@/components/ui/identicon";
import { WorkspaceFollowButton } from "./workspace-follow";
import { useWorkspaceLeaveProtection } from "./unsaved-changes";
import styles from "./rail.module.css";

const ProfileSettingsDialog = dynamic(
  () =>
    import("@/components/profile-settings-dialog").then(
      (module) => module.ProfileSettingsDialog,
    ),
  { ssr: false },
);

/** Closes a popover on outside pointer, Escape or route change. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const [route, setRoute] = useState(pathname);
  if (route !== pathname) {
    setRoute(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    root.current
      ?.querySelector<HTMLElement>('[role="menuitem"], [role="menu"] a')
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return { open, setOpen, root, trigger };
}

export function WorkspaceMark({
  name,
  image,
}: {
  name: string;
  image?: string | null;
}) {
  return (
    <span className={styles.workspaceMark} aria-hidden="true">
      {image ? (
        // Workspace icons are uploaded through the media service.
        <img src={image} alt="" />
      ) : (
        (Array.from(name.trim())[0]?.toUpperCase() ?? "T")
      )}
    </span>
  );
}

export function RailNavItem({
  icon: Icon,
  leading,
  label,
  href,
  onClick,
  active = false,
  badge,
  badgeTone,
}: {
  icon: Icon;
  /** Replaces the icon, for example with a workspace mark. */
  leading?: ReactNode;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  badge?: ReactNode;
  badgeTone?: "warning";
}) {
  const content = (
    <>
      {leading ?? <Icon aria-hidden="true" />}
      <span className={styles.navText}>{label}</span>
      {badge !== undefined && badge !== null && (
        <span className={styles.navBadge} data-tone={badgeTone}>
          {badge}
        </span>
      )}
    </>
  );
  return href ? (
    <Link
      href={href}
      className={styles.navItem}
      data-active={active}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      className={styles.navItem}
      data-active={active}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

export function RailNavGroup({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <nav
      className={styles.navGroup}
      aria-labelledby={label ? id : undefined}
      aria-label={label ? undefined : "Main"}
    >
      {label && (
        <p className={styles.navLabel} id={id}>
          {label}
        </p>
      )}
      {children}
    </nav>
  );
}

export type SwitcherWorkspace = {
  id: string;
  name: string;
  image?: string | null;
  href: string;
};

export function WorkspaceSwitcher({
  current,
  role,
  workspaces,
}: {
  current: { id: string; name: string; image?: string | null };
  role: string;
  workspaces: SwitcherWorkspace[];
}) {
  const { open, setOpen, root, trigger } = usePopover();
  const id = useId();
  return (
    <div className={styles.switcher} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={styles.switcherButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen(!open)}
      >
        <WorkspaceMark name={current.name} image={current.image} />
        <span>
          <strong>{current.name}</strong>
          <small>{role}</small>
        </span>
        <IconChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div
          id={`${id}-menu`}
          role="menu"
          aria-label="Switch workspace"
          className={`${styles.popover} ${styles.popoverBelow} ${styles.workspaceMenu}`}
        >
          <p className={styles.popoverLabel}>Workspaces</p>
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              href={workspace.href}
              role="menuitem"
              className={styles.menuItem}
              data-current={workspace.id === current.id}
            >
              <WorkspaceMark name={workspace.name} image={workspace.image} />
              <span className={styles.menuItemText} title={workspace.name}>
                {workspace.name}
              </span>
            </Link>
          ))}
          <div className={styles.menuDivider} />
          <Link href="/create" role="menuitem" className={styles.menuItem}>
            <IconPlus aria-hidden="true" /> New workspace
          </Link>
          <Link href="/inbox" role="menuitem" className={styles.menuItem}>
            <IconLayoutGrid aria-hidden="true" /> All workspaces
          </Link>
        </div>
      )}
    </div>
  );
}

export function AccountMenu({
  placement = "above",
  workspace,
}: {
  placement?: "above" | "below";
  workspace?: NativeRoom;
}) {
  const auth = useChatAuth();
  const wallet = useWallet();
  const account = auth.session?.principalId;
  const { open, setOpen, root, trigger } = usePopover();
  const id = useId();
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const profiles = useMemberProfiles(account ? [account] : []);
  const profile = account ? profiles.get(account.toLowerCase()) : undefined;
  useEffect(() => {
    if (!account) return;
    const openProfile = () => setProfileOpen(true);
    window.addEventListener(PROFILE_SETTINGS_EVENT, openProfile);
    return () =>
      window.removeEventListener(PROFILE_SETTINGS_EVENT, openProfile);
  }, [account]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function signIn() {
    setBusy("in");
    setError("");
    try {
      await auth.signIn();
    } catch (reason) {
      if (!isChatSignInCanceled(reason)) setError(walletError(reason));
    } finally {
      setBusy(null);
    }
  }
  async function signOut() {
    setOpen(false);
    setBusy("out");
    setError("");
    try {
      await auth.signOut();
    } catch (reason) {
      setError(`Sign-out failed: ${walletError(reason)}`);
    } finally {
      wallet.disconnect();
      setBusy(null);
    }
  }
  if (!account)
    return (
      <div className={styles.account}>
        <button
          type="button"
          className={`button ${styles.signInButton}`}
          disabled={busy === "in" || auth.restoring}
          onClick={() => void signIn()}
        >
          <IconUserCircle aria-hidden="true" />
          {auth.restoring ? "Checking sign-in…" : "Sign in"}
        </button>
        {error && (
          <p role="alert" className={styles.railError}>
            {error}
          </p>
        )}
      </div>
    );
  const name = memberLabel(profile, account);
  return (
    <div className={styles.account} ref={root}>
      {open && (
        <div
          id={`${id}-menu`}
          role="menu"
          aria-label="Account"
          className={`${styles.popover} ${placement === "above" ? styles.popoverAbove : styles.popoverBelowEnd}`}
        >
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              setProfileOpen(true);
            }}
          >
            <IconUserCircle aria-hidden="true" /> Edit profile
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() =>
              void navigator.clipboard
                .writeText(account)
                .then(() => setCopied(true))
                .catch(() => setError("Copy failed. Your ID: " + account))
            }
          >
            {copied ? (
              <IconCheck aria-hidden="true" />
            ) : (
              <IconCopy aria-hidden="true" />
            )}{" "}
            {copied ? "Account ID copied" : "Copy account ID"}
          </button>
          <Link
            href="/settings/account"
            role="menuitem"
            className={styles.menuItem}
          >
            <IconKey aria-hidden="true" /> Wallets and email
          </Link>
          <div className={styles.menuDivider} />
          {workspace && (
            <WorkspaceFollowButton
              workspace={workspace}
              account={account}
              menu
            />
          )}
          <Link
            href="/inbox?hidden=1"
            role="menuitem"
            className={styles.menuItem}
          >
            <IconLayoutGrid aria-hidden="true" /> Hidden workspaces
          </Link>
          <div className={styles.menuDivider} />
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            onClick={() => void signOut()}
          >
            <IconLogout aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
      <button
        ref={trigger}
        type="button"
        className={styles.accountButton}
        aria-label={`Account menu for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        disabled={busy === "out"}
        onClick={() => setOpen(!open)}
      >
        <Identicon seed={account} profile={profile} size={30} radius={9} />
        <span>
          <strong>{busy === "out" ? "Signing out…" : name}</strong>
          <small>{account}</small>
        </span>
        <IconChevronUp aria-hidden="true" />
      </button>
      {error && (
        <p role="alert" className={styles.railError}>
          {error}
        </p>
      )}
      {profileOpen &&
        createPortal(
          <ProfileSettingsDialog
            account={account as ChatPrincipalId}
            onClose={() => setProfileOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/** Every signed-in page shares this frame: the rail on the left (a drawer
 * on phones) and the page on the right. */
export function AppFrame({
  title,
  subtitle,
  rail,
  children,
  fill = false,
  workspace,
}: {
  /** Shown in the phone top bar. */
  title: string;
  subtitle?: string;
  rail: ReactNode;
  children: ReactNode;
  /** Inbox-style pages manage their own scrolling panes. */
  fill?: boolean;
  workspace?: NativeRoom;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [route, setRoute] = useState(pathname);
  const toggle = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useWorkspaceLeaveProtection();
  if (route !== pathname) {
    setRoute(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
    };
    const resize = () => {
      if (window.innerWidth > 900) setOpen(false);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  useEffect(() => {
    if (open) closeButton.current?.focus();
    else if (wasOpen.current) toggle.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <div className={styles.frame}>
      {open && (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        id="templ-app-rail"
        className={styles.rail}
        data-open={open}
        aria-label="App navigation"
      >
        <div className={styles.railTop}>
          <Link href="/" className={styles.logoLink} aria-label="Templ home">
            <TemplLogo className={styles.logo} />
          </Link>
          <button
            ref={closeButton}
            type="button"
            className={styles.railClose}
            aria-label="Close navigation"
            onClick={() => {
              setOpen(false);
            }}
          >
            <IconX size={18} aria-hidden="true" />
          </button>
        </div>
        <div
          className={styles.railScroll}
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("nav button")
            )
              setOpen(false);
          }}
        >
          {rail}
        </div>
        <div className={styles.railFoot}>
          <AppThemeChoice />
          <TemplSupportButton
            className={styles.navItem}
            label="Help and feedback"
            icon={false}
          >
            <IconHelpCircle aria-hidden="true" />
            <span className={styles.navText}>Help and feedback</span>
          </TemplSupportButton>
          <AccountMenu workspace={workspace} />
        </div>
      </aside>
      <div
        className={styles.stage}
        inert={open || undefined}
        aria-hidden={open || undefined}
      >
        <div className={styles.mobileBar}>
          <button
            ref={toggle}
            type="button"
            className={styles.menuButton}
            aria-label="Open navigation"
            aria-controls="templ-app-rail"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <IconMenu2 size={19} aria-hidden="true" />
          </button>
          <div className={styles.mobileTitle}>
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </div>
        </div>
        <main
          id="main-content"
          tabIndex={-1}
          className={styles.stageScroll}
          style={
            fill
              ? { display: "flex", flexDirection: "column", overflow: "hidden" }
              : undefined
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
