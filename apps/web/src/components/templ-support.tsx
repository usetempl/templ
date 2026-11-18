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
import { TemplMark } from "./brand/templ-mark";
import { SITE } from "@/lib/release-public";
import { OPERATOR } from "@/lib/operator";
import { trackEvent } from "@/lib/analytics";
import {
  templSupportWorkspace,
  templSupportRecheckDelay,
} from "@/lib/templ-support";
import {
  mountOwnSupportWidget,
  type OwnWidgetIntent,
} from "@/lib/own-support-widget";
import type { SupportContextInput } from "@templ/chat/support";
import type { SupportForm } from "@/lib/support-widget-form";
import styles from "./templ-support.module.css";

/** What Templ's own chat says before a visitor's first message. */
export const TEMPL_SUPPORT_INTRO = {
  title: "Ask Templ",
  text: "Ask about Templ. Our AI or team replies.",
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
const prepareTemplSupport = () =>
  window.dispatchEvent(new Event(PREPARE_EVENT));

export function TemplSupportButton({
  className,
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
          new CustomEvent("templ:open-support", {
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

export function TemplSupport({
  showLauncher = false,
}: {
  showLauncher?: boolean;
}) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const openFromLink = () => {
      if (window.location.hash !== "#support") return;
      clearTimeout(timer);
      // Let the support listener attach before opening a linked request.
      timer = setTimeout(() => {
        if (window.location.hash !== "#support") return;
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
        trackEvent("talk_to_us_clicked");
        window.dispatchEvent(new CustomEvent("templ:open-support"));
      }, 0);
    };
    window.addEventListener("hashchange", openFromLink);
    openFromLink();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", openFromLink);
    };
  }, []);
  return <SupportSession showLauncher={showLauncher} />;
}

type SupportOpenRequest = {
  trigger?: HTMLElement;
  context?: SupportContextInput;
  topic?: TemplSupportTopic;
  form?: SupportForm;
};

function SupportSession({ showLauncher }: { showLauncher: boolean }) {
  const RELEASE = useRelease();
  const {
    supportWidgetVerified,
    conversationsVerified,
    supportWorkflowVerified,
  } = RELEASE;
  const ownVerified = RELEASE.templSupport?.verified,
    ownWorkspace = RELEASE.templSupport?.workspaceId,
    ownExpiry = RELEASE.templSupport?.expiresAt;
  const available = useTemplSupportAvailable();
  const [status, setStatus] = useState<"error" | null>(null);
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<TemplSupportTopic>();
  const retryRequest = useRef<SupportOpenRequest | undefined>(undefined);
  useEffect(() => {
    let widget: ReturnType<typeof mountOwnSupportWidget> | undefined;
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
    const open = (event: Event) => {
      const detail = (event as CustomEvent<SupportOpenRequest>).detail;
      const requested = supportTopic(detail?.topic);
      retryRequest.current = detail;
      setTopic(requested);
      const workspaceId = workspace();
      if (!workspaceId) {
        widget?.destroy();
        widget = undefined;
        setOpen(false);
        if (requested) window.location.assign(templSupportMailto(requested));
        else setStatus("error");
        return;
      }
      try {
        widget ??= mountOwnSupportWidget({ workspace: workspaceId, onClose: () => setOpen(false) });
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
        widget.open(
          intent,
          detail?.trigger instanceof HTMLElement ? detail.trigger : undefined,
        );
        setOpen(true);
        setStatus(null);
      } catch {
        widget?.destroy();
        widget = undefined;
        setOpen(false);
        setStatus("error");
      }
    };
    const checkCoverage = () => {
      if (!workspace()) {
        widget?.destroy();
        widget = undefined;
        setOpen(false);
      }
      expiryTimer = setTimeout(
        checkCoverage,
        templSupportRecheckDelay(ownExpiry ?? null),
      );
    };
    checkCoverage();
    window.addEventListener("templ:open-support", open);
    window.addEventListener("templ:open-feedback", open);
    return () => {
      clearTimeout(expiryTimer);
      widget?.destroy();
      window.removeEventListener("templ:open-support", open);
      window.removeEventListener("templ:open-feedback", open);
    };
  }, [
    supportWidgetVerified,
    conversationsVerified,
    supportWorkflowVerified,
    ownVerified,
    ownWorkspace,
    ownExpiry,
  ]);
  return (
    <>
      {showLauncher && available && (
        <TemplSupportButton
          className={styles.launcher}
          hidden={open}
          label="Talk to us"
          icon={false}
          conversion="talk_to_us_clicked"
        >
          <TemplMark className={styles.launcherMark} decorative />
          <span>Talk to us</span>
        </TemplSupportButton>
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
