"use client";

import { useRelease } from "@/lib/release-context";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { IconHelpCircle } from "@tabler/icons-react";
import { ChatLoading } from "./chat-loading";
import { TemplMark } from "./brand/templ-mark";
import { SITE } from "@/lib/release-public";
import { supportPageWallet } from "@/lib/support-page-wallet";
import { widgetSignInNetworks } from "@/lib/support-availability";
import { addOwnChatMenu } from "@/lib/support-widget-visitor-menu";
import { OPERATOR } from "@/lib/operator";
import { trackEvent } from "@/lib/analytics";
import {
  templSupportWorkspace,
  templSupportRecheckDelay,
  loadTemplSupportWidget,
} from "@/lib/templ-support";
import {
  mountOwnSupportWidget,
  type OwnWidgetIntent,
} from "@/lib/own-support-widget";
import type { SupportContextInput } from "@templ/chat/support";
import type { SupportForm } from "@/lib/support-widget-form";
import styles from "./templ-support.module.css";
import panelStyles from "@/lib/own-support-widget.module.css";

/** What Templ's own chat says before a visitor's first message. */
export const TEMPL_SUPPORT_INTRO = {
  title: "Templ support",
  text: "Send a message to the Templ team. Templ AI may read it and reply.",
};
/** What a support button opens: Templ's usual chat, or the chat with a data
 * question ready to send, from Trust or account settings. */
export type TemplSupportTopic = "privacy" | "legal" | "security";
/** The one-click question a data request starts with. Templ's AI agent hands
 * privacy wording like this to a person. */
export const TEMPL_PRIVACY_PROMPT = "I have a privacy question about my data.";
/** The subject of the email a data request falls back to. */
export const TEMPL_PRIVACY_SUBJECT = "Privacy request";
const SUPPORT_TOPICS = {
  privacy: {
    email: OPERATOR.privacyContact,
    subject: TEMPL_PRIVACY_SUBJECT,
    prompt: TEMPL_PRIVACY_PROMPT,
    intro: "Ask about your data. The team replies here.",
  },
  legal: {
    email: OPERATOR.legalContact,
    subject: "Legal notice",
    prompt: "I have a legal question for Templ.",
    intro: "Ask a legal question. The team replies here.",
  },
  security: {
    email: OPERATOR.securityContact,
    subject: "Security report",
    prompt: "I want to report a security problem to Templ.",
    intro: "Report a security problem. The team replies here.",
  },
} as const;

function supportTopic(value: unknown): TemplSupportTopic | undefined {
  return value === "privacy" || value === "legal" || value === "security"
    ? value
    : undefined;
}

/** The mailbox for a privacy, legal or security notice. */
export function templSupportMailto(topic: TemplSupportTopic) {
  const { email, subject } = SUPPORT_TOPICS[topic];
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}
/** A visitor pointed at or focused a support button. The session starts
 * fetching the widget module so the click opens it at once. */
const PREPARE_EVENT = "templ:prepare-support";
const OPEN_EVENT = "templ:open-support";
const SUPPORT_HASH = "#support";
const prepareTemplSupport = () =>
  window.dispatchEvent(new Event(PREPARE_EVENT));

/** The landing can open support before its client code runs. */
export function TemplSupportLink({
  className,
  children,
  anchorRef,
  hidden,
}: {
  className: string;
  children: ReactNode;
  anchorRef?: RefObject<HTMLAnchorElement | null>;
  hidden?: boolean;
}) {
  return (
    <a
      ref={anchorRef}
      hidden={hidden}
      aria-controls="support"
      className={className}
      href={SUPPORT_HASH}
      onPointerEnter={prepareTemplSupport}
      onPointerDown={prepareTemplSupport}
      onFocus={prepareTemplSupport}
      onClick={(event) => {
        if (
          event.button !== 0 || event.altKey || event.ctrlKey ||
          event.metaKey || event.shiftKey || window.location.hash === SUPPORT_HASH
        )
          return;
        const unhandled = window.dispatchEvent(
          new CustomEvent(OPEN_EVENT, {
            cancelable: true,
            detail: { trigger: event.currentTarget },
          }),
        );
        if (!unhandled) {
          event.preventDefault();
          trackEvent("talk_to_us_clicked");
        }
      }}
    >
      {children}
    </a>
  );
}

export function TemplSupportButton({
  className,
  buttonRef,
  returnFocusRef,
  children,
  label = "Templ support",
  icon = true,
  conversion,
  topic,
  context,
  hidden,
}: {
  className?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** Where focus returns when the widget closes, if not this button. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  label?: string;
  icon?: boolean;
  /** The landing click this button counts as, if any. */
  conversion?: "talk_to_us_clicked" | "pilot_clicked";
  /** Opens the chat with a data question ready to send. */
  topic?: TemplSupportTopic;
  /** Details the visitor may share, as a protocol's Help button passes
   * them. Nothing is sent until the visitor ticks a row. */
  context?: SupportContextInput;
  hidden?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      hidden={hidden}
      className={className}
      aria-label={label}
      data-templ-conversion={conversion}
      onPointerEnter={prepareTemplSupport}
      onPointerDown={prepareTemplSupport}
      onFocus={prepareTemplSupport}
      onClick={(event) =>
        window.dispatchEvent(
          new CustomEvent(OPEN_EVENT, {
            detail: {
              trigger: returnFocusRef?.current ?? event.currentTarget,
              ...(topic ? { topic } : {}),
              ...(context ? { context } : {}),
            },
          }),
        )
      }
    >
      {icon && <IconHelpCircle size={19} aria-hidden="true" />}
      {children ?? <span>{label}</span>}
    </button>
  );
}

const noSubscription = () => () => {};
/** Whether Templ's own verified workspace can open here, after hydration. */
export function useTemplSupportAvailable() {
  const RELEASE = useRelease();

  return useSyncExternalStore<boolean | null>(
    noSubscription,
    () =>
      templSupportWorkspace(RELEASE, window.location.origin, SITE.origin) !==
      null,
    () => null,
  );
}

type SupportOpenRequest = {
  trigger?: HTMLElement;
  context?: SupportContextInput;
  topic?: TemplSupportTopic;
  form?: SupportForm;
};

export function TemplSupport({ showLauncher = false, lockedTheme }: { showLauncher?: boolean; lockedTheme?: "light" }) {
  const RELEASE = useRelease();
  const {
    supportWidgetVerified,
    conversationsVerified,
    supportWorkflowVerified,
  } = RELEASE;
  const ownVerified = RELEASE.templSupport?.verified,
    ownWorkspace = RELEASE.templSupport?.workspaceId,
    ownExpiry = RELEASE.templSupport?.expiresAt;
  const supportsSolana = RELEASE.supportWidgetSolanaVerified;
  const available = useTemplSupportAvailable();
  const [status, setStatus] = useState<"error" | null>(null);
  const [view, setView] = useState<"settings" | "conversation" | "ready" | "encrypted" | null>(null);
  const [listening, setListening] = useState(false);
  const startup = !listening && view === null;
  const opening = view === "settings" || view === "conversation";
  const openedFromHash = useRef(false);
  const [topic, setTopic] = useState<TemplSupportTopic>();
  const retryRequest = useRef<SupportOpenRequest | undefined>(undefined);
  const launcher = useRef<HTMLAnchorElement>(null);
  const standardPanel = useRef<HTMLElement>(null);
  const standardContent = useRef<HTMLDivElement>(null);
  const cancelOpening = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (opening) standardPanel.current?.focus({ preventScroll: true });
  }, [opening]);
  useEffect(() => {
    if ((!view && !status) || !openedFromHash.current) return;
    openedFromHash.current = false;
    if (window.location.hash === SUPPORT_HASH)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }, [status, view]);
  useEffect(() => {
    let widget: ReturnType<typeof mountOwnSupportWidget> | undefined;
    let standard: ReturnType<Awaited<ReturnType<typeof loadTemplSupportWidget>>["mountSupportWidget"]> | undefined;
    let openRevision = 0;
    const policyMaxAge = 3_000;
    let policyRead: {
      url: string;
      at: number;
      result: Promise<{ response: Response; mode: "standard" | "encrypted" } | undefined>;
    } | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const workspace = () =>
      templSupportWorkspace(
        {
          supportWidgetVerified,
          conversationsVerified,
          supportWorkflowVerified,
          templSupport: {
            verified: ownVerified,
            workspaceId: ownWorkspace,
            expiresAt: ownExpiry,
          },
        },
        window.location.origin,
        SITE.origin,
      );
    const currentPolicy = (id: string) => {
      const url = `${SITE.community}/widget/${id}/auth/policy`;
      if (!policyRead || policyRead.url !== url || Date.now() - policyRead.at > policyMaxAge) {
        const read = {
          url,
          at: Date.now(),
          result: fetch(url, {
            cache: "no-store",
            credentials: "omit",
            signal: AbortSignal.timeout(8_000),
          }).then(async response => {
            if (!response.ok) return;
            const { chatMode }: { chatMode?: unknown } = await response.clone().json();
            if (chatMode === "standard" || chatMode === "encrypted")
              return { response, mode: chatMode } as const;
          }).catch(() => undefined),
        };
        policyRead = read;
        void read.result.then(result => {
          if (!result && policyRead === read) policyRead = undefined;
        });
      }
      return policyRead;
    };
    const initial = workspace();
    if (initial && launcher.current) currentPolicy(initial);
    const prepare = () => {
      const id = workspace();
      if (id) {
        currentPolicy(id);
        void loadTemplSupportWidget().catch(() => {});
      }
    };
    const hidePanel = () => setView(null);
    const restoreFocus = () => requestAnimationFrame(() => {
      if (retryRequest.current?.trigger?.isConnected) retryRequest.current.trigger.focus();
    });
    cancelOpening.current = () => {
      openRevision++;
      standard?.close();
      hidePanel();
      restoreFocus();
    };
    const open = async (event: Event) => {
      event.preventDefault();
      const revision = ++openRevision;
      const detail = (event as CustomEvent<SupportOpenRequest>).detail;
      const requested = supportTopic(detail?.topic);
      retryRequest.current = detail;
      setTopic(requested);
      const workspaceId = workspace();
      if (!workspaceId) {
        widget?.destroy();
        widget = undefined;
        standard?.destroy();
        standard = undefined;
        hidePanel();
        if (requested) window.location.assign(templSupportMailto(requested));
        else setStatus("error");
        return;
      }
      const container = standardContent.current;
      setView("settings");
      setStatus(null);
      try {
        // Only a fixed navigation intent crosses origins. Wallets, offered
        // page context and prefilled form values remain on the parent page.
        const intent: OwnWidgetIntent =
          requested ??
          (event.type === "templ:open-feedback"
            ? "feedback"
            : detail?.form?.title === "Custom pricing"
              ? "quote"
              : detail?.form?.title === "Request full access"
                ? detail.form.fields.some((field) => field.id === "help")
                  ? "app-services"
                  : "app-approval"
                : "support");
        const trigger = detail?.trigger instanceof HTMLElement ? detail.trigger : undefined;
        const read = intent === "support" ? currentPolicy(workspaceId) : undefined;
        if (read) void loadTemplSupportWidget().catch(() => {});
        const policy = await read?.result;
        if (revision !== openRevision || !workspace()) return;
        if (read && !policy) throw new Error("Chat settings could not load.");
        if (policy?.mode === "standard" && read) {
          if (!container) throw new Error("Chat could not open.");
          widget?.close();
          setView("conversation");
          const widgetClient = await loadTemplSupportWidget();
          if (revision !== openRevision || !workspace()) return;
          const networks = widgetSignInNetworks({ supportWidgetSolanaVerified: supportsSolana });
          const network = networks.find(value => supportPageWallet(value, false)) ?? networks[0];
          standard ??= widgetClient.mountSupportWidget({
            workspace: workspaceId, apiUrl: SITE.community, label: "Templ",
            container, chatFirst: true, conversationDrawers: true, showLauncher: false, lockedTheme,
            appearance: { theme: "auto", radius: "soft", logo: "/art/brand/templ-square.svg" },
            intro: TEMPL_SUPPORT_INTRO, transactionField: false,
            ...(location.pathname === "/" ? { wallet: supportPageWallet(network), walletForNetwork: (family: "evm" | "solana") => networks.includes(family) ? supportPageWallet(family) : null, decorateOwnMenu: addOwnChatMenu } : {}),
            onClose: () => {
              hidePanel();
              restoreFocus();
            },
          }, {
            // The widget needs the same public policy to show its composer.
            // Reuse it only during this open. Session and send checks still
            // go to the server, and later policy reads get a fresh response.
            fetch: (input, init) => input === read.url &&
              init?.method === "GET" && init.credentials === "omit" &&
              !init.signal?.aborted && !new Headers(init.headers).has("Authorization") &&
              Date.now() - read.at <= policyMaxAge
                ? Promise.resolve(policy.response.clone())
                : fetch(input, init),
          });
          standard.setContext(detail?.context);
          await standard.open(false);
          if (revision !== openRevision || !workspace()) return;
          setView("ready");
        } else {
          standard?.close();
          widget ??= mountOwnSupportWidget({ workspace: workspaceId, onClose: hidePanel });
          widget.open(intent, trigger);
          setView("encrypted");
        }
      } catch {
        if (revision !== openRevision) return;
        standard?.destroy();
        standard = undefined;
        widget?.destroy();
        widget = undefined;
        hidePanel();
        setStatus("error");
      }
    };
    const checkCoverage = () => {
      if (!workspace()) {
        openRevision++;
        widget?.destroy();
        widget = undefined;
        standard?.destroy();
        standard = undefined;
        hidePanel();
      }
      expiryTimer = setTimeout(
        checkCoverage,
        templSupportRecheckDelay(ownExpiry ?? null),
      );
    };
    const openFromHash = () => {
      const root = document.documentElement;
      if (openedFromHash.current || (
        window.location.hash !== SUPPORT_HASH && !root.hasAttribute("data-templ-open-support")
      )) return;
      root.removeAttribute("data-templ-open-support");
      openedFromHash.current = true;
      trackEvent("talk_to_us_clicked");
      void open(new CustomEvent(OPEN_EVENT));
    };
    checkCoverage();
    window.addEventListener(PREPARE_EVENT, prepare);
    window.addEventListener(OPEN_EVENT, open);
    window.addEventListener("templ:open-feedback", open);
    window.addEventListener("hashchange", openFromHash);
    openFromHash();
    window.dispatchEvent(new Event("templ:support-listening"));
    setListening(true);
    return () => {
      clearTimeout(expiryTimer);
      cancelOpening.current = undefined;
      openedFromHash.current = false;
      openRevision++;
      widget?.destroy();
      standard?.destroy();
      window.removeEventListener(PREPARE_EVENT, prepare);
      window.removeEventListener(OPEN_EVENT, open);
      window.removeEventListener("templ:open-feedback", open);
      window.removeEventListener("hashchange", openFromHash);
    };
  }, [
    lockedTheme,
    supportWidgetVerified,
    conversationsVerified,
    supportWorkflowVerified,
    supportsSolana,
    ownVerified,
    ownWorkspace,
    ownExpiry,
  ]);
  return (
    <>
      <section
        id="support"
        className={`${panelStyles.panel} ${styles.startupPanel}`}
        ref={standardPanel}
        role="dialog"
        aria-label="Templ support"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (opening && event.key === "Escape") cancelOpening.current?.();
        }}
        data-templ-own-support=""
        data-locked-theme={lockedTheme}
        data-startup={startup ? "" : undefined}
        hidden={(!startup && !view) || view === "encrypted"}
      >
        {(startup || opening) && (
          <div className={styles.opening}>
            <ChatLoading
              themeControl={!lockedTheme}
              name="Templ support"
              logo="/art/brand/templ-square.svg"
              status={startup ? "Opening chat…" : view === "settings" ? "Checking chat settings…" : "Loading conversation…"}
              closeControl={startup
                ? <a href="#main-content" aria-label="Close support">×</a>
                : <button type="button" aria-label="Close support" onClick={() => cancelOpening.current?.()}>×</button>}
            />
          </div>
        )}
        <div ref={standardContent} data-templ-site-appearance="" className={styles.chatContent} inert={startup || opening} />
      </section>
      {showLauncher && (available ?? !!templSupportWorkspace(RELEASE, SITE.origin, SITE.origin)) && (
        <TemplSupportLink
          className={styles.launcher}
          anchorRef={launcher}
          hidden={view !== null}
        >
          <TemplMark className={styles.launcherMark} decorative />
          <span>Talk to us</span>
        </TemplSupportLink>
      )}
      {status && (
        <div className={styles.notice} role="alert">
          <span>Support could not open. Try again.</span>
          {status === "error" && (
            <>
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("templ:open-support", {
                      detail: retryRequest.current ?? {},
                    }),
                  )
                }
              >
                Retry
              </button>
              {topic && (
                <a
                  href={templSupportMailto(topic)}
                  onClick={() => setStatus(null)}
                >
                  Email Templ
                </a>
              )}
              <button
                type="button"
                aria-label="Dismiss support message"
                onClick={() => setStatus(null)}
              >
                ×
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
