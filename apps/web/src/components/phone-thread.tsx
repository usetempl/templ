"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  IconArrowLeft,
  IconDotsVertical,
  IconInfoCircle,
} from "@tabler/icons-react";
import { copy as t } from "@/lib/copy";
import styles from "./team-conversations.module.css";

const NARROW_PHONE_WIDTH = "(max-width: 480px)";
const CATEGORY_REQUIRED = "templ-case-category-required";

export function requestCaseCategory() {
  window.dispatchEvent(new Event(CATEGORY_REQUIRED));
}

/** Whether a media query matches, false on the server and without
 * matchMedia. */
function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}

type Details = {
  available: boolean;
  modal: boolean;
  open: boolean;
  sheetId: string;
  toggleId: string;
  setOpen: (open: boolean) => void;
};
const DetailsContext = createContext<Details | null>(null);

/** Keep case details tied to the open conversation across viewport sizes. */
export function PhoneConversation({
  className,
  viewer,
  details,
  resetKey,
  children,
}: {
  className: string;
  viewer: "team" | "member";
  details: boolean;
  resetKey: string;
  children: ReactNode;
}) {
  const sheetId = useId();
  const toggleId = useId();
  const [state, setState] = useState({ key: resetKey, open: false });
  const open = details && state.key === resetKey && state.open;
  const setOpen = useCallback(
    (next: boolean) => setState({ key: resetKey, open: next }),
    [resetKey],
  );
  return (
    <DetailsContext.Provider
      value={{ available: details, modal: viewer === "team", open, sheetId, toggleId, setOpen }}
    >
      <div
        className={className}
        data-viewer={viewer}
        data-details={open ? "open" : "closed"}
      >
        {children}
      </div>
    </DetailsContext.Provider>
  );
}

/** Open the case details from the conversation header. */
export function PhoneDetailsButton() {
  const details = useContext(DetailsContext);
  if (!details?.available) return null;
  return (
    <button
      id={details.toggleId}
      type="button"
      className={styles.detailsToggle}
      aria-label="Case details"
      aria-expanded={details.open}
      aria-controls={details.sheetId}
      onClick={() => details.setOpen(!details.open)}
    >
      <IconInfoCircle size={18} aria-hidden="true" />
      <span>{t("phone.details.open")}</span>
    </button>
  );
}

export function CaseDetailsExtras({ children }: { children: ReactNode }) {
  const details = useContext(DetailsContext);
  return details?.modal && !details.open ? null : children;
}

/** Opens the details sheet and focuses the shared facts on any screen size. */
export function PhoneDetailsLink({
  target,
  className,
  children,
}: {
  target: string;
  className: string;
  children: ReactNode;
}) {
  const details = useContext(DetailsContext);
  const [requested, setRequested] = useState(0);
  const shown = useRef(0);
  useEffect(() => {
    if (requested === shown.current || (details && !details.open)) return;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(target);
      if (!element) return;
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
      shown.current = requested;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [requested, details, target]);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        details?.setOpen(true);
        setRequested((value) => value + 1);
      }}
    >
      {children}
    </button>
  );
}

/** A dialog for staff and narrow screens, with a details column for wider member views. */
export function PhoneDetails({
  className,
  label,
  children,
}: {
  className: string;
  label: string;
  children: ReactNode;
}) {
  const details = useContext(DetailsContext);
  const back = useRef<HTMLButtonElement>(null);
  const open = details?.open === true;
  const toggleId = details?.toggleId;
  const wasOpen = useRef(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const phone = useMediaQuery("(max-width: 900px)");
  const modal = phone || details?.modal === true;
  const [categoryRequest, setCategoryRequest] = useState(0);
  const focusedCategory = useRef(0);
  useEffect(() => {
    const reveal = () => {
      details?.setOpen(true);
      setCategoryRequest((value) => value + 1);
    };
    window.addEventListener(CATEGORY_REQUIRED, reveal);
    return () => window.removeEventListener(CATEGORY_REQUIRED, reveal);
  }, [details]);
  useEffect(() => {
    const element = sheet.current;
    if (!element) return;
    if (modal && open) {
      if (!element.matches(":modal")) {
        if (element.open) element.close();
        element.showModal();
      }
      back.current?.focus();
    } else {
      if (element.matches(":modal")) element.close();
      element.open = !modal;
    }
    if (!open && wasOpen.current && toggleId)
      document.getElementById(toggleId)?.focus();
    wasOpen.current = open;
  }, [open, toggleId, modal]);
  useEffect(() => {
    const element = sheet.current;
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (!open || categoryRequest === focusedCategory.current) return;
    const focus = () => {
      const field = sheet.current?.querySelector<HTMLElement>("#case-category");
      if (!field) return false;
      const disclosure = field.closest("details");
      if (disclosure) disclosure.open = true;
      field.scrollIntoView?.({ block: "nearest" });
      field.focus({ preventScroll: true });
      focusedCategory.current = categoryRequest;
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    if (sheet.current)
      observer.observe(sheet.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, categoryRequest]);
  return (
    <dialog
      ref={sheet}
      id={details?.sheetId}
      className={className}
      open={!modal}
      data-case-details-dialog={details?.modal ? "" : undefined}
      role={modal ? undefined : "complementary"}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        details?.setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          details?.setOpen(false);
        }
        if (modal && open && event.key === "Tab") {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
            ),
          ].filter(
            (control) =>
              control.tabIndex >= 0 &&
              control.getClientRects().length > 0 &&
              getComputedStyle(control).visibility !== "hidden",
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (
            first &&
            last &&
            ((event.shiftKey && document.activeElement === first) ||
              (!event.shiftKey && document.activeElement === last))
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }
      }}
    >
      {details && (
        <button
          ref={back}
          type="button"
          className={styles.detailsBack}
          onClick={() => details.setOpen(false)}
        >
          <IconArrowLeft size={18} aria-hidden="true" />
          {t("phone.details.back")}
        </button>
      )}
      {children}
    </dialog>
  );
}

const MENU_ITEMS = 'button:not(:disabled)[role="menuitem"]';

/** The thread actions. At <= 480 px they sit in one Actions menu: each
 * action stays the same real button, marked as a menu item, and the menu
 * opens with Enter or Space, moves with the arrow keys and closes with
 * Escape. */
export function PhoneActions({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const narrow = useMediaQuery(NARROW_PHONE_WIDTH);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const shown = narrow && open;

  // Each action is a real button from the thread; in the menu it is a menu
  // item. The roles follow the buttons as they change.
  useEffect(() => {
    const element = menu.current;
    if (!shown || !element) return;
    const mark = () => {
      for (const button of element.querySelectorAll("button"))
        if (button.getAttribute("role") !== "menuitem")
          button.setAttribute("role", "menuitem");
    };
    mark();
    element.querySelector<HTMLElement>(MENU_ITEMS)?.focus();
    const observer = new MutationObserver(mark);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [shown]);

  if (!narrow) return <div className={className}>{children}</div>;

  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    // A field in the menu (the time spent list) keeps its own keys.
    const field = (event.target as HTMLElement).closest("select, input");
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (field) {
      return;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") close(false);
  };
  return (
    <div className={`${className} ${styles.actionsWrap}`}>
      <button
        ref={trigger}
        type="button"
        className={styles.actionsToggle}
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-controls={shown ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconDotsVertical size={18} aria-hidden="true" />
        {t("phone.actions.open")}
      </button>
      {shown && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={t("phone.actions.open")}
          className={styles.actionsMenu}
          onKeyDown={onMenuKey}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest(MENU_ITEMS)) close();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
