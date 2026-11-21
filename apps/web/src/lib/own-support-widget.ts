/** Templ's public sites host only a member frame. Chat state and keys never
 * enter this module or the parent page. Other customers use their own client. */
import styles from "./own-support-widget.module.css";

export const OWN_WIDGET_ORIGIN = "https://secure-support.usetempl.com";
export const OWN_WIDGET_PARENTS = [
  "https://usetempl.com",
  "https://docs.usetempl.com",
  "https://blog.usetempl.com",
] as const;
export const OWN_WIDGET_INTENTS = [
  "support",
  "privacy",
  "legal",
  "security",
  "feedback",
  "quote",
  "app-approval",
  "app-services",
] as const;
export type OwnWidgetIntent = (typeof OWN_WIDGET_INTENTS)[number];

export function mountOwnSupportWidget(options: {
  workspace: string;
  onClose?: () => void;
}) {
  if (
    options.workspace !== "01a0fe6b-fccc-7633-b0e8-bcb29c000ebb" ||
    !OWN_WIDGET_PARENTS.some((origin) => origin === location.origin)
  )
    throw new Error("Templ support is unavailable on this page.");
  const panel = document.createElement("section"),
    loading = document.createElement("section"),
    close = document.createElement("button");
  let frame = document.createElement("iframe");
  panel.className = styles.panel;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Templ support");
  panel.dataset.templOwnSupport = "";
  panel.hidden = true;
  frame.title = "Templ encrypted support";
  frame.inert = true;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox",
  );
  frame.setAttribute(
    "allow",
    "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'",
  );
  loading.setAttribute("role", "status");
  const opening = () => {
    loading.className = styles.loading!; loading.setAttribute("aria-label", "Loading conversation");
    const header = document.createElement("header"), logo = document.createElement("img"),
      title = document.createElement("strong"), indicator = document.createElement("span");
    logo.src = "/art/brand/templ-square.svg"; logo.alt = ""; logo.width = logo.height = 36;
    title.textContent = "Templ";
    indicator.dataset.openingIndicator = ""; indicator.setAttribute("aria-hidden", "true");
    header.append(logo, title, indicator);
    loading.replaceChildren(header);
  };
  opening();
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close support");
  close.className = styles.close;
  panel.append(loading, frame, close);
  document.body.append(panel);
  let alive = true,
    started = false,
    ready = false,
    trigger: HTMLElement | null = null;
  let currentIntent: OwnWidgetIntent = "support";
  let failedBeforeReady = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    panel.hidden = true;
    options.onClose?.();
    // React hosts restore a hidden launcher in their next render. Keep the
    // original trigger mounted and return focus after that render.
    requestAnimationFrame(() => { if (trigger?.isConnected && panel.hidden) trigger.focus(); });
  };
  close.addEventListener("click", hide);
  const receive = (event: MessageEvent) => {
    if (
      !alive ||
      !started ||
      event.origin !== OWN_WIDGET_ORIGIN ||
      event.source !== frame.contentWindow ||
      !event.data ||
      Object.keys(event.data).length !== 1
    )
      return;
    if (event.data.type === "templ-own-ready") {
      ready = true;
      frame.inert = false;
      failedBeforeReady = false;
      clearTimeout(timeout);
      loading.remove();
      close.hidden = true;
    } else if (ready && event.data.type === "templ-own-close") hide();
  };
  window.addEventListener("message", receive);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  return {
    open(intent: OwnWidgetIntent = "support", focus?: HTMLElement) {
      if (!alive || !OWN_WIDGET_INTENTS.includes(intent)) return;
      trigger =
        focus ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      panel.hidden = false;
      if (
        started &&
        ((intent !== "support" && intent !== currentIntent) ||
          (!ready && failedBeforeReady))
      ) {
        // A fresh frame binds readiness to this document generation. Its
        // existing encrypted draft/outbox are restored by the same client.
        const next = frame.cloneNode(false) as HTMLIFrameElement;
        next.removeAttribute("src");
        next.inert = true;
        frame.replaceWith(next);
        frame = next;
        started = ready = false;
        failedBeforeReady = false;
        opening();
        panel.prepend(loading);
        close.hidden = false;
      }
      if (!started) {
        started = true;
        currentIntent = intent;
        const selected = frame;
        frame.addEventListener("load", () => {
          if (alive && selected === frame)
            selected.contentWindow?.postMessage(
              { type: "templ-own-init" },
              OWN_WIDGET_ORIGIN,
            );
        });
        const theme =
          document.documentElement.dataset.theme === "dark" ||
          document.documentElement.classList.contains("dark")
            ? "dark"
            : "light";
        panel.dataset.theme = theme;
        frame.src = `${OWN_WIDGET_ORIGIN}/widget?${new URLSearchParams({ theme, intent })}`;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (alive && !ready) {
            failedBeforeReady = true;
            loading.removeAttribute("aria-label");
            loading.querySelector("[data-opening-indicator]")?.remove();
            const failure = document.createElement("p");
            failure.textContent = "Support is taking longer to open. Close and try again.";
            loading.append(failure);
          }
        }, 15_000);
      }
      (ready ? frame : close).focus();
    },
    close: hide,
    destroy() {
      const wasOpen = !panel.hidden;
      alive = false;
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      panel.remove();
      if (wasOpen) options.onClose?.();
    },
  };
}
