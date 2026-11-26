/** Frame mode's `frame` chunk: the adapter the frame
 * document on Templ's frame origin runs. It waits for the one `hello` from
 * the page around it, then mounts the regular widget core in this frame for
 * that page's origin. Every support request carries the page's origin in
 * `X-Templ-Host-Origin`; the service approves it like any website and keeps
 * whatever this frame makes usable only here.
 *
 * The session, the guest credential, a remembered sign-in, drafts and the
 * thread live in this frame and its storage, which the page can't read. The
 * page keeps its wallet: wallet calls go to the page over the port, and the
 * page signs only Templ's sign-in message for itself (see
 * support-widget-frame-host.ts). Opened on its own, the frame says where to
 * open the chat and calls nothing. */
import {
  checkedFrameMessage,
  WIDGET_FRAME_TO_FRAME,
  isFrameHostOrigin,
  WIDGET_FRAME_HELLO,
  WIDGET_FRAME_VERSION,
  WIDGET_HOST_ORIGIN_HEADER,
} from "@templ/chat/widget-frame";
import type {
  SupportSolanaWallet,
  SupportWallet,
  SupportWalletProvider,
  SupportWidgetOptions,
} from "./support-widget";
import type { SupportFailureCapture } from "@templ/chat/support";
import { SUPPORT_FAILURE_SNAPSHOT_LIMIT } from "@templ/chat/support";

/** The core file this build pairs with, set by the published build. */
declare const __TEMPL_FRAME_CORE__: string | undefined;
declare const __TEMPL_WIDGET_DRAFTS__: string | undefined;
const loadDrafts = (): Promise<typeof import("./support-widget-drafts")> =>
  typeof __TEMPL_WIDGET_DRAFTS__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(__TEMPL_WIDGET_DRAFTS__, import.meta.url).href
      )
    : import("./support-widget-drafts");
type Core = {
  mountSupportWidget(
    options: SupportWidgetOptions,
    runtime?: { origin?: string; fetch?: typeof fetch },
  ): {
    open(): void;
    openForm(form: import("./support-widget-form").SupportForm): Promise<void>;
    close(): void;
    setContext(context?: SupportWidgetOptions["context"]): void;
    clearCapturedFailures(): void;
    captureFailure(
      context: NonNullable<SupportWidgetOptions["context"]>,
      capture?: SupportFailureCapture,
    ): Promise<unknown>;
    setWallet(wallet: SupportWallet | null): void;
    destroy(): void;
  };
};
const loadCore = (): Promise<Core> =>
  typeof __TEMPL_FRAME_CORE__ == "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(__TEMPL_FRAME_CORE__, import.meta.url).href
      )
    : import("./support-widget");
/** The API the core talks to: it follows the core file's address the same
 * way (support-widget.ts `templApi`). */
const API =
  "https://community." +
  (import.meta.url.indexOf("https://templ.vip/")
    ? "usetempl.com"
    : "templ.vip");

type Config = { workspace: string; host: string; nonce: string };
type WalletState =
  | { family: "evm"; accounts: string[]; chainId: string }
  | { family: "solana"; address: string | null }
  | null;
type Adopt = {
  credential?: string;
  thread?: string;
  drafts: { principal: string; value: string }[];
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** What the chat's panel fills: the whole frame, with no launcher of its
 * own; the page draws the launcher and the frame's corners. */
export const FRAME_PANEL_STYLE =
  ".panel{position:fixed;inset:0;width:100%;height:100%;border:0;border-radius:0;box-shadow:none;animation:none}.launcher{display:none}";

/** The frame document's settings, from its JSON block. */
export function frameConfig(doc: Document): Config | null {
  try {
    const value = JSON.parse(
      doc.getElementById("templ-frame")?.textContent ?? "null",
    );
    return value?.v === 1 &&
      UUID.test(value.workspace) &&
      isFrameHostOrigin(value.host) &&
      typeof value.nonce == "string" &&
      /^[A-Za-z0-9+/=_-]{16,64}$/.test(value.nonce)
      ? { workspace: value.workspace, host: value.host, nonce: value.nonce }
      : null;
  } catch {
    return null;
  }
}

/** Starts the frame: checks where it runs, waits for the page's port and
 * mounts the chat. `win` is this frame's window. */
export function startFrame(win: Window = window) {
  const doc = win.document;
  const config = frameConfig(doc);
  if (!config) return;
  // Not inside a page: one line, no request.
  if (win.parent === win) {
    const top = doc.getElementById("templ-frame-top");
    if (top) top.hidden = false;
    return;
  }
  const listen = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    const ancestors = win.location.ancestorOrigins;
    if (
      event.source !== win.parent ||
      event.origin !== config.host ||
      (ancestors && ancestors.length && ancestors[0] !== config.host) ||
      !data ||
      typeof data != "object" ||
      Object.keys(data).sort().join() !== "k,v,workspace" ||
      data.k !== WIDGET_FRAME_HELLO ||
      data.v !== WIDGET_FRAME_VERSION ||
      data.workspace !== config.workspace ||
      event.ports.length !== 1
    )
      return;
    // The first valid hello wins; later window messages are never read.
    win.removeEventListener("message", listen);
    connect(win, config, event.ports[0]);
  };
  win.addEventListener("message", listen);
}

/** Every support request from this frame names the page around it; nothing
 * else about a request changes. */
export function hostFetch(base: typeof fetch, host: string): typeof fetch {
  return (input, init) => {
    const url =
      typeof input == "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(`${API}/widget/`)) return base(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(WIDGET_HOST_ORIGIN_HEADER, host);
    return base(input, { ...init, headers });
  };
}

function connect(win: Window, config: Config, port: MessagePort) {
  const doc = win.document;
  const post = (message: Record<string, unknown>) => port.postMessage(message);
  let widget: ReturnType<Core["mountSupportWidget"]> | undefined,
    initialized = false,
    destroyed = false,
    state: WalletState = null,
    nextId = 1;
  const failures = new Map<number, Record<string, unknown>>();
  const captured = new Set<number>();
  let capturing = false,
    captureRevision = 0;
  /** Keep failures until their rows are ready. Opening the chat retries them. */
  async function captureFailures() {
    if (!widget || capturing) return;
    capturing = true;
    const revision = captureRevision;
    try {
      for (const [id, failure] of failures) {
        try {
          await widget.captureFailure(
            failure.context as NonNullable<SupportWidgetOptions["context"]>,
            failure.capture as SupportFailureCapture | undefined,
          );
          if (destroyed || revision !== captureRevision) return;
          failures.delete(id);
          captured.add(id);
          if (captured.size > SUPPORT_FAILURE_SNAPSHOT_LIMIT)
            captured.delete(captured.values().next().value!);
          post({ k: "captured", id });
        } catch {
          // The next Get help click retries the saved details.
        }
      }
    } finally {
      capturing = false;
      if (revision !== captureRevision) void captureFailures();
    }
  }
  const pending = new Map<
    number,
    [(value: unknown) => void, (reason: Error) => void]
  >();
  /** One wallet call through the page. */
  const call = (m: string, p: unknown[] = []) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, [resolve, reject]);
      post({ k: "call", id, m, p });
    });
  const listeners = new Map<string, Set<() => void>>();
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  let solanaProxy: SupportSolanaWallet | undefined;
  /** A wallet for the core built from the page's wallet state: it can read,
   * ask to connect and ask for a signature, each through the page. */
  function proxyFor(next: WalletState): SupportWallet | null {
    if (next?.family === "evm")
      return {
        evm: {
          request: ({ method, params }) => call(method, params ?? []),
          on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(listener);
          },
          removeListener(event, listener) {
            listeners.get(event)?.delete(listener);
          },
        } satisfies SupportWalletProvider,
      };
    if (next?.family === "solana") {
      let address = next.address;
      solanaProxy = {
        get publicKey() {
          return address ? { toBase58: () => address! } : null;
        },
        async connect() {
          const answer = (await call("solana_connect")) as {
            address?: unknown;
          };
          address = typeof answer?.address == "string" ? answer.address : null;
        },
        signMessage: async (message: Uint8Array) =>
          (await call("solana_signMessage", [message])) as Uint8Array,
      };
      return { solana: solanaProxy };
    }
    return null;
  }
  function walletChanged(next: WalletState) {
    const before = state;
    state = next;
    if (before?.family !== next?.family) {
      widget?.setWallet(proxyFor(next));
      return;
    }
    if (next?.family === "evm" && before?.family === "evm") {
      if (before.accounts.join() !== next.accounts.join())
        emit("accountsChanged");
      if (before.chainId !== next.chainId) emit("chainChanged");
    } else if (
      next?.family === "solana" &&
      before?.family === "solana" &&
      before.address !== next.address
    )
      // A new proxy, so the core checks the account again.
      widget?.setWallet(proxyFor(next));
  }
  function watchPanel() {
    const host = doc.querySelector("[data-templ-support]");
    const root = host?.shadowRoot;
    const panel = root?.querySelector(".panel");
    if (!root || !panel) return;
    const style = doc.createElement("style");
    style.nonce = config.nonce;
    style.textContent = FRAME_PANEL_STYLE;
    root.append(style);
    let open = !panel.hasAttribute("hidden");
    new MutationObserver(() => {
      const now = !panel.hasAttribute("hidden");
      if (now !== open) {
        open = now;
        post({ k: "panel", open });
      }
    }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }
  async function adoptGuest(adopt: Adopt | undefined, fetcher: typeof fetch) {
    if (!adopt) return;
    let draftGuard: typeof import("./support-widget-drafts") | undefined;
    if (adopt.drafts.length)
      try {
        draftGuard = await loadDrafts();
        if (destroyed) return;
      } catch {
        return post({ k: "adopted", ok: false });
      }
    const key = `templ:support-guest:v1:${config.workspace}`;
    let held = false;
    try {
      held = /^[0-9a-f]{64}$/.test(win.localStorage.getItem(key) ?? "");
    } catch {
      /* A frame without storage keeps the page's copy for now. */
      return post({ k: "adopted", ok: false });
    }
    /** The page's drafts, as composer text and a transaction hash only: a
     * page script can write any value in the page's storage, so nothing from
     * there becomes a message sent in the member's name. A draft this frame
     * already holds stays. */
    const keepDrafts = () => {
      for (const draft of adopt.drafts.slice(0, 3))
        try {
          if (!/^[\w:-]{1,80}$/.test(draft.principal)) continue;
          const draftKey = `templ:support-draft:v1:${win.location.origin}:${config.workspace}:${draft.principal}`;
          const saved = JSON.parse(draft.value) as Record<string, unknown>;
          const hash = saved.transactionHash;
          if (
            win.localStorage.getItem(draftKey) === null &&
            typeof saved.text == "string" &&
            saved.text.length <= 2000 &&
            Number.isSafeInteger(saved.savedAt) &&
            draftGuard?.canPersist({ text: saved.text, transactionHash: hash })
          )
            win.localStorage.setItem(
              draftKey,
              JSON.stringify({
                text: saved.text,
                transactionHash:
                  typeof hash == "string" && hash.length <= 300 ? hash : "",
                savedAt: saved.savedAt,
              }),
            );
        } catch {
          /* A draft this frame can't read or save is dropped. */
        }
    };
    if (held || !adopt.credential || !/^[0-9a-f]{64}$/.test(adopt.credential)) {
      keepDrafts();
      return post({ k: "adopted", ok: true });
    }
    try {
      const response = await fetcher(
        `${API}/widget/${config.workspace}/auth/guest`,
        {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: adopt.credential, adopt: true }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        credential?: unknown;
        reason?: unknown;
      } | null;
      if (
        response.ok &&
        typeof body?.credential == "string" &&
        /^[0-9a-f]{64}$/.test(body.credential)
      ) {
        try {
          win.localStorage.setItem(key, body.credential);
          if (adopt.thread && /^tc-[0-9a-f]{32}$/.test(adopt.thread))
            win.localStorage.setItem(
              `templ:support-guest-thread:v1:${config.workspace}`,
              adopt.thread,
            );
        } catch {
          // The page's credential ended with the move; the member starts a
          // new conversation in this frame.
        }
        keepDrafts();
        return post({ k: "adopted", ok: true });
      }
      // The service ended the page's credential: nothing to keep there.
      if (response.status === 401 && body?.reason === "guest-expired") {
        // Another tab may have moved it first; this frame's storage then
        // holds that tab's credential.
        keepDrafts();
        return post({ k: "adopted", ok: true });
      }
    } catch {
      /* A network failure keeps the page's copy for the next load. */
    }
    post({ k: "adopted", ok: false });
  }
  function appearance(value: unknown) {
    const input = value as { theme?: unknown; font?: unknown } | null;
    if (
      !input ||
      (input.theme !== "light" && input.theme !== "dark") ||
      typeof input.font !== "string" ||
      input.font.length > 300
    )
      return;
    doc.body.style.colorScheme = input.theme;
    doc.body.style.fontFamily = input.font;
  }
  async function init(message: Record<string, unknown>) {
    const options = message.options as Record<string, unknown>;
    if (!options || typeof options != "object") return;
    appearance(options.hostAppearance);
    state = (message.wallet as WalletState) ?? null;
    const fetcher = hostFetch(win.fetch.bind(win), config.host);
    // Screenshots and other chunk requests use this frame's fetch too.
    win.fetch = fetcher;
    await adoptGuest(message.adopt as Adopt | undefined, fetcher);
    const core = await loadCore();
    if (destroyed) return;
    // Only the page's display options cross; the frame sets the rest.
    const allowed = Object.fromEntries(
      [
        "label",
        "appearance",
        "lockedTheme",
        "chatFirst",
        "prompts",
        "intro",
        "transactionField",
        "persistDrafts",
        "context",
        "guestLink",
        "guestPath",
      ]
        .filter((name) => options[name] !== undefined && options[name] !== null)
        .map((name) => [name, options[name]]),
    ) as Partial<SupportWidgetOptions>;
    widget = core.mountSupportWidget(
      {
        ...allowed,
        workspace: config.workspace,
        container: options.fullPage ? doc.body : undefined,
        guestRestored: (fragment: string) =>
          post({ k: "guest-restored", fragment }),
        wallet: proxyFor(state),
        showLauncher: false,
        styleNonce: config.nonce,
        onUnread: (n) => post({ k: "unread", n }),
        appearanceChanged: (value) => post({ k: "appearance-config", value }),
      },
      { origin: config.host, fetch: fetcher },
    );
    watchPanel();
    post({ k: "ready" });
  }
  port.onmessage = (event) => {
    const message = checkedFrameMessage(event.data, {
      ...WIDGET_FRAME_TO_FRAME,
      form: [["form"], []],
      clearFailures: [[], []],
    });
    if (!message || destroyed) return;
    if (message.k === "init") {
      if (initialized) return;
      initialized = true;
      void init(message);
    } else if (message.k === "result") {
      const entry = pending.get(message.id as number);
      if (!entry) return;
      pending.delete(message.id as number);
      if (message.ok === true) entry[0](message.value);
      else
        entry[1](
          new Error(
            typeof message.error == "string" && message.error != "unavailable"
              ? message.error
              : "The page's wallet refused this request.",
          ),
        );
    } else if (message.k === "appearance") appearance(message);
    else if (message.k === "wallet")
      walletChanged(message.wallet as WalletState);
    else if (message.k === "open") {
      widget?.open();
      void captureFailures();
    } else if (message.k === "close") widget?.close();
    else if (message.k === "form")
      void widget
        ?.openForm(message.form as import("./support-widget-form").SupportForm)
        .catch(() => {});
    else if (message.k === "clearFailures") {
      captureRevision++;
      failures.clear();
      widget?.clearCapturedFailures();
    } else if (message.k === "context")
      widget?.setContext(
        (message.context ?? undefined) as SupportWidgetOptions["context"],
      );
    else if (
      message.k === "failure" &&
      Number.isSafeInteger(message.id) &&
      (message.id as number) > 0
    ) {
      const id = message.id as number;
      if (captured.has(id)) post({ k: "captured", id });
      else {
        failures.set(id, message);
        if (failures.size > SUPPORT_FAILURE_SNAPSHOT_LIMIT)
          failures.delete(failures.keys().next().value!);
        void captureFailures();
      }
    } else if (message.k === "destroy") {
      destroyed = true;
      widget?.destroy();
      for (const [, [, reject]] of pending)
        reject(new Error("The support widget is closed."));
      pending.clear();
      port.close();
    }
  };
}
