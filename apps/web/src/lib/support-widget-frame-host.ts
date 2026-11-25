/** Frame mode's host file: what a protocol page loads
 * in place of the widget to keep the chat out of the page's reach. It draws
 * the launcher and its unread dot, and opens the chat in a frame served from
 * Templ's frame origin. The frame holds the session, the guest credential,
 * a remembered sign-in, drafts and every message; this file never sees any
 * of them and never calls the support service.
 *
 * The page keeps its wallet. Wallet calls the frame asks for go through the
 * `framebridge` chunk, which signs only Templ's sign-in message for this
 * page and workspace. Frame mode doesn't stop other scripts on the page from
 * asking the wallet to sign something else.
 *
 * Same call as the widget file: `mountSupportWidget(options)` returns
 * `{ open, close, setContext, setWallet, destroy }`. */
import { SUPPORT_FAILURE_SNAPSHOT_LIMIT } from "@templ/chat/support";
import type { SupportFailureCapture } from "@templ/chat/support";
import {
  checkedFrameMessage,
  WIDGET_FRAME_TO_HOST,
  WIDGET_FRAME_HELLO,
  WIDGET_FRAME_PATH,
  WIDGET_FRAME_VERSION,
} from "@templ/chat/widget-frame";
import {
  type SupportWallet,
  type SupportWidgetOptions,
  type SupportWidgetAppearance,
} from "./support-widget";

const chunk = (path: string) =>
  import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */
    new globalThis.URL(path, import.meta.url).href
  );

/** The build id of the core the frame runs, set by the published build. */
declare const __TEMPL_FRAME_BUILD__: string | undefined;
declare const __TEMPL_FRAME_BRIDGE__: string | undefined;
const loadBridge = (): Promise<
  typeof import("./support-widget-frame-bridge")
> =>
  typeof __TEMPL_FRAME_BRIDGE__ == "string"
    ? chunk(__TEMPL_FRAME_BRIDGE__)
    : import("./support-widget-frame-bridge");
declare const __TEMPL_FRAME_GUEST__: string | undefined;
const loadPage = (): Promise<typeof import("./support-widget-guest")> =>
  typeof __TEMPL_FRAME_GUEST__ === "string"
    ? chunk(__TEMPL_FRAME_GUEST__)
    : import("./support-widget-guest");
/** Templ's origins follow this file's own address, as the widget's API
 * does: the copy served from https://templ.vip/ uses staging, every other
 * copy production. */
const ROOT = import.meta.url.indexOf("https://templ.vip/")
  ? "usetempl.com"
  : "templ.vip";
declare const __TEMPL_WIDGET_APPEARANCE__: string | undefined;
const loadAppearance = (): Promise<
  typeof import("./support-widget-appearance")
> =>
  typeof __TEMPL_WIDGET_APPEARANCE__ === "string"
    ? chunk(__TEMPL_WIDGET_APPEARANCE__)
    : import("./support-widget-appearance");
declare const __TEMPL_WIDGET_ART__: string | undefined;
const loadBranding = (): Promise<typeof import("./support-widget-art")> =>
  typeof __TEMPL_WIDGET_ART__ === "string"
    ? chunk(__TEMPL_WIDGET_ART__)
    : import("./support-widget-art");
export const FRAME_ORIGIN = `https://frame.${ROOT}`;

/** The iframe's sandbox: scripts, its own storage and origin, forms, and
 * links that open normal tabs. No top navigation. */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

/** Frame mode: the same call and handle as the widget file. */
export function mountSupportWidget(options: SupportWidgetOptions) {
  const workspace = options.workspace;
  if (location.protocol != "https:")
    throw new Error("Frame mode needs an HTTPS page.");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      workspace,
    )
  )
    throw new Error("Use the workspace ID from Templ.");
  if (
    options.apiUrl !== undefined &&
    options.apiUrl !== `https://community.${ROOT}`
  )
    throw new Error("Frame mode uses Templ's support API.");
  if (options.wallet && options.provider)
    throw new TypeError(
      "Pass wallet as { evm: provider } or { solana: wallet }.",
    );
  let wallet: SupportWallet | null =
    options.wallet ?? (options.provider ? { evm: options.provider } : null);

  const el = <T extends keyof HTMLElementTagNameMap>(tag: T) =>
    document.createElement(tag);
  const host = el("div");
  host.setAttribute("data-templ-support", "frame");
  host.setAttribute("data-theme", options.appearance?.theme ?? "auto");
  const root = host.attachShadow({ mode: "open" });
  const style = el("style");
  if (options.styleNonce) style.nonce = options.styleNonce;
  style.textContent = ":host{display:none}";
  const launcher = el("button");
  launcher.className = "launcher";
  launcher.type = "button";
  launcher.hidden = !!options.container || options.showLauncher === false;
  launcher.setAttribute("aria-expanded", "false");
  // Built as DOM, so pages with Trusted Types work.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  for (const [name, value] of [
    ["viewBox", "0 0 24 24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"],
  ])
    svg.setAttribute(name, value);
  path.setAttribute("d", "M4 5h16v11H10l-5 4v-4H4z");
  svg.append(path);
  const label = options.label ?? "Support";
  launcher.append(svg, label);
  /** The unread dot, and the same news for screen readers. */
  const unread = (on: boolean) => {
    if (on) {
      launcher.dataset.unread = "";
      launcher.setAttribute("aria-label", `${label}, new reply`);
    } else {
      delete launcher.dataset.unread;
      launcher.removeAttribute("aria-label");
    }
  };
  const note = el("p");
  note.setAttribute("role", "status");
  note.hidden = true;
  const frame = el("iframe");
  frame.className = "viewport";
  frame.title = "Support chat";
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "eager");
  frame.setAttribute("allow", "clipboard-write");
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.hidden = true;
  frame.src = `${FRAME_ORIGIN}${WIDGET_FRAME_PATH}${workspace}?origin=${encodeURIComponent(location.origin)}&build=${typeof __TEMPL_FRAME_BUILD__ == "string" ? __TEMPL_FRAME_BUILD__ : "dev"}`;
  root.append(style, launcher, note, frame);
  (options.container ?? document.body).append(host);

  let port: MessagePort | undefined,
    ready = false,
    wanted = false,
    destroyed = false,
    nextFailure = 0,
    failures: {
      k: "failure";
      id: number;
      context: NonNullable<SupportWidgetOptions["context"]>;
      capture?: SupportFailureCapture;
    }[] = [],
    failedAt = 0,
    reloadedAt = 0,
    readyTimer: ReturnType<typeof setTimeout> | undefined,
    bridge:
      | Promise<
          ReturnType<(typeof import("./support-widget-frame-bridge"))["bridge"]>
        >
      | undefined,
    unwatch = () => {};
  const page = loadPage().then(module => {
    if (!destroyed) module.frameLoading(root, note, label, !!options.container, close);
    return module.framePage(workspace);
  });
  const post = (message: Record<string, unknown>) =>
    destroyed || port?.postMessage(message);
  let requestedForm: import("./support-widget-form").SupportForm | undefined;
  const notify = (count: number) => {
    try {
      options.onUnread?.(count);
    } catch {
      /* The page's callback can't stop the chat. */
    }
  };

  /** The page's side of the frame's wallet and of moving a regular
   * widget's guest, loaded only for a page with a wallet or such a guest,
   * or on the frame's first wallet call. */
  const bridged = () =>
    (bridge ??= loadBridge().then((module) =>
      module.bridge({
        wallet: () => wallet,
        workspace,
        appOrigin: `https://${ROOT}`,
      }),
    ));
  const state = async () => (wallet ? (await bridged()).state() : null);
  const sendWallet = async () => post({ k: "wallet", wallet: await state() });
  const watch = () => {
    if (wallet)
      void bridged().then((loaded) => {
        unwatch();
        unwatch = loaded.watch(sendWallet);
      });
  };
  watch();

  let unappearance = () => {};
  let effectiveAppearance = options.appearance ?? {};
  let boundColors:
    | ReturnType<
        typeof import("./support-widget-appearance").bindWidgetAppearance
      >
    | undefined;
  let branding:
    | ReturnType<typeof import("./support-widget-art").bindWidgetBranding>
    | undefined;
  let brandingLoad: Promise<void> | undefined;
  const paintBranding = () => {
    if (branding) branding.set(effectiveAppearance);
    else if (
      effectiveAppearance.logo ||
      effectiveAppearance.font ||
      effectiveAppearance.colors
    )
      brandingLoad ??= loadBranding().then(
        (module) => {
          if (!destroyed)
            branding = module.bindWidgetBranding(host, effectiveAppearance);
        },
        () => {},
      );
  };
  let display: { theme: "light" | "dark"; font: string } | undefined;
  const colors = loadAppearance()
    .then((module) => {
      if (destroyed) return;
      style.textContent = module.FRAME_STYLE + `:host([data-position=left]) .viewport,:host([data-position=left]) button{right:auto;left:20px}
@media(max-width:480px){.viewport{inset:auto 8px 8px;width:auto;height:calc(100dvh - 16px)}button{right:16px;bottom:16px}:host([data-position=left]) .viewport{left:8px;right:8px}:host([data-position=left]) button{left:16px}button[aria-expanded=true]{display:none}}
@media(prefers-reduced-motion:reduce){button{transition:none}button:hover{transform:none}}` + (options.container
        ? ":host{display:block;height:100%}button{display:none!important}.viewport{position:static;inset:auto;width:100%;height:100%;border-radius:0;box-shadow:none}"
        : "");
      const bound = (boundColors = module.bindWidgetAppearance(
        host,
        effectiveAppearance,
        (next) => {
          display = next;
          if (ready) post({ k: "appearance", ...next });
        },
      ));
      unappearance = bound.destroy;
      paintBranding();
    })
    .catch(() => {
      style.textContent =
        ":host{font-family:inherit}button,iframe{display:none}";
      failedAt = Date.now();
      note.setAttribute("data-error", "");
      note.textContent = "Support chat didn't load. Reload to try again.";
      note.hidden = false;
    });

  function show(open: boolean) {
    frame.hidden = !open;
    note.hidden = true;
    launcher.setAttribute("aria-expanded", String(open));
  }
  function handle(event: MessageEvent) {
    const message = checkedFrameMessage(event.data, WIDGET_FRAME_TO_HOST);
    if (!message || destroyed) return;
    const { k, n, id } = message;
    if (
      k === "appearance-config" &&
      message.value &&
      typeof message.value === "object" &&
      !Array.isArray(message.value)
    ) {
      effectiveAppearance = {
        theme: "auto",
        accent: undefined,
        radius: "soft",
        outlinedButtons: false,
        position: "right",
        ...options.appearance,
        ...(message.value as SupportWidgetAppearance),
      };
      boundColors?.set(effectiveAppearance);
      paintBranding();
      options.appearanceChanged?.(message.value as SupportWidgetAppearance);
    } else if (k === "guest-restored")
      void page.then((value) => value.restored(message.fragment));
    else if (k == "ready" && !ready) {
      ready = true;
      clearTimeout(readyTimer);
      for (const failure of failures) post(failure);
      if (requestedForm) {
        post({ k: "form", form: requestedForm });
        requestedForm = undefined;
      }
      if (wanted) open();
    } else if (k === "captured") {
      failures = failures.filter((failure) => failure.id !== id);
    } else if (k == "panel" && message.open === false) {
      show(false);
      if (!launcher.hidden) launcher.focus();
    } else if (
      k == "unread" &&
      Number.isInteger(n) &&
      (n as number) >= 0 &&
      (n as number) <= 999
    ) {
      unread(n !== 0);
      notify(n as number);
    } else if (k == "call" && Number.isSafeInteger(id)) {
      bridged()
        .then((loaded) => loaded.call(String(message.m), message.p))
        .then(
          (value) => post({ k: "result", id, ok: true, value }),
          (reason) =>
            post({
              k: "result",
              id,
              ok: false,
              error: reason instanceof Error ? reason.message : "unavailable",
            }),
        );
    } else if (k == "adopted" && message.ok === true)
      void bridged().then((loaded) => loaded.adopted());
  }
  frame.addEventListener("load", async () => {
    if (destroyed) return;
    port?.close();
    ready = false;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = handle;
    frame.contentWindow?.postMessage(
      { k: WIDGET_FRAME_HELLO, v: WIDGET_FRAME_VERSION, workspace },
      FRAME_ORIGIN,
      [channel.port2],
    );
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      failedAt = Date.now();
      if (wanted) {
        note.setAttribute("data-error", "");
        note.textContent = "Support chat didn't load. Close and try again.";
      }
    }, 15_000);
    const pageState = await page;
    await colors;
    if (destroyed) return;
    const shown = { ...pageState.display(options), hostAppearance: display };
    post({
      k: "init",
      options: shown,
      wallet: await state(),
      ...(pageState.held ? { adopt: (await bridged()).adoption() } : {}),
    });
  });

  function open() {
    if (destroyed) return;
    wanted = true;
    if (!ready) {
      // Still loading: say so, and open once the frame is ready. A frame
      // that never answered gets the fallback line and loads again at most
      // every 30 seconds.
      note.toggleAttribute("data-error", !!failedAt);
      launcher.setAttribute("aria-expanded", "true");
      note.textContent = failedAt
        ? "Support chat didn't load. Reload to try again."
        : "Loading the chat…";
      note.hidden = false;
      if (failedAt && Date.now() - reloadedAt > 30_000) {
        reloadedAt = Date.now();
        failedAt = 0;
        frame.src = frame.src;
      }
      return;
    }
    wanted = false;
    show(true);
    unread(false);
    notify(0);
    frame.focus();
    for (const failure of failures) post(failure);
    post({ k: "open" });
  }
  function close() {
    wanted = false;
    post({ k: "close" });
    show(false);
  }
  launcher.addEventListener("click", () => (frame.hidden && !wanted ? open() : close()));
  return {
    open,
    openForm(form: import("./support-widget-form").SupportForm) {
      const cloned = structuredClone(form);
      if (ready) post({ k: "form", form: cloned });
      else requestedForm = cloned;
      open();
    },
    close,
    setContext(context?: SupportWidgetOptions["context"]) {
      options = { ...options, context };
      post({
        k: "context",
        context: context ? JSON.parse(JSON.stringify(context)) : null,
      });
    },
    clearCapturedFailures() {
      failures = [];
      post({ k: "clearFailures" });
    },
    async captureFailure(
      context: NonNullable<SupportWidgetOptions["context"]>,
      capture?: SupportFailureCapture,
    ) {
      const frozen = structuredClone({
        k: "failure" as const,
        id: ++nextFailure,
        context: {
          ...context,
          app: {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            ...context.app,
          },
        },
        ...(capture ? { capture } : {}),
      });
      failures.push(frozen);
      failures = failures.slice(-SUPPORT_FAILURE_SNAPSHOT_LIMIT);
      if (ready) post(frozen);
    },
    /** The page's wallet was connected, switched or dropped. */
    setWallet(next: SupportWallet | null) {
      if ((next?.evm ?? next?.solana) === (wallet?.evm ?? wallet?.solana))
        return;
      unwatch();
      wallet = next;
      watch();
      void sendWallet();
    },
    destroy() {
      if (destroyed) return;
      post({ k: "destroy" });
      destroyed = true;
      unappearance();
      branding?.destroy();
      clearTimeout(readyTimer);
      unwatch();
      port?.close();
      host.remove();
    },
  };
}
