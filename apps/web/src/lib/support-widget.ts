import { transactionExample } from "./standalone-trial-example";
import { widgetMessageId as requestId } from "./support-widget-message-id";
import { widgetErrorMessage } from "./support-widget-error";
import type {
  ChatMessage,
  TeamConversation,
  TeamConversationMessages,
  TeamConversationStatus,
} from "@templ/chat/index";
import type {
  SupportContextInput,
  SupportFailureCapture,
  SupportNetwork,
  SupportTransaction,
  VisitorSupportProfiles,
} from "@templ/chat/support";
import type { SupportLeadInput } from "@templ/chat/support-lead";
import { SUPPORT_WIDGET_API_VERSION } from "@templ/chat/support-app-context";
import { isEip155ChainId } from "@templ/chat/chains";
import { createSolanaSignInMessage, isSolanaAddress } from "@templ/chat/solana";
import {
  WIDGET_REMEMBER_STATEMENT,
  WIDGET_SIGN_IN_STATEMENT,
  WIDGET_WALLET_SHARE_STATEMENT,
} from "@templ/chat/widget-wallet";
import type * as WalletRules from "@templ/chat/widget-wallet";
import type * as ContextRules from "@templ/chat/support-context";
import type { MemberLines } from "./support-widget-member";
import type { SupportForm } from "./support-widget-form";
export type { SupportForm } from "./support-widget-form";
import { signInSteps } from "./support-widget-sign-in";
import { WIDGET_DARK_BASE, WIDGET_LIGHT_BASE } from "./support-widget-theme";

/** The build id this file sends as X-Templ-Widget. The published build sets
 * it; Next and test bundles report "dev". */
declare const __TEMPL_WIDGET_BUILD__: string | undefined;
const WIDGET_BUILD =
  typeof __TEMPL_WIDGET_BUILD__ == "string" ? __TEMPL_WIDGET_BUILD__ : "dev";
const SIGN_IN_AGAIN = "Sign in again to keep your case.";
const WALLET_CHANGED = "Your wallet changed. Sign in again.";
const LOAD_FAILED = "Chat didn’t load. Reload the page.";
const UNAVAILABLE = "Support is unavailable. Try again.";
/** "No, I still need help" when the team can't take the request back. */
const NOT_TAKING =
  "This team can’t take new cases right now. Try again later.";
const BAD_HASH = "This doesn't look like a transaction ID.";

/** An EIP-1193 provider. The widget calls only eth_accounts, eth_chainId,
 * eth_requestAccounts (from a Sign in click) and personal_sign. */
export type SupportWalletProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: "accountsChanged" | "chainChanged", handler: () => void): void;
  removeListener?(
    event: "accountsChanged" | "chainChanged",
    handler: () => void,
  ): void;
};
/** A Wallet Standard wallet with solana:signMessage, or a wallet-adapter
 * style signer (useWallet(), an adapter or window.phantom.solana). The widget
 * reads its account, connects only from a Sign in click and signs only the
 * sign-in message. */
export type SupportSolanaWallet =
  | {
      readonly accounts: readonly {
        readonly address: string;
        readonly chains?: readonly string[];
      }[];
      readonly features: object;
    }
  | {
      readonly publicKey: { toBase58(): string } | null;
      signMessage?(
        message: Uint8Array,
      ): Promise<Uint8Array | { signature: Uint8Array }>;
      connect?(): Promise<unknown>;
    };
/** The one wallet the user acts with on the page, under its family key. */
export type SupportWallet =
  | { evm: SupportWalletProvider; solana?: never }
  | { solana: SupportSolanaWallet; evm?: never };
export type SupportWidgetOptions = {
  workspace: string;
  /** Chat-first controls require the workspace's server feature snapshot. Off by default. */
  chatFirst?: boolean;
  /** Show the responsive conversation and menu drawers inside this chat. */
  conversationDrawers?: boolean;
  /** The frame transports a guest link and the parent page path as untrusted input. */
  guestLink?: string;
  guestPath?: string;
  /** A frame acknowledges only a successfully consumed guest link. */
  guestRestored?(fragment: string): void;
  /** The page's wallet. Leave it out on a page without one, and visitors
   * can still write as guests. Call setWallet() when it changes. */
  wallet?: SupportWallet | null;
  /** The same as wallet: { evm: provider }. Pass one or the other. */
  provider?: SupportWalletProvider;
  apiUrl?: string;
  label?: string;
  /** Details the visitor may share, one row each. Nothing is sent until the
   * visitor ticks a row. */
  context?: SupportContextInput;
  /** Mount the real chat across a page container. */
  container?: HTMLElement;
  /** Close a site-owned panel around an inline widget. */
  onClose?(): void;
  styleNonce?: string;
  persistDrafts?: boolean;
  /** Shows the floating launcher by default. Set false for your own support button. */
  showLauncher?: boolean;
  /** Match the widget to your app. Defaults to the app's theme and font. */
  appearance?: SupportWidgetAppearance;
  /** Keep the hosted page skin while using the workspace button color. */
  fixedAppearance?: boolean;
  /** Start the assistant's typing row once the visitor's send is acknowledged. */
  replyAfterReceipt?: boolean;
  decorateOwnMenu?(host: TailHost, actions: HTMLElement): () => void;
  /** The frame adapter receives public display settings only. */
  appearanceChanged?(value: SupportWidgetAppearance): void;
  /** Up to four common questions, shown as buttons before a visitor's first
   * message. A click sends the question. Each is at most 80 characters. */
  prompts?: string[];
  /** What the empty chat says before a visitor's first message: a short
   * title (up to 80 characters) and one line under it (up to 200). */
  intro?: { title: string; text?: string };
  /** Offer "Add details" so users can share a transaction.
   * Defaults to true; turn it off when your support has no transactions. */
  transactionField?: boolean;
  /** Called with the number of team replies the visitor hasn't seen while
   * the widget is closed, and with 0 when it opens. */
  onUnread?: (count: number) => void;
  /** Templ's own landing chat offers lead capture after the server permits it. */
  templLeadCapture?: boolean;
  /** Fixed local steps. The widget loads no analytics code on a host page. */
  onStep?: (
    step: "prompt_used" | "lead_email" | "lead_wallet" | "lead_qualified",
  ) => void;
};
export type SupportWidgetAppearance = {
  /** Auto follows the host page, then the visitor's system setting. */
  theme?: "dark" | "light" | "auto";
  /** One six-digit hex color, or a color for each theme. */
  accent?: string | { light: string; dark: string };
  /** Panel and control corners. Defaults to soft. */
  radius?: "square" | "soft" | "round";
  /** Launcher and panel side. Defaults to right. */
  position?: "right" | "left";
  /** Square image for the header and launcher: an HTTPS URL or a path on your site. */
  logo?: string;
  /** Uses fonts available in the browser. Inherit keeps the app's font. */
  font?: "inherit" | "system" | "sans" | "serif" | "mono";
  colors?: Partial<
    Record<
      "light" | "dark",
      Partial<
        Record<"background" | "surface" | "text" | "muted" | "border", string>
      >
    >
  >;
  /** Optional plain text in the header, up to 280 characters. */
  headerNotice?: { enabled: boolean; text: string };
};
/** "signed" is a wallet proof. A guest is "connected" when the page reported
 * a wallet, which proves nothing, and "anonymous" otherwise. */
type AccessLevel = "anonymous" | "connected" | "signed";
type WidgetSession = {
  /** Single-use route check from the first guest admission, kept in memory. */
  standardOpening?: number;
  credential?: string;
  token: string;
  principalId: string;
  /** The proven wallet, or a guest's claim; "" when a guest has none. */
  address: string;
  expiresAt: number;
  /** The EVM network of that wallet; none for Solana or no claim. */
  chainId?: number;
  level: AccessLevel;
  /** The member's own principals, sent back as an untrusted read hint. */
  servicePrincipals?: string[];
  /** A thread this session last held. Not secret: every read is checked. */
  thread?: string;
};
type Sent = { conversation: TeamConversation; message?: ChatMessage };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Templ's API follows the address this file was loaded from: the copy
 * served from https://templ.vip/ uses staging, and every other copy
 * (usetempl.com, a protocol's CDN, a data: URL, an app bundle) uses
 * production. `apiUrl` overrides the API origin. */
const templApi = (apiUrl?: string) =>
  apiUrl ??
  "https://community." +
    (import.meta.url.indexOf("https://templ.vip/")
      ? "usetempl.com"
      : "templ.vip");
const THREAD = /^tc-[0-9a-f]{32}$/;
const conversationId = (id: string) => {
  if (!THREAD.test(id)) throw new Error("Invalid support case.");
  return id;
};
/** A guest's credential entry holds only the credential, as every release
 * reads it; the thread it last held has an entry of its own. */
const guestKeys = (workspace: string) => [
  `templ:support-guest:v1:${workspace}`,
  `templ:support-guest-thread:v1:${workspace}`,
];
function storedGuest(workspace: string) {
  try {
    const [credential, thread] = guestKeys(workspace).map(
      (key) => localStorage.getItem(key) ?? "",
    );
    if (/^[0-9a-f]{64}$/.test(credential))
      return { credential, thread: THREAD.test(thread) ? thread : undefined };
  } catch {
    /* Storage is optional; this visit still works. */
  }
}
const pause = (ms: number) =>
  new Promise<undefined>((done) => setTimeout(done, ms));
const principals = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : undefined;

const BAD_WALLET = "Pass wallet as { evm: provider } or { solana: wallet }.";
/** The wallet an integration passed, checked: one family key and the shape
 * that family needs. */
function checkedWallet(value: unknown): SupportWallet | null {
  if (value == null) return null;
  const { evm, solana } = value as {
    evm?: { request?: unknown };
    solana?: { accounts?: unknown; features?: unknown };
  };
  if (
    !evm == !solana ||
    (evm
      ? typeof evm.request != "function"
      : typeof solana != "object" ||
        !(
          "publicKey" in solana! ||
          (Array.isArray(solana!.accounts) &&
            solana!.features instanceof Object)
        ))
  )
    throw new TypeError(BAD_WALLET);
  return (evm ? { evm } : { solana }) as SupportWallet;
}
/** What the page's wallet reports, in the shape the service reads: an EVM
 * account with its network, or a Solana account. Never a proof. */
type Selected = { address: string; chainId?: number; network?: "solana" };
/** A report the service can take as a guest's claim. */
const claimOf = (selected?: Selected) =>
  selected && (selected.network || isEip155ChainId(selected.chainId))
    ? selected
    : undefined;
/** What each wallet family's chunk provides. `signIn` runs the whole
 * sign-in from a click; its reads go through `host.read`, the page's current
 * wallet. */
type WalletKit = {
  read(): Promise<Selected>;
  chain(): Promise<number>;
  steps(host: TailHost): void;
  signIn(host: SignInHost): Promise<[Verified, Selected]>;
};
type SignInHost = {
  origin: string;
  workspace: string;
  hosted?: boolean;
  /** A guest's bearer: the service moves that guest's thread to the wallet. */
  bearer?: string;
  shareConversation?: string;
  call<T>(
    path: string,
    body: object,
    anonymous: boolean,
    bearer?: string,
  ): Promise<T>;
  read(): Promise<Selected>;
  /** True once the wallet or session changed after the sign-in started. */
  stale(): boolean;
};
type Verified = Omit<WidgetSession, "address" | "chainId" | "level"> & {
  address?: string;
  wallet?: { address?: string };
  shareConversation?: string;
  walletReceipt?: string;
  walletReceiptExpiresAt?: number;
  transfer?: { moved?: boolean; conversation?: string | null };
  /** A remembered sign-in's key, when the member signed the 30-day line. */
  remember?: { credential: string; expiresAt: number };
};
/* The published file loads each wallet family's sign-in on first use, from
 * its own immutable file named at build time, so a page with an EVM wallet
 * never downloads the Solana code and a Solana page never downloads EVM
 * code. Next and test bundles load the same code as module chunks. */
declare const __TEMPL_WIDGET_EVM__: string | undefined;
declare const __TEMPL_WIDGET_SOLANA__: string | undefined;
/** The only wallet methods a chunk can reach: it gets the provider through
 * this list, never the provider itself. */
const WALLET_METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "personal_sign",
];
/** A failed load, even one that throws at once, is an outage the next use
 * tries again. */
async function loadKit(
  wallet: SupportWallet,
  load: (path: string) => Promise<unknown> = chunk,
): Promise<WalletKit> {
  let kits;
  try {
    kits = (await (wallet.evm
      ? typeof __TEMPL_WIDGET_EVM__ == "string"
        ? load(__TEMPL_WIDGET_EVM__)
        : { evm: evmKit }
      : typeof __TEMPL_WIDGET_SOLANA__ == "string"
        ? load(__TEMPL_WIDGET_SOLANA__)
        : import("@templ/chat/widget-wallet").then((rules) => ({
            solana: (solana: SupportSolanaWallet) => solanaKit(solana, rules),
          })))) as {
      evm: typeof evmKit;
      solana(wallet: SupportSolanaWallet): WalletKit;
    };
  } catch {
    throw new Error(UNAVAILABLE);
  }
  const { evm } = wallet;
  return evm
    ? kits.evm({
        request: (input) =>
          WALLET_METHODS.includes(input.method)
            ? evm.request(input)
            : Promise.reject(new Error(UNAVAILABLE)),
      })
    : kits.solana(wallet.solana!);
}

/** Session tokens remain in memory; a guest keeps only its credential, which
 * finds its own thread again. A wallet change invalidates pending sign-ins and
 * reads as well as the current session. No private key or transaction call.
 * `runtime.load` imports a chunk by its path, for runtimes without the
 * published file's own URL. */
export function createSupportClient(
  options: SupportWidgetOptions,
  runtime: {
    fetch?: typeof fetch;
    origin?: string;
    load?: (path: string) => Promise<unknown>;
  } = {},
) {
  if (!UUID.test(options.workspace))
    throw new Error("Invalid workspace ID.");
  if (options.wallet && options.provider) throw new TypeError(BAD_WALLET);
  let wallet = checkedWallet(
    options.wallet ?? (options.provider && { evm: options.provider }),
  );
  const api = new URL(templApi(options.apiUrl));
  if (
    api.protocol !== "https:" ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error("Use an HTTPS API URL.");
  // The service accepts HTTPS websites and gated development websites.
  // Each session stays bound to the website where it started.
  const origin = runtime.origin ?? window.location.origin;
  const base = `${api.origin}/widget/${options.workspace}`;
  const fetcher = runtime.fetch ?? fetch;
  let session: WidgetSession | undefined,
    generation = 0,
    destroyed = false,
    // One guest start or resume at a time; later callers share its result.
    guestFlight: { resume: boolean; done: Promise<unknown> } | undefined,
    guestCredential: string | undefined,
    hosted = false,
    solanaSignIn = false,
    // A wallet sign-in ran out: the member signs in again, never as a guest.
    ended = false;
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  const publishSession = () => {
    for (const listener of listeners) listener();
  };
  const cancelPending = () => {
    guestFlight = undefined;
    generation++;
    for (const controller of requests) controller.abort();
  };
  const reset = () => {
    session = guestCredential = undefined;
    cancelPending();
    publishSession();
  };
  const endSession = () => {
    ended = true;
    reset();
  };
  const over = () =>
    ended || (session?.level === "signed" && session.expiresAt <= Date.now());
  const endedError = () =>
    Object.assign(new Error(SIGN_IN_AGAIN), { reason: "session-ended" });
  const walletChanged = () => {
    const previous = session;
    // A wallet change is a new identity.
    ended = false;
    reset();
    if (previous)
      void fetcher(`${base}/auth/logout`, {
        method: "POST",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${previous.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }).catch(() => {});
  };
  /** The wallet's family chunk, loaded once per wallet. */
  let kit: [SupportWallet, Promise<WalletKit>] | undefined;
  const walletKit = () => {
    if (!wallet)
      return Promise.reject(new Error("Connect a wallet."));
    if (kit?.[0] !== wallet) {
      const loading = loadKit(wallet, runtime.load);
      kit = [wallet, loading];
      // A failed load is tried again on the next use.
      loading.catch(() => {
        if (kit?.[1] === loading) kit = undefined;
      });
    }
    return kit[1];
  };
  /** The page's current wallet, read without a prompt. */
  const read = () => walletKit().then((loaded) => loaded.read());
  /** Whether the wallet still reports what a session holds. */
  const same = (selected: Selected | undefined, held: WidgetSession) =>
    (selected?.address ?? "") === held.address &&
    selected?.chainId === held.chainId;
  /** After setWallet or a Wallet Standard change: a session whose wallet or
   * shared wallet no longer matches ends. A guest who shared none keeps
   * their session. */
  async function recheck() {
    await guestFlight?.done.catch(() => {});
    const held = session,
      version = generation;
    if (!held?.address) return;
    const selected = claimOf(await read().catch(() => undefined));
    if (session === held && version === generation && !same(selected, held))
      walletChanged();
  }
  /** An EVM account or chain event ends a session tied to a wallet at once. */
  const walletEvent = () => {
    if (!session || session.address || guestFlight) walletChanged();
  };
  let unwatch = () => {};
  function watch() {
    const evm = wallet?.evm;
    evm?.on?.("accountsChanged", walletEvent);
    evm?.on?.("chainChanged", walletEvent);
    const off = (
      wallet?.solana as {
        features?: {
          "standard:events"?: {
            on?(event: "change", listener: () => void): unknown;
          };
        };
      }
    )?.features?.["standard:events"]?.on?.("change", () => void recheck());
    unwatch = () => {
      evm?.removeListener?.("accountsChanged", walletEvent);
      evm?.removeListener?.("chainChanged", walletEvent);
      if (typeof off == "function") off();
    };
  }
  watch();
  const [guestKey, threadKey] = guestKeys(options.workspace);
  /** The thread entry goes whenever the credential changes or goes. */
  const storeGuest = (value?: string, thread?: string | null) => {
    try {
      if (value) localStorage.setItem(guestKey, value);
      else localStorage.removeItem(guestKey);
      if (value && thread) localStorage.setItem(threadKey, thread);
      else localStorage.removeItem(threadKey);
    } catch {
      /* The thread stays reachable until this tab closes. */
    }
  };
  /** Keeps a guest's thread beside its own credential, so a return visit can
   * read it without asking for status first. */
  const remember = (thread: string | null) => {
    if (!session || session.level === "signed") return;
    session.thread = thread ?? undefined;
    if (
      guestCredential &&
      storedGuest(options.workspace)?.credential === guestCredential
    )
      storeGuest(guestCredential, thread);
  };
  async function call<T>(
    path: string,
    body?: object,
    anonymous = false,
    bearer?: string,
    renewed = false,
  ): Promise<T> {
    if (destroyed) throw new Error("Support is closed.");
    // A guest renews from its credential just before its hour ends.
    if (
      !anonymous &&
      !renewed &&
      session &&
      session.level !== "signed" &&
      session.expiresAt <= Date.now() + 5000
    )
      await client.guest(true, true);
    if (!anonymous && (!session || session.expiresAt <= Date.now())) {
      if (over()) {
        if (session) endSession();
        throw endedError();
      }
      reset();
      throw new Error("Sign in with your wallet.");
    }
    const version = generation;
    const authenticated = anonymous ? undefined : session;
    // Only a signed session is bound to the wallet it proved.
    const bound = authenticated?.level === "signed" ? authenticated : undefined;
    // The encrypted transport also uses this path with an encryptedRecord.
    // Read the route before serializing or posting a plaintext draft.
    if (
      path === "/conversations/ask" &&
      body &&
      (!("encryptedRecord" in body) ||
        Object.keys(body).some(
          (key) =>
            !["encryptedRecord", "validationReceipt", "reservation"].includes(
              key,
            ),
        ))
    ) {
      const checked = authenticated?.standardOpening ?? -1;
      if (authenticated) authenticated.standardOpening = -1;
      if (checked < performance.now() && (await client.status(true)).encryption)
        throw Object.assign(new Error("Open secure chat."), {
          reason: "encrypted-route",
        });
    }
    if (bound) await assertWallet(bound, version);
    if (
      version !== generation ||
      destroyed ||
      (authenticated && authenticated.principalId !== session?.principalId)
    )
      throw new Error(WALLET_CHANGED);
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let checkedResponse = false;
    try {
      const response = await fetcher(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
        // A bodiless GET sends no Content-Type, so the policy read needs no
        // preflight. The principal hint only lets the server start reads it
        // checks against the session anyway.
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          // The build id goes on every request that is preflighted anyway.
          ...(authenticated || body ? { "X-Templ-Widget": WIDGET_BUILD } : {}),
          ...(authenticated || bearer
            ? { Authorization: `Bearer ${authenticated?.token ?? bearer}` }
            : {}),
          ...(authenticated
            ? {
                "X-Templ-Principal-Hint": [
                  ...new Set([
                    authenticated.principalId,
                    ...(authenticated.servicePrincipals ?? []),
                  ]),
                ]
                  .filter((id) => /^[\w:-]{1,80}$/.test(id))
                  .slice(0, 8)
                  .join(","),
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Only JSON is read; a proxy's HTML error page is an outage.
      const data = /json/.test(response.headers.get("Content-Type") ?? "")
        ? await response.json()
        : void response.body?.cancel();
      if (bound) await assertWallet(bound, version);
      checkedResponse = true;
      if (version !== generation || destroyed)
        throw new Error(WALLET_CHANGED);
      if (!response.ok || !data) {
        if (response.status === 401 && authenticated) {
          if (authenticated.level === "signed") endSession();
          else {
            // A guest whose session ended early renews once and repeats
            // the same request, with the same clientId.
            if (
              !renewed &&
              (await client.guest(true, true))?.principalId ===
                authenticated.principalId
            )
              return call(path, body, anonymous, bearer, true);
            if (session === authenticated) reset();
          }
        }
        // The body's fields ride along (a resume's next key on an outage).
        throw Object.assign(
          new Error(
            typeof data?.error === "string"
              ? data.error
              : data?.reason === "secret-refused"
                ? "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone."
                : UNAVAILABLE,
          ),
          data,
          {
            status: response.status,
            reason: data ? data.reason : "not-json",
            retryAfter: Number(response.headers.get("Retry-After")),
          },
        );
      }
      return data as T;
    } catch (reason) {
      if (
        bound &&
        !checkedResponse &&
        session === bound &&
        version === generation &&
        !destroyed
      )
        await assertWallet(bound, version);
      if (/^(Abort|Timeout|Type|Syntax)Error$/.test((reason as Error)?.name))
        throw new Error(UNAVAILABLE);
      throw reason;
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  async function assertWallet(expected: WidgetSession, version: number) {
    let selected;
    try {
      selected = await read();
    } catch {
      if (session === expected && version === generation) walletChanged();
      throw new Error(SIGN_IN_AGAIN);
    }
    if (
      destroyed ||
      version !== generation ||
      session !== expected ||
      !same(selected, expected)
    ) {
      if (session === expected && version === generation) walletChanged();
      throw new Error(WALLET_CHANGED);
    }
  }
  const client = {
    get session() {
      return session && session.expiresAt > Date.now()
        ? {
            address: session.address,
            principalId: session.principalId,
            expiresAt: session.expiresAt,
            level: session.level,
            thread: session.thread,
            servicePrincipals: session.servicePrincipals?.slice(),
          }
        : undefined;
    },
    /** Who this workspace lets start a request: anyone, a connected wallet or a signed one. */
    async policy() {
      const policy = await call<{
        minimumLevel: "anyone" | "connected" | "signed";
        aiReplyExpected?: boolean;
        supportProfiles?: VisitorSupportProfiles;
        solanaSignIn?: boolean;
        walletFallback?: boolean;
        askPerson?: boolean;
        hosted?: boolean;
        /** A signed member can ask for an email when the team replies. */
        replyEmail?: boolean;
        /** The team's widget says "We never DM you first." */
        safetyLine?: boolean;
        appearance?: SupportWidgetAppearance;
        /** The domain this website proved. */
        verifiedDomain?: string;
        /** Members may add screenshots. */
        screenshots?: boolean;
        diagnostics?: boolean;
        chatFirst?: boolean;
        singleConversation?: boolean;
        newConversation?: boolean;
        templLeadCapture?: boolean;
        prompts?: string[];
        replyHours?: number;
      }>("/auth/policy", undefined, true);
      hosted = policy.hosted === true;
      solanaSignIn = policy.solanaSignIn === true;
      return policy;
    },
    /** True once a wallet sign-in ran out, until the member signs in again. */
    get ended() {
      return over();
    },
    /** Whether the page passed a wallet. Without one, visitors write as
     * guests and the widget offers no wallet sign-in. */
    get hasWallet() {
      return !!wallet;
    },
    get canSignIn() {
      return !!wallet && (!wallet.solana || solanaSignIn);
    },
    /** Starts, or resumes from this browser's credential, a session without a
     * wallet proof. Only a wallet approved by the visitor is sent as a claim.
     * Concurrent calls share one request. `renew` replaces a live guest
     * session from its credential. `check` is the visitor check's token for
     * a new guest (the live chunk's). */
    async guest(
      resumeOnly = false,
      renew = false,
      check?: string,
      walletUnavailable = false,
      consentedWallet?: Selected,
    ) {
      // An expired wallet session is not replaced by a guest behind its back.
      if (over()) {
        if (resumeOnly) return;
        throw endedError();
      }
      if (session?.level === "signed" || (!renew && this.session))
        return this.session;
      for (let flight; (flight = guestFlight); ) {
        try {
          await flight.done;
        } catch (reason) {
          if (resumeOnly || !flight.resume) throw reason;
        }
        if (
          this.session?.level === "signed" ||
          resumeOnly ||
          (!renew && this.session)
        )
          return this.session;
      }
      // The credential also stays in memory, for browsers that block storage.
      const stored =
        storedGuest(options.workspace) ??
        (guestCredential
          ? { credential: guestCredential, thread: session?.thread }
          : undefined);
      if (resumeOnly && !stored) return undefined;
      const version = generation;
      const flight = (async () => {
        const claim = claimOf(consentedWallet);
        // A resume names the page's wallet, so a wallet the guest shared
        // earlier comes back only while the page still reports it.
        const reported =
          stored && !claim && wallet && !walletUnavailable
            ? claimOf(await read().catch(() => undefined))
            : undefined;
        const start = (credential?: string) =>
          call<
            Omit<WidgetSession, "address" | "chainId"> & {
              credential: string;
              wallet?: { address: string; chainId?: number };
              standardOpening?: true;
            }
          >(
            "/auth/guest",
            {
              ...(claim ? { wallet: claim, walletConsent: true } : {}),
              ...(walletUnavailable ? { walletUnavailable: true } : {}),
              ...(credential
                ? {
                    credential,
                    ...(reported ? { reportedWallet: reported } : {}),
                  }
                : { check }),
            },
            true,
          );
        let started;
        try {
          started = await start(stored?.credential);
        } catch (reason) {
          if (!stored || (reason as { status?: number }).status !== 401)
            throw reason;
          // The server ended this credential; stop sending it.
          storeGuest();
          guestCredential = undefined;
          if (resumeOnly) return;
          started = await start();
        }
        if (version !== generation || destroyed)
          throw new Error(WALLET_CHANGED);
        // A wallet sign-in that finished meanwhile keeps its session.
        if (session?.level === "signed") return;
        guestCredential = started.credential;
        storeGuest(started.credential);
        session = {
          token: started.token,
          principalId: started.principalId,
          expiresAt: started.expiresAt,
          level: started.level,
          servicePrincipals: principals(started.servicePrincipals),
          address: started.wallet?.address ?? claim?.address ?? "",
          chainId: started.wallet?.chainId ?? claim?.chainId,
        };
        if (started.standardOpening === true)
          session.standardOpening = performance.now() + 1000;
        // A resumed credential keeps the thread stored beside it.
        if (started.credential === stored?.credential && stored.thread)
          remember(stored.thread);
        publishSession();
      })();
      const entry: { resume: boolean; done: Promise<unknown> } = {
        resume: resumeOnly,
        done: flight.finally(() => {
          if (guestFlight === entry) guestFlight = undefined;
        }),
      };
      guestFlight = entry;
      await entry.done;
      return this.session;
    },
    /** The live chunk's view of this client. Takes a
     * session it restored, or false to end a remembered one, and returns
     * the current session with what the chunk calls, and the website the
     * client speaks for. */
    adopt(next?: WidgetSession | false, transient?: boolean) {
      if (next) {
        if (transient) reset();
        session = next;
        if (next.level !== "signed" && next.credential) {
          guestCredential = next.credential;
          storeGuest(guestCredential, next.thread);
        }
        ended = false;
        publishSession();
      } else if (next === false) endSession();
      return [session, call, walletKit, base, origin] as const;
    },
    onSessionChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Stop work from a discarded view without signing out or removing its
     * retained guest credential. Late responses cannot adopt a session. */
    cancelPending,
    /** From a click only. The wallet family's chunk checks the service's
     * message against this website and workspace before the wallet sees it. */
    async signIn() {
      const loaded = await walletKit();
      // Signing from a guest session keeps that guest's thread: the server
      // moves it to this wallet only when the same guest bearer redeems it.
      const guestToken =
        session?.level === "signed" ? undefined : session?.token;
      const version = generation;
      const [verified, selected] = await loaded.signIn({
        origin,
        workspace: options.workspace,
        hosted,
        bearer: guestToken,
        call,
        read,
        stale: () => version !== generation,
      });
      // The wallet now holds the thread; the guest credential is spent.
      if (guestToken) storeGuest();
      const moved = verified.transfer?.moved
        ? verified.transfer.conversation
        : undefined;
      session = {
        token: verified.token,
        principalId: verified.principalId,
        address: selected.address,
        expiresAt: verified.expiresAt,
        chainId: selected.chainId,
        level: "signed",
        servicePrincipals: principals(verified.servicePrincipals),
        // The guest's thread moved to this wallet: no status read needed.
        thread: THREAD.test(moved ?? "") ? moved! : undefined,
      };
      ended = false;
      publishSession();
      return { ...this.session!, transfer: verified.transfer };
    },
    async signOut(forgetGuest?: boolean) {
      const current = generation;
      try {
        // Sign-out also ends a remembered sign-in on this site.
        if (session) await call("/auth/logout", { forget: true });
      } finally {
        if (!forgetGuest || current === generation) {
          if (forgetGuest) storeGuest();
          ended = false;
          reset();
        }
      }
    },
    async status(..._intent: [newCase?: true]) {
      void _intent;
      const status = await call<TeamConversationStatus>(
        "/conversations/status",
      );
      remember(status.mine);
      return status;
    },
    /** The response carries the stored message, with its id, clientId and time. */
    async ask(
      text: string,
      context?: SupportContextInput,
      clientId = requestId(),
      lead?: SupportLeadInput,
      newCaseFrom?: string,
    ) {
      const sent = await call<Sent>("/conversations/ask", {
        text,
        clientId,
        ...(context ? { context, contextConsent: true } : {}),
        ...(lead ? { lead } : {}),
        ...(newCaseFrom ? { newCaseFrom: conversationId(newCaseFrom) } : {}),
      });
      if (
        newCaseFrom &&
        (!THREAD.test(sent.conversation.id) ||
          sent.conversation.id === newCaseFrom ||
          sent.conversation.previousConversation !== newCaseFrom ||
          !sent.message)
      )
        throw new Error(UNAVAILABLE);
      remember(sent.conversation.id);
      return sent;
    },
    /** The server's page size (50) needs no query, so the URL stays stable.
     * `seen` marks the newest page as read by the member: send it only while
     * the chat is open in a visible tab. */
    messages(
      id: string,
      before?: string,
      seen?: boolean,
      ..._view: [select?: true]
    ) {
      void _view;
      return call<
        TeamConversationMessages & {
          workflow?: { verificationRequested?: boolean };
        }
      >(
        `/conversations/${conversationId(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : seen ? "?seen=1" : ""}`,
      );
    },
    reply(
      id: string,
      text: string,
      clientId = requestId(),
      context?: SupportContextInput,
    ) {
      return call<Sent>(`/conversations/${conversationId(id)}/messages`, {
        text,
        clientId,
        ...(context ? { context, contextConsent: true } : {}),
      });
    },
    context(id: string, context: SupportContextInput) {
      return call(`/conversations/${conversationId(id)}/workflow`, {
        action: "context",
        consent: true,
        context,
      });
    },
    /** The member's answer to "Did this solve it?" after the team resolved
     * the request. No reopens it when the team can take it. */
    confirm(id: string, solved: boolean) {
      return call<{ reopened?: boolean }>(
        `/conversations/${conversationId(id)}/workflow`,
        { action: "confirm", solved },
      );
    },
    /** "Talk to a person" on the member's own thread: the request goes to
     * the team and the AI agent stops answering it. Counts nothing. */
    askPerson(id?: string) {
      if (id)
        return call<{ handoff?: { at: string; by?: string } }>(
          `/conversations/${conversationId(id)}/workflow`,
          { action: "ask-person" },
        );
      return call<Sent>("/conversations/ask", {
        handoff: { by: "member" },
      }).then((sent) => {
        remember(sent.conversation.id);
        return sent;
      });
    },
    dataNotice(shown?: true): { version: number; url: string } | undefined {
      void shown;
      return undefined;
    },
    reportedWallet: () => read().catch(() => undefined),
    captureState() {
      return session
        ? Promise.resolve({ ...session })
        : read().catch(() => undefined);
    },
    /** The network the page's EVM wallet reports: a hint for a pasted hash. */
    async chain() {
      return (await walletKit()).chain();
    },
    /** The page's wallet was connected, switched or dropped. The same
     * wallet object changes nothing, and the same account keeps the session. */
    setWallet(next: SupportWallet | null) {
      const checked = checkedWallet(next);
      if (
        destroyed ||
        (checked?.evm ?? checked?.solana) === (wallet?.evm ?? wallet?.solana)
      )
        return;
      unwatch();
      wallet = checked;
      watch();
      publishSession();
      void recheck();
    },
    destroy() {
      if (destroyed) return;
      walletChanged();
      destroyed = true;
      listeners.clear();
      unwatch();
    },
  };
  return client;
}

/** The headless client createSupportClient returns. */
export type SupportClient = ReturnType<typeof createSupportClient>;
/** What a wallet chunk's passive read returns. */
export type { Selected as SupportSelectedWallet, WidgetSession };
/** `runtime` as for createSupportClient: Templ's frame mounts the widget
 * with the page's origin and its own fetch (support-widget-frame.ts). */
export function mountSupportWidget(
  options: SupportWidgetOptions,
  runtime?: Parameters<typeof createSupportClient>[1],
) {
  return renderSupportWidget({ chatFirst: true, conversationDrawers: true, ...options }, createSupportClient(options, runtime));
}

export type WidgetMessage = {
  id?: string;
  /** The author's retry ID; the widget matches its own sends by it. */
  clientId?: string;
  author: string;
  /** A reply's author name the team member chose for members. */
  teamName?: string | null;
  text: string;
  createdAt?: string;
};
export type WidgetMessages = {
  messages: WidgetMessage[];
  nextBefore: string | null;
  /** Guest ids that held this thread before the member proved a wallet,
   * whether a person was asked to answer, who
   * resolved it and the team's follow-up line. */
  conversation?: { diagnosisRunning?: boolean; aiQueued?: true } & Partial<
    Pick<
      TeamConversation,
      | "id"
      | "aiReplyExpected"
      | "revision"
      | "verifiedWalletAddress"
      | "formerMembers"
      | "state"
      | "handoff"
      | "confirmation"
      | "resolvedBy"
      | "previousConversation"
      // Member case closure field.
      // Accepts room-authorized case closure labels.
      // The member composer stays available.
      | "closed"
      | "followUp"
      | "encryption"
    >
  >;
  /** Room facts per author; a registered bot carries the "bot" badge. */
  authors?: Record<string, { badges?: string[] }>;
  /** When a person from the team joined each case on this page. */
  joined?: { at: string; name?: string }[];
  /** Someone on the team is writing a reply right now, or the team's AI
   * agent is running and about to answer the member's latest message. */
  typing?: "agent" | "team" | null;
  /** The team's request that a guest verify, on current services. */
  workflow?: { verificationRequested?: boolean };
};
export type WidgetClient = {
  readonly session:
    | {
        address: string;
        principalId: string;
        expiresAt: number;
        level?: AccessLevel;
        thread?: string;
        servicePrincipals?: string[];
      }
    | undefined;
  /** A wallet sign-in ran out; the member signs in again. */
  readonly ended?: boolean;
  readonly hasWallet?: boolean;
  readonly canSignIn?: boolean;
  onSessionChange(listener: () => void): () => void;
  signIn(): Promise<unknown>;
  signOut(): Promise<unknown>;
  policy?(): Promise<{
    minimumLevel: string;
    aiReplyExpected?: boolean;
    supportProfiles?: VisitorSupportProfiles;
    walletFallback?: boolean;
    askPerson?: boolean;
    replyEmail?: boolean;
    safetyLine?: boolean;
    appearance?: SupportWidgetAppearance;
    verifiedDomain?: string;
    screenshots?: boolean;
    diagnostics?: boolean;
    chatFirst?: boolean;
    singleConversation?: boolean;
    newConversation?: boolean;
    templLeadCapture?: boolean;
    prompts?: string[];
    replyHours?: number;
  }>;
  guest?(
    resumeOnly?: boolean,
    renew?: boolean,
    check?: string,
    walletUnavailable?: boolean,
    consentedWallet?: Selected,
  ): Promise<unknown>;
  status(
    newCase?: true,
  ): Promise<
    Pick<TeamConversationStatus, "mine" | "available" | "canAsk" | "encryption">
  >;
  ask(
    text: string,
    context?: SupportContextInput,
    clientId?: string,
    lead?: SupportLeadInput,
    newCaseFrom?: string,
  ): Promise<{
    conversation: { id: string; previousConversation?: string };
    message?: WidgetMessage;
  }>;
  reply(
    id: string,
    text: string,
    clientId?: string,
    context?: SupportContextInput,
  ): Promise<{ conversation?: { id: string }; message?: WidgetMessage }>;
  context(id: string, context: SupportContextInput): Promise<unknown>;
  confirm?(id: string, solved: boolean): Promise<{ reopened?: boolean }>;
  askPerson?(id?: string): Promise<unknown>;
  dataNotice?(shown?: true): { version: number; url: string } | undefined;
  reportedWallet?(): Promise<Selected | undefined>;
  captureState?(): Promise<import("./support-widget-snapshot").WalletState>;
  chain?(): Promise<number>;
  setWallet?(wallet: SupportWallet | null): void;
  messages(
    id: string,
    before?: string,
    seen?: boolean,
    select?: true,
  ): Promise<WidgetMessages>;
  destroy(): void;
};
export type SupportDemoOptions = {
  previewLauncher?: boolean;
  label?: string;
  appearance?: SupportWidgetAppearance;
  /** A fixed sample case, confined to the in-memory demo transport. */
  scenario?: "failed-transaction" | "conversation" | "shared-transaction";
  /** Called with each demo message, for a page that mirrors the inbox. */
  onMessage?: (message: { from: "member" | "team"; text: string }) => void;
};

/** The public widget renderer, with an in-memory demonstration transport.
 * It creates no identity, ticket, token or network request. */
export function mountSupportDemo(
  container: HTMLElement,
  demo: SupportDemoOptions = {},
) {
  const id = "demo";
  const failedTransaction = demo.scenario === "failed-transaction";
  const sharedTransaction = demo.scenario === "shared-transaction";
  const conversationDemo = demo.scenario === "conversation" || sharedTransaction;
  const session = {
    address: failedTransaction
      ? "0x71C400000000000000000000000000000000a42f"
      : "",
    principalId: "demo-member",
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...(failedTransaction ? { level: "signed" as const } : {}),
  };
  let next = conversationDemo ? 4 : 3;
  const messages: WidgetMessage[] = [
    {
      id: "1",
      author: "demo-member",
      text: failedTransaction
        ? "My deposit failed. What now?"
        : "My deposit confirmed. Why is my vault balance still zero?",
    },
    {
      id: "2",
      author: "demo-team",
      ...(failedTransaction ? { teamName: "Sample app" } : {}),
      text: failedTransaction
        ? "Deposits are paused. Please try again once they reopen."
        : "I have your wallet and transaction. I’ll ask the vault team to review this.",
    },
  ];
  if (conversationDemo) messages.splice(0, messages.length,
    {id:"1",author:"demo-member",text:"Can I get help without connecting my wallet?",createdAt:new Date().toISOString()},
    {id:"2",author:"demo-ai",text:"Yes. Share only the details you want us to see.",createdAt:new Date().toISOString()},
    {id:"3",author:"demo-team",teamName:"Founder",text:"And you can talk to me in this same chat.",createdAt:new Date().toISOString()});
  if (sharedTransaction) {
    const now = new Date().toISOString();
    messages.splice(0, messages.length,
      { id: "1", author: "demo-member", text: transactionExample.question, createdAt: now },
      { id: "2", author: "demo-team", teamName: "Support team", text: transactionExample.reply, createdAt: now });
  }
  const sent = new Set<string>();
  const answer = (text: string) =>
    conversationDemo ? "This is an example. Try the chat to talk to Templ." : text === "What happens next?"
      ? "The team replies in this chat. Come back here to read it."
      : text === "Who can see this?"
        ? `${demo.label ?? "Vault support"}'s support team, including people who answer for them`
        : "This would reach the team's inbox with the details above.";
  const append = async (text: string, clientId?: string) => {
    if (clientId && sent.has(clientId)) return { conversation: { id } };
    if (clientId) sent.add(clientId);
    const reply = answer(text);
    messages.push(
      { id: String(next++), clientId, author: "demo-member", text },
      { id: String(next++), author: "demo-team", ...(conversationDemo ? {teamName:"Founder"} : {}), text: reply },
    );
    if (messages.length > 40) messages.splice(0, messages.length - 40);
    demo.onMessage?.({ from: "member", text });
    demo.onMessage?.({ from: "team", text: reply });
    return { conversation: { id } };
  };
  const widget = renderSupportWidget(
    {
      workspace: "demo",
      chatFirst: conversationDemo,
      label: sharedTransaction ? "Protocol support" : failedTransaction
        ? "Sample case"
        : (demo.label ?? "Vault support"),
      prompts: failedTransaction
        ? []
        : ["What happens next?", "Who can see this?"],
      persistDrafts: false,
      showLauncher: demo.previewLauncher ?? false,
      appearance: demo.appearance,
    },
    {
      session,
      ...(conversationDemo ? {canSignIn:false,policy:async()=>({minimumLevel:"anyone",chatFirst:true,askPerson:false,replyEmail:false})} : {}),
      onSessionChange: () => () => {},
      signIn: async () => {},
      signOut: async () => {},
      status: async () => ({
        mine: id,
        available: true,
        canAsk: true,
      }),
      ask: (text, _context, clientId) => append(text, clientId),
      reply: (_id, text, clientId) => append(text, clientId),
      context: async () => {},
      messages: async () => ({ messages: [...messages], nextBefore: null,
        ...(conversationDemo ? {authors:{"demo-ai":{badges:["bot"]}}} : {}) }),
      destroy: () => {
        messages.length = 0;
        sent.clear();
      },
    },
    {
      container,
      readOnly: failedTransaction || sharedTransaction,
      style: DEMO_STYLE,
      decorate({ header, close, body, starter, panel, draft }) {
        if (conversationDemo) {panel.dataset.demo = "conversation"; panel.setAttribute("aria-description", "Example conversation. Nothing is sent or signed."); close.hidden = true; return;}
        if (failedTransaction)
          void loadWelcome().then(
            ({ welcome }) => {
              const identity = header.querySelector<HTMLElement>(".sub");
              if (header.isConnected && identity)
                welcome.identity(identity, session);
            },
            () => {},
          );
        if (demo.previewLauncher) panel.style.height = "calc(100% - 72px)";
        if (!failedTransaction) {
          const label = document.createElement("span");
          label.className = "demo-label";
          label.textContent = "Sample";
          header.insertBefore(label, close);
        }
        const sample = document.createElement("p");
        sample.className = "demo-context";
        if (failedTransaction) {
          sample.dataset.result = "failed";
          const result = document.createElement("strong");
          result.textContent = "Transaction check";
          const reference = document.createElement("span");
          reference.textContent = "Base 0x9f…8c2e";
          const status = document.createElement("span");
          status.className = "demo-result";
          status.textContent = "Failed";
          const cause = document.createElement("span");
          cause.style.display = "block";
          cause.textContent = "Deposits paused";
          sample.append(result, reference, status, cause);
        } else
          sample.textContent =
            "Wallet 0x71…a42f and transaction 0x9f…8c2e on Ethereum";
        sample.setAttribute("aria-label", "Example case details");
        body.insertBefore(sample, starter);
        panel.setAttribute(
          "aria-description",
          failedTransaction
            ? "Sample. Nothing is sent or signed."
            : "Sample replies. Messages stay in this tab.",
        );
        draft.placeholder = "Ask a follow-up…";
        draft.setAttribute("aria-label", "Demo message");
        if (failedTransaction) {
          panel.dataset.demo = "failed-transaction";
          const notice = document.createElement("p");
          notice.className = "demo-notice";
          notice.textContent = "Sample. Nothing is sent or signed.";
          panel.append(notice);
        }
      },
    },
  );
  widget.open(false);
  return widget;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** One-path outline glyphs, built as DOM so host pages with Trusted Types work. */
const ICONS = {
  chat: "M4 5h16v11H10l-5 4v-4H4z",
  close: "M6 6l12 12M18 6L6 18",
  send: "M4 12l16-8-6 16-3-7zM11 13l9-9",
  wallet: "M3 7h18v12H3zM3 7l3-3h11v3M16 13h2",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  check: "M5 12l5 5 9-10",
} as const;
function icon(name: keyof typeof ICONS) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [attribute, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(attribute, value);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
/** Layout and colors show while the full style chunk loads. */
const widgetStyle = () =>
  `:host{all:initial;${WIDGET_DARK_BASE};font:inherit}:host([data-theme=light]){${WIDGET_LIGHT_BASE}}@media(prefers-color-scheme:light){:host([data-theme=auto]){${WIDGET_LIGHT_BASE}}}[hidden]{display:none!important}svg{width:18px;height:18px;flex:none}.launcher{position:fixed;right:20px;bottom:20px}.panel{position:fixed;inset:auto 20px 100px auto;display:flex;flex-flow:column;width:min(392px,100vw - 32px);height:min(480px,100dvh - 124px);overflow:hidden;border-radius:var(--rp,16px);background:var(--bg);color:var(--t)}.head{display:flex}.body{flex:1;min-height:0;overflow:auto}@media(max-width:480px){.panel{inset:auto 8px 8px;width:auto;height:calc(100dvh - 16px)}}`;
declare const __TEMPL_WIDGET_APPEARANCE__: string | undefined;
const loadAppearance = (): Promise<
  typeof import("./support-widget-appearance")
> =>
  typeof __TEMPL_WIDGET_APPEARANCE__ === "string"
    ? chunk(__TEMPL_WIDGET_APPEARANCE__)
    : import("./support-widget-appearance");
declare const __TEMPL_WIDGET_STYLE__: string | undefined;
const loadStyle = (): Promise<typeof import("./support-widget-style")> =>
  typeof __TEMPL_WIDGET_STYLE__ === "string"
    ? chunk(__TEMPL_WIDGET_STYLE__)
    : import("./support-widget-style");
declare const __TEMPL_WIDGET_LEAD__: string | undefined;
const loadLead = (): Promise<typeof import("./support-widget-lead")> =>
  typeof __TEMPL_WIDGET_LEAD__ === "string"
    ? chunk(__TEMPL_WIDGET_LEAD__)
    : import("./support-widget-lead");
const DEMO_STYLE = `.demo-label{padding:2px 8px;border:1px solid var(--b2);border-radius:var(--rc,0);color:var(--m);font-size:11px;font-weight:600;white-space:nowrap}:host{display:block;width:100%;height:100%}.panel{position:relative;inset:auto;width:100%;height:100%;min-height:420px;z-index:auto;box-shadow:none;border:0;border-radius:var(--rp);animation:none}.launcher{position:absolute;bottom:12px;right:12px;z-index:1}.launcher[aria-expanded=true]{display:flex}:host([data-position=left]) .launcher{left:12px}:host([data-position=left]) .panel{inset:auto;transform-origin:bottom left}.demo-context{margin:0 0 12px;padding:8px 11px;border:1px solid var(--b);border-radius:var(--rc,12px);background:var(--s);color:var(--m);font-size:11.5px;line-height:1.45}.demo-context[data-result=failed]{color:var(--t);font-size:13px}.demo-context[data-result=failed] strong{display:block;margin-bottom:6px;font-size:13px}.demo-result{float:right;padding:2px 7px;border:1px solid var(--b2);border-radius:var(--rc,0);font-size:11px;color:var(--t)}.demo-notice{flex:none;margin:0;padding:8px 16px;color:var(--m);font-size:12px;text-align:center}.tools,.muted,.safety{display:none}.panel[data-demo=failed-transaction]{height:auto;min-height:0}.panel[data-demo=failed-transaction] .body{flex:0 0 auto;overflow:visible;padding-bottom:0}.panel[data-demo=failed-transaction] .demo-notice{margin-top:20px;padding:0 16px 12px}.panel[data-demo=failed-transaction] .demo-result{font-size:13px;color:var(--d);background:var(--db);border-color:var(--d)}:host{--demo-good:#a5e5db;--demo-good-bg:#103b34}:host([data-theme=light]){--demo-good:#0c6b60;--demo-good-bg:#e4f4ef}@media(prefers-color-scheme:light){:host([data-theme=auto]){--demo-good:#0c6b60;--demo-good-bg:#e4f4ef}}.panel[data-demo=failed-transaction] .sub[data-level=signed] .tag{color:var(--demo-good);background:var(--demo-good-bg);border-color:var(--demo-good)}`;

/** One shareable detail. `send` is what a ticked row adds to the context. */
type Row = {
  label: string;
  value: string;
  send: SupportContextInput;
  checked?: boolean;
  shared?: boolean;
  /** The hash the visitor typed, still in the field. */
  mine?: boolean;
};
export type Make = <T extends keyof HTMLElementTagNameMap>(
  tag: T,
  text?: string,
  className?: string,
) => HTMLElementTagNameMap[T];
/** What the context card uses from the widget. */
export type CardHost = {
  el: Make;
  style: HTMLStyleElement;
  card: HTMLElement;
  tx: HTMLInputElement;
  txNote: HTMLElement;
  policy?(): { diagnostics?: boolean } | undefined;
  saveDraft(): void;
  chain?(): Promise<number>;
  focus(): void;
};
export type CardRules = Pick<
  typeof ContextRules,
  "parseSupportNetwork" | "parseTransactionReference" | "supportNetworkName"
>;
/* The published file loads two parts on first use, each from its own
 * immutable file named at build time: the context rows (the typed details
 * from the app, which load the context card with the network names and
 * explorer rules it needs) and the extras (what the chat shows after a
 * send: typing, handoff, Talk to a person, and wallet verification).
 * Next and test bundles load the same code as module chunks. */
declare const __TEMPL_WIDGET_CONTEXT__: string | undefined;
declare const __TEMPL_WIDGET_EXTRAS__: string | undefined;
/** A chunk on the published file's own origin (its paths are absolute).
 * `globalThis.URL` keeps bundlers from reading the pair as an asset. */
const chunk = (path: string) =>
  import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */
    new globalThis.URL(path, import.meta.url).href
  );
const loadCard = (): Promise<{
  card(widget: CardHost): Promise<ContextCard>;
}> =>
  typeof __TEMPL_WIDGET_CONTEXT__ == "string"
    ? chunk(__TEMPL_WIDGET_CONTEXT__)
    : import("./support-widget-snapshot");
const loadExtras = (): Promise<{ extras: typeof extras }> =>
  typeof __TEMPL_WIDGET_EXTRAS__ == "string"
    ? chunk(__TEMPL_WIDGET_EXTRAS__)
    : Promise.resolve({ extras });
/* The live chunk (support-widget-live.ts): this tab's
 * session after a reload, the waiting marker, remembered sign-in and the
 * member socket. Loaded only when this browser holds a key for the
 * workspace or a session starts on the page. */
declare const __TEMPL_WIDGET_LIVE__: string | undefined;
const loadLive = (): Promise<typeof import("./support-widget-live")> =>
  typeof __TEMPL_WIDGET_LIVE__ == "string"
    ? chunk(`${__TEMPL_WIDGET_LIVE__}#${requestId()}`)
    : import("./support-widget-live");
/* The verified-domain line under the title
 * (support-widget-domain.ts), loaded only when the policy names one. */
declare const __TEMPL_WIDGET_DOMAIN__: string | undefined;
const loadDomain = (): Promise<typeof import("./support-widget-domain")> =>
  typeof __TEMPL_WIDGET_DOMAIN__ == "string"
    ? chunk(__TEMPL_WIDGET_DOMAIN__)
    : import("./support-widget-domain");
/** What the lines after the newest message use from the widget. */
declare const __TEMPL_WIDGET_CONSENT__: string | undefined;
const loadConsent = (): Promise<typeof import("./support-widget-consent")> =>
  typeof __TEMPL_WIDGET_CONSENT__ === "string"
    ? chunk(__TEMPL_WIDGET_CONSENT__)
    : import("./support-widget-consent");

declare const __TEMPL_WIDGET_DRAFTS__: string | undefined;
const loadDrafts = (): Promise<typeof import("./support-widget-drafts")> =>
  typeof __TEMPL_WIDGET_DRAFTS__ === "string"
    ? chunk(__TEMPL_WIDGET_DRAFTS__)
    : import("./support-widget-drafts");

declare const __TEMPL_WIDGET_ART__: string | undefined;
const loadBranding = (): Promise<typeof import("./support-widget-art")> =>
  typeof __TEMPL_WIDGET_ART__ === "string"
    ? chunk(__TEMPL_WIDGET_ART__)
    : import("./support-widget-art");

export type TailHost = {
  lifetime?: AbortSignal;
  options: SupportWidgetOptions;
  /** Used only for visual grouping. Never copy a private sender ID into the DOM. */
  messageAuthors?: WeakMap<HTMLElement, string>;
  guest?: typeof import("./support-widget-guest").guest;
  loadingGuest?: boolean;
  el: Make;
  draft: HTMLTextAreaElement;
  style: HTMLStyleElement;
  /** The welcome block's wallet sign-in, which keeps a guest's thread. */
  signIn: HTMLButtonElement;
  launcher: HTMLElement;
  client: WidgetClient;
  own(author: string): boolean;
  run(action: () => Promise<void>): Promise<void>;
  errorText(reason: unknown): string;
  refresh(afterWrite: boolean): Promise<void>;
  render(): void;
  reviewLead?(
    text: string,
    details: { rows: [string, string][]; edit(): void; cancel(): void },
    send: (wallet?: Selected) => void,
  ): Promise<import("./support-widget-consent").ReviewResult>;
  leadState?(busy: boolean, handoff: boolean): void;
  /** A confirmed member send may offer an optional email follow-up. */
  messageSent?: boolean;
  /** A drawer opt-in may attach only to the case created by this visitor's actual send. */
  firstMessageListeners?: Set<(conversation: string, principal: string) => void>;
  /** Threads whose visitor send started a wait in this widget. */
  replyWaits?: Set<string>;
  leadStyles?: string;
  /** The single action row and its optional email action. */
  emailButton?: HTMLButtonElement;
  thread?(): string | null;
  verifiedWallet?(): string | undefined;
  draftingConversation?(): boolean;
  showCase?(id: string): Promise<void>;
  replyNotices?: boolean;
  notify?: () => Promise<void>;
  talk?: () => void;
  /** Set once the extras' styles are in the widget. */
  styled?: boolean;
  /** A wallet sign-in is running: the in-chat Sign in shows that too. */
  signing?: boolean;
  /** Set by the extras: Templ's newest open incident line and when it was
   * read. */
  notice?: { at: number; line: string };
  /** The welcome block (its sign-in button already in it) and the icons,
   * for the words and the trust list the extras draw. */
  welcome: HTMLElement;
  icon: typeof icon;
  /** The welcome block's heading, line and trust list, once drawn. */
  words?: [HTMLElement, HTMLElement, HTMLElement];
  fallback?: HTMLButtonElement;
  firstPerson?: HTMLButtonElement;
  /** Memory only: the handoff line this thread showed last and the newest
   * message then. The server clears a handoff when a person takes the
   * request, before anyone replies; the line stays until a team or AI agent
   * message follows or the request is resolved. */
  held?: { by: string; id: number; thread: string | null } | null;
  /** The workspace's policy answer, once read. */
  policy?: {
    hosted?: boolean;
    chatMode?: "standard" | "encrypted";
    aiReplyExpected?: boolean;
    supportProfiles?: VisitorSupportProfiles;
    minimumLevel?: string;
    walletFallback?: boolean;
    askPerson?: boolean;
    replyEmail?: boolean;
    safetyLine?: boolean;
    screenshots?: boolean;
    diagnostics?: boolean;
    chatFirst?: boolean;
    singleConversation?: boolean;
    newConversation?: boolean;
    templLeadCapture?: boolean;
    prompts?: string[];
    replyHours?: number;
  };
  /** Set by the extras: the member lines, once loaded, and the newest team
   * reply the member answered "No" to on an open request, as
   * `<thread>:<message id>`, for when storage is unavailable. */
  member?: MemberLines;
  loadingMember?: boolean;
  // What the ops chunk reads from the widget.
  // The page's latest setContext value and the public calls.
  offered?: SupportContextInput;
  /** The scrollable choice cards used by consent and the install check. */
  choices?: HTMLElement;
  api?: {
    open(): void;
    close(): void;
    captureFailure(input: SupportContextInput): Promise<unknown>;
  };
};
/** The typing dots and the lines under the newest message. */
const TAIL_STYLE =
  ".dots{display:flex;gap:4px;padding:6px 0 3px}.dots i{width:6px;height:6px;border-radius:9px;background:var(--m);animation:blink 1.2s infinite}.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.nudge{padding:10px 12px;border:1px solid var(--b);border-radius:var(--rb,14px);background:var(--s)}@media(prefers-reduced-motion:reduce){.dots i{animation:none}}";
function typingLine(el: TailHost["el"], part: string): [string, unknown[], (node: HTMLElement) => void] {
  // The same key and signature keep the animation running when the first send gets its thread ID.
  return ["~" + part, [], (node) => {
    node.dataset.state = part;
    node.className = "message typing tail";
    const label = part === "typing agent" ? "AI assistant"
      : part === "checking" ? "Checking the transaction" : "Team is typing…";
    const dots = el("span", undefined, "dots");
    dots.setAttribute("aria-hidden", "true");
    dots.append(el("i"), el("i"), el("i"));
    node.append(el("small", label), dots);
  }];
}

/** What each line under the newest message says. */
const TAIL_LINES: Record<string, string> = {
  received: "Received.",
  wait: "Your message is saved. The team can reply here.",
  member: "You asked for a person. Someone from the team will reply here.",
  agent: "AI passed this to the team.",
  person: "Your case is with the team. They’ll reply here.",
  dot: "You can close this chat or come back later. While this page is open, the chat button shows a dot when they reply.",
  verify:
    "The team asked you to prove this wallet is yours. Signing is free and can't move funds.",
};
/** The fixed line a widget shows while Templ has an open
 * notice of that kind. Operator notes never reach a widget, and kinds that
 * only affect teams have no line. Sign-in shows only on a page with a
 * wallet. */
const INCIDENT_LINES: Record<string, string> = {
  "slow-replies":
    "Replies may be slower than usual right now. Your message is saved.",
  "sign-in": "Wallet sign-in isn't working for everyone right now.",
  maintenance: "Support may pause for a few minutes for maintenance.",
};
/** Reads Templ's public notices at most once a minute: no credentials, no
 * workspace, no visitor. A failed read shows nothing. */
function readNotice(host: TailHost) {
  const now = Date.now();
  if (host.notice && now - host.notice.at < 60_000) return;
  host.notice = { at: now, line: host.notice?.line || "" };
  fetch(templApi() + "/status/incidents", { credentials: "omit" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      const found = (body?.incidents || []).find(
        (row: { kind: string; state: string; updatedAt: string }) =>
          row.state == "open" &&
          now - Date.parse(row.updatedAt) < 216e5 &&
          INCIDENT_LINES[row.kind] &&
          (row.kind != "sign-in" || host.client.hasWallet),
      );
      const line = found ? INCIDENT_LINES[found.kind] : "";
      if (line != host.notice!.line) {
        host.notice = { at: now, line };
        host.render();
      }
    })
    .catch(() => {});
}
/** The member's own call to the widget service, for the member lines. A
 * demonstration client has none. */
type MemberCall = (path: string, body?: object) => Promise<unknown>;
export const memberCall = (host: TailHost) =>
  (host.client as { adopt?(): readonly [unknown, MemberCall] }).adopt?.()[1];
/* The member lines (support-widget-member.ts): the wait
 * expectation, the follow-up line, reply email, the sources of the AI
 * agent's reply and the details the member shared. The extras load them. */
declare const __TEMPL_WIDGET_MEMBER__: string | undefined;
const loadMember = (): Promise<{ member: MemberLines }> =>
  typeof __TEMPL_WIDGET_MEMBER__ == "string"
    ? chunk(__TEMPL_WIDGET_MEMBER__)
    : import("./support-widget-member");
/* The guest reply-notice chunk and the welcome chunk (sign-in, the
 * first-open controls and identity text), both loaded by the extras. */
declare const __TEMPL_WIDGET_GUEST__: string | undefined;
const loadGuest = (): Promise<typeof import("./support-widget-guest")> =>
  typeof __TEMPL_WIDGET_GUEST__ === "string"
    ? chunk(__TEMPL_WIDGET_GUEST__)
    : import("./support-widget-guest");
declare const __TEMPL_WIDGET_WELCOME__: string | undefined;
const loadWelcome = (): Promise<typeof import("./support-widget-welcome")> =>
  typeof __TEMPL_WIDGET_WELCOME__ === "string"
    ? chunk(__TEMPL_WIDGET_WELCOME__)
    : import("./support-widget-welcome");
/** Everything the widget loads on first use besides the context card. */
export const extras = {
  ready: () => loadWelcome().then(({ welcome }) => welcome.ready(), () => {}),
  async guest(host: TailHost) {
    if (
      (host.options.guestLink ?? location.hash ?? "").startsWith(
        "#templ-guest=",
      )
    )
      await (await loadGuest()).guest.resume(host);
  },
  starter(
    ...args: Parameters<
      typeof import("./support-widget-welcome").welcome.starter
    >
  ) {
    void loadWelcome().then(
      ({ welcome }) => welcome.starter(...args),
      () => {},
    );
  },
  questions(
    ...args: Parameters<
      typeof import("./support-widget-welcome").welcome.questions
    >
  ) {
    void loadWelcome().then(
      ({ welcome }) => welcome.questions(...args),
      () => {},
    );
  },
  firstOpen(
    ...args: Parameters<
      typeof import("./support-widget-welcome").welcome.firstOpen
    >
  ) {
    void loadWelcome().then(
      ({ welcome }) => welcome.firstOpen(...args),
      () => {},
    );
  },
  welcome(
    ...args: Parameters<
      typeof import("./support-widget-welcome").welcome.welcome
    >
  ) {
    void loadWelcome().then(
      ({ welcome }) => welcome.welcome(...args),
      () => {},
    );
  },
  identity(
    ...args: Parameters<
      typeof import("./support-widget-welcome").welcome.identity
    >
  ) {
    void loadWelcome().then(
      ({ welcome }) => welcome.identity(...args),
      () => {},
    );
  },
  fullPage(style: HTMLStyleElement) {
    style.textContent +=
      ":host{display:block;height:100%;width:100%}.panel,:host([data-position=left]) .panel{position:relative;inset:auto;width:100%;height:100%;border:0;border-radius:0;box-shadow:none}";
  },
  /** What the member sees under the newest message, so they always know
   * who acts next: one assistant bubble across sending and writing, a
   * receipt for team-only sends, the team's wait line,
   * the handoff line for whoever asked for a person, a guest's dot line,
   * and the team's request to verify. Returns one
   * entry per line, each with its key, what it depends on and what builds
   * it, so a line that stays keeps its node: the typing row doesn't rise
   * again and a screen reader doesn't hear it again when another line
   * changes. Nothing here is stored, sent or counted except the member's
   * own Talk to a person. */
  tail(
    host: TailHost,
    messages: WidgetMessage[],
    typing: string | null,
    info: WidgetMessages["conversation"],
    authors: WidgetMessages["authors"],
    thread: string | null,
    verify: boolean,
    fresh: boolean,
    pending: "sending" | "failed" | number | undefined,
    waiting: boolean,
  ): [string, unknown[], (node: HTMLElement) => void][] {
    const { el, client, own } = host;
    if (!host.styled) {
      host.styled = true;
      host.style.textContent += TAIL_STYLE;
    }
    const last = thread ? messages.at(-1) : undefined;
    const expected = ((thread ? info?.aiReplyExpected : undefined) ?? host.policy?.aiReplyExpected) === true;
    const typingDuringSend = pending === "sending" && expected && !host.options.replyAfterReceipt;
    if (!last) return typingDuringSend ? [typingLine(el, "typing agent")] : [];
    const id = Number(last.id),
      mine = own(last.author),
      age = Date.now() - Date.parse(last.createdAt ?? ""),
      level = client.session?.level,
      handoff = info?.handoff,
      resolved = info?.state == "resolved",
      kept = host.held?.thread == thread ? host.held : null;
    const held = (host.held = handoff
      ? {
          by:
            handoff.by == "member" || handoff.by == "agent"
              ? handoff.by
              : "person",
          id,
          thread,
        }
      : kept &&
          !resolved &&
          !messages.some(
            (message) => !own(message.author) && Number(message.id) > kept.id,
          )
        ? kept
        : null);
    if (thread) {
      if (!mine || held || resolved || !expected) host.replyWaits?.delete(thread);
      else if (fresh) (host.replyWaits ??= new Set()).add(thread);
    }
    const parts: string[] = [];
    if (!resolved && !held && typing !== "team" && !info?.encryption && info?.aiReplyExpected !== false && (
      pending !== undefined ? typingDuringSend :
      mine && (typing === "agent" || (expected && (fresh || host.replyWaits?.has(thread!) || age < 300_000)))
    )) parts.push("typing agent");
    else if (!resolved && fresh && !pending && !held && !info?.diagnosisRunning)
      parts.push("received");
    else if (!resolved && !pending) {
      const by = held?.by;
      if (info?.diagnosisRunning) parts.push("checking");
      else if (typing === "team") parts.push("typing team");
      if (by) parts.push(by);
      else if (!info?.diagnosisRunning && !typing && mine) parts.push("wait");
      // A closed widget keeps checking only while the page is open, the
      // member waits and the launcher shows. A signed member's session
      // ends after an hour, so only guests are told.
      if (
        (by || (!typing && mine)) &&
        age > 120_000 &&
        level &&
        level != "signed" &&
        waiting &&
        !host.launcher.hidden
      )
        parts.push("dot");
    }
    if (
      !resolved &&
      client.askPerson &&
      host.policy?.askPerson !== false &&
      !host.firstPerson
    )
      parts.push("hatch");
    // The member waits on the team: the wait and reply email lines show.
    const waits =
      !typing &&
      (parts.includes("wait") || !!held?.by);
    if (verify) parts.push("verify");
    readNotice(host);
    if (!resolved && host.notice!.line) parts.push("incident");
    const button = (text: string, action: () => void) => {
      const node = el("button", text);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    };
    /** Talk to a person: the member's line shows at once; an error puts
     * back what was there and shows the service's text. */
    const talk = () =>
      void host.run(async () => {
        const before = host.held;
        host.held = { by: "member", id, thread };
        host.render();
        try {
          await client.askPerson!(thread!);
        } catch (reason) {
          host.held = before;
          host.render();
          throw reason;
        }
        host.draft.focus();
        await host.refresh(true);
      });
    host.talk = talk;
    const lines = parts.map(
      (part): [string, unknown[], (node: HTMLElement) => void] =>
        part === "checking" || part.startsWith("typing ") ? typingLine(el, part) : [
        "~" + part,
        // Talk to a person keeps the newest message it was drawn under; the
        // verify card shows the wallet step while it runs.
        [
          thread,
          part == "hatch" && id,
          part == "hatch" && !!held,
          part == "verify" && !!host.signing,
          part == "incident" && host.notice!.line,
        ],
        (node) => {
          node.dataset.state = part;
          node.className =
            part == "verify" || part == "incident"
              ? "system nudge tail"
              : "system tail";
          // Talk to a person is a button with no line of its own.
          node.append(
            (part == "incident"
              ? host.notice!.line
              : host.options.chatFirst &&
                  (host.policy?.chatFirst || host.policy?.singleConversation) &&
                  ["member", "person", "dot"].includes(part)
                ? part === "dot"
                  ? "The chat button shows replies while this page is open."
                  : "The team will reply here. Keep writing in this chat."
                : TAIL_LINES[part]) || "",
          );
          if (part == "hatch") {
            const control = button(
              held ? "Waiting for the team" : "Talk to a person",
              talk,
            );
            control.disabled = !!held;
            node.append(control);
          }
          // The team asked; only the member starts the sign-in.
          if (part == "verify") {
            const sign = button(
              host.signing ? "Check your wallet…" : "Sign in",
              () => host.signIn.click(),
            );
            sign.disabled = !!host.signing;
            node.append(sign);
          }
        },
      ],
    );
    if (
      host.replyNotices &&
      host.policy?.replyEmail &&
      level !== "signed" &&
      thread &&
      messages.some((message) => own(message.author))
    ) {
      if (host.guest) lines.push(...host.guest.lines(host, thread));
      else if (!host.loadingGuest && memberCall(host)) {
        host.loadingGuest = true;
        loadGuest().then(
          (module) => {
            host.guest = module.guest;
            host.render();
          },
          () => {
            host.loadingGuest = false;
          },
        );
      }
    }
    // The member lines load with the first thread and draw once here.
    if (!host.member) {
      if (!host.loadingMember && memberCall(host)) {
        host.loadingMember = true;
        loadMember().then(
          (module) => {
            host.member = module.member;
            host.render();
          },
          () => (host.loadingMember = false),
        );
      }
      return lines;
    }
    const [above, below] = host.member.lines(host, {
      messages,
      info,
      authors,
      thread: thread!,
      mine,
      waits,
    });
    if (host.policy?.singleConversation && held && !resolved) {
      // Keep the same notification buttons and opt-in form when a handoff is shown.
      const choice = [...above, ...lines, ...below].find(([key]) => key === "~reply-email" || key === "~guest-email");
      const handoff = lines.find(([key]) => ["~member", "~person", "~agent"].includes(key));
      if (choice && handoff) {
        const [key, deps, draw] = choice;
        const joined: typeof handoff = [handoff[0], [...handoff[1], key, ...deps], (node) => {
          draw(node);
          node.classList.add("handoff-notice");
          node.prepend(el("strong", "Your question is with the team."));
        }];
        return [...above, ...lines, ...below].filter(line => line !== choice).map(line => line === handoff ? joined : line);
      }
    }
    return [...above, ...lines, ...below];
  },
};
/** The context card: the page's details and the visitor's own hash, one row
 * each, sent only when ticked. Rows are built as text; the page's values
 * never become markup. */
/** What the context rows hand back to the widget: the card's own methods,
 * with the typed rows added to what they share. */
export type ContextCard = ReturnType<typeof contextCard> & {
  available?(available: boolean): void;
  destroy?(): void;
  confirmed?(context?: SupportContextInput): void;
  cancelled?(context?: SupportContextInput): void;
  clearCapturedFailures?(): void;
  capture?(capture: import("./support-widget-snapshot").Capture): Promise<void>;
  state?(state: Promise<import("./support-widget-snapshot").WalletState>): void;
};
export function contextCard(
  widget: CardHost,
  {
    parseSupportNetwork,
    parseTransactionReference,
    supportNetworkName,
  }: CardRules,
) {
  const { el, card, tx } = widget;
  widget.style.textContent +=
    ".card{margin-bottom:8px;font-size:12.5px}.card .row{display:flex;align-items:start;gap:8px}.card .row>label,.card label.row{flex:1;display:grid;grid-template-columns:16px minmax(0,1fr);align-items:start;gap:2px 6px;min-width:0}.card .row input{grid-column:1;grid-row:1/3}.card .row b,.card .row span{grid-column:2;white-space:normal;overflow-wrap:anywhere}.card .row .shared{grid-column:1/-1}.card .icon-button{flex:none}";
  let rows: Row[] = [],
    hostNetwork: SupportNetwork | undefined;
  const txRow = (found: SupportTransaction, mine?: boolean): Row => ({
    label: "Transaction",
    value:
      found.hash +
      (found.network ? " on " + supportNetworkName(found.network) : ""),
    send: { transactions: [found] },
    checked: mine,
    mine,
  });
  const title = "With your message";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", title);
  function render() {
    const offered = rows.filter((row) => !row.shared);
    card.hidden = !offered.length;
    card.replaceChildren(
      el("b", title),
      el("p", "Only checked details are sent.", "muted"),
    );
    for (const row of offered) {
      const line = el("div", undefined, "row");
      const box = el("label");
      const name = `${row.label}: ${row.value}`;
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = !!row.checked;
      tick.setAttribute("aria-label", "Share " + name);
      tick.addEventListener("change", () => {
        row.checked = tick.checked;
      });
      box.append(tick);
      const value = el("span", row.value);
      value.title = row.send.transactions?.[0].hash ?? row.value;
      box.append(el("b", row.label), value);
      line.append(box);
      if (!row.shared) {
        const remove = el("button", "×", "icon-button");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove " + name);
        remove.addEventListener("click", () => {
          rows = rows.filter((item) => item !== row);
          if (row.mine) {
            tx.value = "";
            widget.saveDraft();
          }
          render();
          widget.focus();
        });
        line.append(remove);
      }
      card.append(line);
    }
  }
  /** The visitor's own hash: a ticked row when valid, a note when not. A
   * bare EVM hash takes the page's network, else the one the wallet reports. */
  function typed() {
    const value = tx.value.trim();
    const found = value ? parseTransactionReference(value, hostNetwork) : null;
    widget.txNote.textContent = value && !found ? BAD_HASH : "";
    rows = rows.filter((row) => !row.mine);
    if (found) rows.push(txRow(found, true));
    render();
    if (found && !found.network && value[1] == "x")
      void widget.chain?.().then((id) => {
        const hinted =
          tx.value.trim() == value &&
          isEip155ChainId(id) &&
          parseTransactionReference(value, `eip155:${id}`);
        if (hinted) {
          rows = rows.map((row) => (row.mine ? txRow(hinted, true) : row));
          render();
        }
      }, String);
  }
  tx.addEventListener("input", () => {
    typed();
    widget.saveDraft();
  });
  return {
    typed,
    /** Whether the visitor's typed hash is still a row of its own. */
    mine: () => rows.some((row) => row.mine),
    /** The ticked rows not yet shared, as one context, or none. Sent rows
     * leave the consent panel. */
    ticked() {
      const picked = rows.filter((row) => row.checked && !row.shared);
      if (!picked.length) return;
      const shared: SupportContextInput = {};
      for (const row of picked) {
        const list = [
          ...(shared.transactions ?? []),
          ...(row.send.transactions ?? []),
        ];
        Object.assign(shared, row.send, list.length && { transactions: list });
        row.shared = true;
        row.mine = row.checked = false;
      }
      render();
      return shared;
    },
    /** The page's context becomes unticked rows. Values Templ can't read
     * are dropped with a console warning; this never throws. */
    set(next?: SupportContextInput) {
      const input: Record<string, unknown> =
        next && typeof next == "object" ? next : {};
      const given = (value: unknown) =>
        value !== undefined && value !== null && value !== "";
      const warn = (field: string) =>
        console.warn(`Templ support: ignored an invalid context ${field}.`);
      const network = (value: Record<string, unknown>) =>
        (given(value.network)
          ? parseSupportNetwork(value.network)
          : given(value.chainId) && isEip155ChainId(value.chainId)
            ? (`eip155:${value.chainId}` as const)
            : undefined) ?? (warn("network"), undefined);
      const list: Row[] = [];
      hostNetwork =
        given(input.network) || given(input.chainId)
          ? network(input)
          : undefined;
      if (hostNetwork)
        list.push({
          label: "Network",
          value: supportNetworkName(hostNetwork),
          send: { network: hostNetwork },
        });
      for (const item of [
        input.transactionHash,
        ...(Array.isArray(input.transactions) ? input.transactions : []),
      ]) {
        if (!given(item)) continue;
        const entry = (
          typeof item == "object" ? item : { hash: item }
        ) as Record<string, unknown>;
        const own =
          given(entry.network) || given(entry.chainId)
            ? network(entry)
            : hostNetwork;
        const found =
          typeof entry.hash == "string" &&
          list.length < (hostNetwork ? 6 : 5) &&
          parseTransactionReference(entry.hash, own);
        if (found) list.push(txRow(found));
        else warn("transaction");
      }
      const note = input.description;
      if (
        typeof note == "string" &&
        new TextEncoder().encode(note).length <= 2000
      ) {
        if (note.trim())
          list.push({
            label: "Note from the app",
            value: note.trim(),
            send: { description: note.trim() },
          });
      } else if (given(note)) warn("description");
      for (const field of Object.keys(input))
        if (
          ![
            "network",
            "chainId",
            "transactionHash",
            "transactions",
            "description",
          ].includes(field)
        )
          warn(field);
      rows = list;
      typed();
    },
  };
}
const MISMATCH = "The wallet sign-in does not match this website.";
const CHANGED = "Your wallet changed. Try again.";
type Challenge = { message: string; nonce: string; expiresAt: number };
/** Issued At and Expiration Time, each once and in ISO form: a lifetime of
 * at most five minutes that ends at the service's expiry. The browser and
 * service may differ slightly; that difference is bounded without extending
 * the signed lifetime or the server's expiry. Returns both times, or
 * nothing when a rule fails. */
function challengeTimes(
  lines: string[],
  challenge: Challenge,
  requestedAt: number,
) {
  const time = (label: string) => {
    const entries = lines.filter((line) => line.startsWith(`${label}: `));
    const value = entries.length == 1 ? entries[0].slice(label.length + 2) : "";
    const at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString() === value
      ? at
      : NaN;
  };
  const issuedAt = time("Issued At"),
    expiresAt = time("Expiration Time"),
    now = Date.now();
  if (
    /^[0-9a-f]{64}$/.test(challenge.nonce) &&
    Number.isSafeInteger(challenge.expiresAt) &&
    expiresAt === challenge.expiresAt &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= 300_000 &&
    issuedAt >= requestedAt - 30_000 &&
    issuedAt <= now + 30_000 &&
    expiresAt > now - 30_000
  )
    return [issuedAt, expiresAt];
}
/** The sign-in both families share. The wallet is asked for nothing until
 * the service's message passes `check`; the account is read again before
 * and after the signature and after the service answers, and any change
 * ends the attempt. */
function makeKit(
  read: () => Promise<Selected>,
  connect: () => Promise<Selected>,
  chain: () => Promise<number>,
  check: (
    challenge: Challenge,
    selected: Selected,
    host: SignInHost,
    requestedAt: number,
    statements: string[],
  ) => unknown,
  sign: (message: string, selected: Selected) => Promise<unknown>,
): WalletKit {
  const steps = signInSteps();
  let attempt = 0;
  return {
    read,
    chain,
    steps(host) {
      steps.mount(host);
      if (host.signing) return;
      const current = ++attempt;
      void read().then(
        () => {
          if (current === attempt) steps.update(2);
        },
        () => {
          if (current === attempt) steps.update(1);
        },
      );
    },
    async signIn(host) {
      attempt++;
      let selected;
      try {
        selected = await host.read();
      } catch {
        selected = await connect();
      }
      steps.update(2);
      // Remembered sign-in: asked only by the rendered widget, on an HTTPS
      // site other than a development origin, with writable storage. The
      // service may still answer with today's statement.
      const memberKey = `templ:support-member:v1:${host.workspace}`;
      let keep = false;
      try {
        keep =
          !host.shareConversation &&
          // Set by the live chunk of the widget rendered in this tab.
          sessionStorage.getItem(`templ:support-keep:v1:${host.workspace}`) ==
            "1" &&
          /^https:/.test(host.origin) &&
          !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(
            host.origin,
          ) &&
          (localStorage.setItem(`${memberKey}:probe`, "1"),
          localStorage.removeItem(`${memberKey}:probe`),
          true);
      } catch {
        keep = false;
      }
      const requestedAt = Date.now();
      const challenge = await host.call<Challenge>(
        "/auth/nonce",
        host.shareConversation ? { ...selected, shareConversation: host.shareConversation }
          : keep ? { ...selected, remember: true } : selected,
        true,
        host.bearer,
      );
      if (
        !check(
          challenge,
          selected,
          host,
          requestedAt,
          host.shareConversation ? [WIDGET_WALLET_SHARE_STATEMENT]
            : keep ? [WIDGET_SIGN_IN_STATEMENT, WIDGET_REMEMBER_STATEMENT]
              : [WIDGET_SIGN_IN_STATEMENT],
        )
      )
        throw new Error(MISMATCH);
      const unchanged = async () => {
        const now = await host.read();
        if (host.stale() || JSON.stringify(now) !== JSON.stringify(selected))
          throw new Error(CHANGED);
      };
      await unchanged();
      const signature = await sign(challenge.message, selected).catch(
        (reason) => {
          if (
            reason?.code === 4001 ||
            /reject|cancel|declin/i.test(reason?.message ?? "")
          )
            throw new Error("Signature cancelled. Nothing was sent.");
          throw reason;
        },
      );
      await unchanged();
      const verified = await host.call<Verified>(
        "/auth/verify",
        { ...challenge, signature },
        true,
        host.bearer,
      );
      const current = await host.read();
      if (
        host.stale() ||
        JSON.stringify(current) !== JSON.stringify(selected) ||
        (verified.wallet?.address ?? verified.address) !== selected.address ||
        verified.shareConversation !== host.shareConversation ||
        !/^[0-9a-f]{64}$/.test(verified.token) ||
        verified.expiresAt <= Date.now()
      )
        throw new Error("Could not verify this wallet sign-in.");
      // Keep the remembered sign-in's key for this site and workspace. A key
      // it replaces is ended on the service.
      const kept = verified.remember;
      if (
        keep &&
        kept &&
        /^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(kept.credential) &&
        kept.expiresAt > Date.now()
      )
        try {
          const before = JSON.parse(localStorage.getItem(memberKey) ?? "null");
          localStorage.setItem(
            memberKey,
            JSON.stringify({
              c: kept.credential,
              a: selected.address,
              n: selected.network ? "solana" : "evm",
              x: kept.expiresAt,
            }),
          );
          if (typeof before?.c == "string" && before.c != kept.credential)
            void host
              .call("/auth/forget", { credential: before.c }, true)
              .catch(() => undefined);
        } catch {
          /* This visit stays signed in; the next one signs again. */
        }
      steps.update(3);
      return [verified, selected];
    },
  };
}
/** The EVM chunk: an EIP-1193 wallet's account and network, and a
 * personal_sign of the Sign-In with Ethereum message. */
export function evmKit(provider: SupportWalletProvider): WalletKit {
  const passive = async (method: "eth_accounts" | "eth_chainId") => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.request({ method }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("The wallet did not respond. Try again.")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  async function read(connect?: boolean): Promise<Selected> {
    // The passive reads run together; a connect prompt comes first.
    const [accounts, chain] = connect
      ? [
          await provider.request({ method: "eth_requestAccounts" }),
          await passive("eth_chainId"),
        ]
      : await Promise.all([passive("eth_accounts"), passive("eth_chainId")]);
    if (
      !Array.isArray(accounts) ||
      typeof accounts[0] !== "string" ||
      !/^0x[0-9a-f]{40}$/i.test(accounts[0]) ||
      typeof chain !== "string" ||
      !/^0x[0-9a-f]+$/i.test(chain)
    )
      throw new Error("Connect an EVM wallet on this website.");
    return {
      address: accounts[0].toLowerCase(),
      chainId: Number.parseInt(chain, 16),
    };
  }
  return makeKit(
    () => read(),
    () => read(true),
    async () => Number.parseInt(String(await passive("eth_chainId")), 16),
    (
      challenge,
      selected,
      { origin, workspace, hosted, shareConversation },
      requestedAt,
      statements,
    ) => {
      const lines = challenge.message.split("\n");
      const site = new URL(origin);
      return (
        lines[0] ===
          `${site.protocol}//${site.host} wants you to sign in with your Ethereum account:` &&
        lines[1]?.toLowerCase() === selected.address &&
        // Wallet sharing requires the explicit consent statement.
        ((!shareConversation && lines[3] === "") || statements.includes(lines[3])) &&
        lines.includes(
          `URI: ${hosted ? `${origin}/help/${workspace}` : origin}`,
        ) &&
        lines.includes(`Chain ID: ${selected.chainId}`) &&
        lines.includes(`Nonce: ${challenge.nonce}`) &&
        challengeTimes(lines, challenge, requestedAt)
      );
    },
    (message, selected) =>
      provider.request({
        method: "personal_sign",
        params: [
          `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
          selected.address,
        ],
      }),
  );
}
type StandardAccount = { address: string; chains?: readonly string[] };
type StandardWallet = {
  accounts: readonly StandardAccount[];
  features: {
    "standard:connect"?: { connect?(): Promise<unknown> };
    "solana:signMessage"?: {
      signMessage?(input: {
        account: StandardAccount;
        message: Uint8Array;
      }): Promise<
        readonly { signedMessage?: Uint8Array; signature?: Uint8Array }[]
      >;
    };
  };
};
/** The Solana chunk: the wallet's account, and one Sign In With Solana
 * message signed through solana:signMessage or the wallet's signMessage.
 * The message must be the one the service builds for this website and
 * workspace, byte for byte; the signature goes back as padded base64 of its
 * 64 bytes. */
export function solanaKit(
  wallet: SupportSolanaWallet,
  {
    encodeWidgetSolanaSignature,
  }: Pick<typeof WalletRules, "encodeWidgetSolanaSignature">,
): WalletKit {
  const standard = "accounts" in wallet ? (wallet as StandardWallet) : null;
  const signer = wallet as Extract<SupportSolanaWallet, { publicKey: unknown }>;
  const cantSign = () =>
    new Error("This wallet can't sign in here. Try another wallet.");
  async function read(): Promise<Selected> {
    const address = standard
      ? standard.accounts.find(
          (account) =>
            !account.chains ||
            account.chains.some((chain) => chain.startsWith("solana:")),
        )?.address
      : signer.publicKey?.toBase58();
    if (!isSolanaAddress(address))
      throw new Error("Connect a Solana wallet on this website.");
    return { network: "solana", address };
  }
  return makeKit(
    read,
    async () => {
      // Only from a Sign in click; a wallet with no way to connect says so.
      await (
        standard ? standard.features["standard:connect"] : signer
      )?.connect?.();
      return read();
    },
    async () => NaN,
    (
      challenge,
      selected,
      { origin, workspace, hosted },
      requestedAt,
      statements,
    ) => {
      const lines = challenge.message.split("\n");
      const times = challengeTimes(lines, challenge, requestedAt);
      // Exactly one resource: this workspace on Templ's site.
      const resource = lines.at(-1)!.slice(2);
      return (
        times &&
        new RegExp(`^https://[\\w.-]+(:\\d+)?/rooms/${workspace}$`).test(
          resource,
        ) &&
        statements.some(
          (statement) =>
            challenge.message ===
            createSolanaSignInMessage({
              domain: new URL(origin).host,
              address: selected.address,
              statement,
              uri: hosted ? `${origin}/help/${workspace}` : origin,
              nonce: challenge.nonce,
              issuedAt: new Date(times[0]),
              expirationTime: new Date(times[1]),
              resources: [resource],
            }),
        )
      );
    },
    async (message, selected) => {
      const bytes = new TextEncoder().encode(message);
      let signature: unknown;
      if (standard) {
        const account = standard.accounts.find(
          (item) => item.address === selected.address,
        );
        const feature = standard.features["solana:signMessage"];
        if (!account || !feature?.signMessage) throw cantSign();
        const [output] = await feature.signMessage({ account, message: bytes });
        // A wallet that signed other bytes than these is refused.
        if (
          output?.signedMessage &&
          output.signedMessage.join() !== bytes.join()
        )
          throw cantSign();
        signature = output?.signature;
      } else {
        if (!signer.signMessage) throw cantSign();
        const output = await signer.signMessage(bytes);
        signature = output instanceof Uint8Array ? output : output?.signature;
      }
      if (!(signature instanceof Uint8Array) || signature.length != 64)
        throw cantSign();
      return encodeWidgetSolanaSignature(signature);
    },
  );
}
/** The landing-page demo's container, styles and labels. Only
 * mountSupportDemo passes it, so the published file carries none of it. */
type DemoSetup = {
  container: HTMLElement;
  readOnly?: boolean;
  style: string;
  decorate(parts: {
    header: HTMLElement;
    close: HTMLElement;
    body: HTMLElement;
    starter: HTMLElement;
    panel: HTMLElement;
    draft: HTMLTextAreaElement;
  }): void;
};
function renderSupportWidget(
  options: Omit<SupportWidgetOptions, "provider" | "wallet">,
  client: WidgetClient,
  demo?: DemoSetup,
) {
  const chunkFailed = (step: string, route = "widget") =>
    console.warn("TEMPL_SUPPORT_FAILURE", { route, step, cause: "chunk-load" });
  const demoContainer = demo?.container;
  const host = document.createElement("div");
  host.setAttribute("data-templ-support", "");
  let appearance = options.appearance ?? {};
  host.dataset.theme = appearance.theme ?? "auto";
  let boundAppearance:
    | ReturnType<
        typeof import("./support-widget-appearance").bindWidgetAppearance
      >
    | undefined;
  void loadAppearance().then(
    (module) => {
      if (active) boundAppearance = module.bindWidgetAppearance(host, appearance);
    },
    () => chunkFailed("widget-appearance"),
  );
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  const fullStyle = document.createElement("style");
  const nonce = options.styleNonce;
  if (nonce) {
    style.nonce = nonce;
    fullStyle.nonce = nonce;
  }
  style.textContent = widgetStyle() + (demo?.style ?? "");
  const styleReady = loadStyle().then(
    (module) => {
      if (!active) return;
      fullStyle.textContent = module.widgetStyle();
    },
    () => {
      if (active) {
        chunkFailed("widget-load");
        showError(new Error(LOAD_FAILED));
      }
    },
  );
  const el = <T extends keyof HTMLElementTagNameMap>(
    tag: T,
    text?: string,
    className?: string,
  ) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const label = options.label ?? "Support";
  const launcher = el("button", undefined, "launcher");
  launcher.type = "button";
  launcher.append(icon("chat"), document.createTextNode(label));
  launcher.hidden = !!options.container || options.showLauncher === false;
  launcher.setAttribute("aria-expanded", "false");
  const panel = el("section", undefined, "panel");
  panel.hidden = true;
  panel.setAttribute(
    "role",
    demoContainer || options.container ? "region" : "dialog",
  );
  panel.setAttribute("aria-label", label);
  const header = el("div", undefined, "head");
  const avatar = el("span", undefined, "avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(icon("chat"));
  const titles = el("div", undefined, "titles");
  const subtitle = el("span", "Private chat", "sub");
  titles.append(el("strong", label), subtitle);
  header.append(avatar, titles);
  const close = el("button", undefined, "icon-button");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.append(icon("close"));
  close.hidden = !!demoContainer || !!options.container && !options.onClose;
  header.append(close);
  const body = el("div", undefined, "body");
  // The welcome block's words come with the extras; its button shows at once.
  const welcome = el("div", undefined, "welcome");
  const signIn = el("button", undefined, "primary");
  signIn.type = "button";
  const signInLabel = el("span", "Verify wallet");
  signIn.append(icon("wallet"), signInLabel);
  welcome.append(signIn);
  const messages = el("div", undefined, "messages");
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  const starter = el("div", undefined, "starter");
  starter.hidden = true;
  // A returning guest sees this until the widget finds their conversation.
  const loading = el("p", "Opening chat…", "starter loading-case");
  loading.hidden = true;
  const older = el("button", "Earlier messages", "older");
  older.type = "button";
  older.hidden = true;
  const suggestions = el("div", undefined, "suggestions");
  suggestions.setAttribute("role", "group");
  suggestions.setAttribute("aria-label", "Common questions");
  body.append(welcome, older);
  // A live widget shows its questions with the starter, before the visitor's
  // first message. The demo shows them under its sample chat.
  suggestions.hidden = !demoContainer || !!demo?.readOnly;
  body.append(starter, loading, messages, suggestions);
  const error = el("p", undefined, "error");
  error.setAttribute("role", "alert");
  const form = el("form", undefined, "form");
  form.hidden = true;
  const composer = el("div", undefined, "composer");
  const draft = el("textarea");
  draft.placeholder = "Write your message…";
  draft.rows = 1;
  draft.maxLength = 2000;
  draft.required = true;
  draft.setAttribute("aria-label", "Message to the support team");
  draft.setAttribute(
    "aria-description",
    "Enter sends. Shift+Enter adds a new line.",
  );
  const send = el("button", undefined, "send");
  send.type = "submit";
  send.append(icon("send"));
  composer.append(draft, send);
  // Details the visitor chooses to share: one row each, ticked to send.
  const card = el("div", undefined, "card");
  card.hidden = true;
  const choices = el("div", undefined, "context-choices");
  choices.hidden = true;
  choices.append(card);
  body.append(choices);
  const tools = el("div", undefined, "tools");
  const attachToggle = el("button", "+", "icon-button");
  attachToggle.setAttribute("aria-label", "Add details");
  attachToggle.type = "button";
  attachToggle.setAttribute("aria-expanded", "false");
  const signOut = el("button", "Sign out", "quiet");
  signOut.type = "button";
  const emailButton = el("button", "Notify me", "quiet");
  emailButton.type = "button";
  emailButton.disabled = true;
  tools.append(signOut, emailButton);
  composer.insertBefore(attachToggle, draft);
  emailButton.addEventListener("click", () => {
    if (tailHost.policy?.templLeadCapture) return;
    if (tailHost.notify) {
      void tailHost.run(tailHost.notify);
      return;
    }
    tailHost.replyNotices = true;
    render();
  });
  const attach = el("div", undefined, "attach");
  attach.hidden = true;
  const attachId = `templ-attach-${Math.random().toString(36).slice(2)}`;
  attach.id = attachId;
  attachToggle.setAttribute("aria-controls", attachId);
  const tx = el("input");
  tx.hidden = attachToggle.hidden = options.transactionField === false;
  tx.placeholder = "Transaction ID or link";
  tx.maxLength = 300;
  tx.spellcheck = false;
  tx.setAttribute("aria-label", tx.placeholder);
  const txNote = el("p", undefined, "muted");
  attach.append(tx, txNote);
  const draftNotice = el("p", undefined, "muted");
  draftNotice.setAttribute("role", "status");
  form.append(composer, attach, draftNotice);
  header.insertBefore(tools, close);
  // Safety stays in the opening chat, without permanent footer rows.
  const warning = el(
    "p",
    "Never share a recovery phrase or private key.",
    "safety",
  );
  body.prepend(warning);
  panel.append(header, body, error, form);
  demo?.decorate({ header, close, body, starter, panel, draft });
  root.append(fullStyle, style, launcher, panel);
  let branding:
    | ReturnType<typeof import("./support-widget-art").bindWidgetBranding>
    | undefined;
  let brandingLoad: Promise<void> | undefined;
  const paintBranding = () => {
    if (branding) branding.set(appearance);
    else if (
      appearance.logo ||
      appearance.font ||
      appearance.colors ||
      appearance.headerNotice
    )
      brandingLoad ??= loadBranding().then(
        (module) => {
          if (active) branding = module.bindWidgetBranding(host, appearance);
        },
        () => {},
      );
  };
  paintBranding();
  (demoContainer ?? options.container ?? document.body).append(host);
  // The page's latest context; a later setContext replaces every row.
  let hostContext = options.context,
    captureRevision = 0,
    // The context card, a module loaded when there is something to share.
    cards: ContextCard | undefined,
    loadingCards: Promise<unknown> | undefined,
    // What shows after a send, loaded on first use.
    more: typeof extras | undefined,
    loadingExtras: Promise<void> | undefined,
    loadingLead: Promise<unknown> | undefined;
  let formController:
    | ReturnType<typeof import("./support-widget-form").forms>
    | undefined;
  let formRevision = 0;
  let consent:
    | ReturnType<typeof import("./support-widget-consent").consent>
    | undefined;
  let loadingConsent: Promise<void> | undefined;
  const withConsent = () =>
    demoContainer
      ? Promise.resolve()
      : (loadingConsent ??= loadConsent()
          .then((module) => {
            tailHost.leadStyles = module.leadStyles;
            consent = module.consent(tailHost, form, starter, () => ({
              conversation,
              state: info?.state,
            }));
            setStarter();
            render();
          })
          .catch((reason) => {
            loadingConsent = undefined;
            console.warn("widget_summary_failed", "chunk-load");
            throw reason;
          }));
  const returning = !demoContainer && !!storedGuest(options.workspace);
  let conversation: string | null = null,
    before: string | null = null,
    busy = false,
    poll: ReturnType<typeof setTimeout> | undefined,
    active = true,
    // Unknown until the policy loads; guests are the default.
    minimumLevel: string | undefined,
    verifyRequested = false,
    // A returning guest waits for their thread. Everyone else sees the
    // questions at once: they need no network.
    restoring = returning,
    noThreadYet = !returning && !client.session,
    // The visitor's message is the latest one, or the team is typing.
    awaitingReply = false,
    // A send was confirmed and no read since says who answers it.
    fresh = false,
    // The visitor waits on the team: their message is under a day old, or
    // a person was asked to answer. A closed widget then checks for replies.
    waiting = false,
    // The newest team reply the open panel showed, and whether the closed
    // launcher reported a newer one.
    seen = 0,
    unread = false,
    formerMembers: string[] = [],
    // The newest page, older pages the visitor loaded, and their authors.
    latest: WidgetMessage[] = [],
    earlier: WidgetMessage[] = [],
    authors: WidgetMessages["authors"] = {},
    info: WidgetMessages["conversation"] = {},
    // Join lines by time, from every page read.
    joined: Record<string, { at: string; name?: string }> = {},
    typing: string | null = null,
    nodes = new Map<string, { node: HTMLElement; sig: string }>(),
    rendered = "",
    // A session's remembered thread is tried once before asking for status.
    hintTried = false,
    quick = 0,
    failures = 0,
    changedAt = Date.now(),
    sequence = 0,
    sessionRevision = 0,
    // "sending", "failed", or the seconds left before an automatic retry.
    sendState: "sending" | "failed" | number = "failed";
  type PendingMessage = {
    id: string;
    text: string;
    target: string | null;
    newCaseFrom?: string;
    context?: SupportContextInput;
    wallet?: Selected;
    /** The reply arrived; only its approved context is left to share. */
    sent?: boolean;
    serverId?: string;
  };
  let pending: PendingMessage | undefined;
  let newCaseFrom: string | undefined;
  /** The approved details frozen with this reply. */
  const sharing = (attempt: PendingMessage) =>
    attempt.target &&
    attempt.context &&
    Object.values(attempt.context).some(Boolean)
      ? attempt.context
      : undefined;
  /** When a UUIDv7 message ID was made. */
  const sentAt = (id: string) =>
    Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  let draftPrincipal: string | undefined;
  let refreshing: Promise<void> | undefined;
  const draftKey = (principal: string) =>
    `templ:support-draft:v1:${window.location.origin}:${options.workspace}:${principal}`;
  const own = (author: string) =>
    author === client.session?.principalId ||
    client.session?.servicePrincipals?.includes(author) ||
    formerMembers.includes(author);
  const confirms = (message: WidgetMessage, attempt: PendingMessage) =>
    own(message.author) &&
    (message.clientId === attempt.id ||
      (!!attempt.serverId && message.id === attempt.serverId));
  const lifetime = new AbortController();
  const messageAuthors = new WeakMap<HTMLElement, string>();
  const tailHost: TailHost = {
    lifetime: lifetime.signal,
    messageAuthors,
    options,
    el,
    draft,
    style,
    choices,
    signIn,
    launcher,
    emailButton,
    thread: () => conversation,
    draftingConversation: () => !!newCaseFrom,
    client,
    own,
    run,
    errorText: widgetErrorMessage,
    refresh,
    render,
    welcome,
    icon,
    reviewLead: async (text, details, send) => {
      if (busy || pending || !active) return active ? "busy" : "cancelled";
      const reviewedSession = sessionRevision;
      await withConsent();
      if (reviewedSession !== sessionRevision) return "cancelled";
      if (busy || pending || !active) return active ? "busy" : "cancelled";
      return consent!.review(text, send, details);
    },
  };
  tailHost.verifiedWallet = () =>
    info?.id === conversation && !newCaseFrom ? info.verifiedWalletAddress : undefined;
  function setAttachOpen(open: boolean) {
    attach.hidden = !open || !!demoContainer;
    attachToggle.setAttribute("aria-expanded", String(open));
  }
  function setStarter() {
    form.toggleAttribute("data-case-resolved", !newCaseFrom && info?.state === "resolved");
    choices.hidden = form.hidden || !!demoContainer;
    cards?.available?.(
      !pending &&
        !choices.hidden &&
        (!!newCaseFrom || info?.state !== "resolved"),
    );
    consent?.empty(!conversation && !draft.value.trim());
    const hidden =
      form.hidden || !!demoContainer || messages.childElementCount > 0;
    starter.hidden = hidden || restoring;
    if (more && (!demoContainer || options.chatFirst))
      more.firstOpen(
        tailHost,
        tools,
        !!info?.handoff,
        conversation,
        busy || !!pending,
      );
    if (tailHost.firstPerson) tools.prepend(tailHost.firstPerson);
    const emailAllowed = !!tailHost.policy?.replyEmail;
    if (!tailHost.policy?.templLeadCapture) {
      emailButton.disabled =
        !emailAllowed || !conversation || busy || !!pending;
      emailButton.title = !emailAllowed
        ? "Email notices unavailable"
        : !conversation
          ? "Send a message first."
          : "Get email notices";
    }
    loading.hidden = hidden || !restoring;
    showQuestions();
    // Verification requires a wallet; a current proof offers Sign out.
    const level = client.session?.level;
    signOut.hidden = false;
    signOut.disabled =
      busy ||
      (level !== "signed" && (client.canSignIn ?? client.hasWallet) === false);
    tools.hidden = !!demoContainer || form.hidden;
  }
  function showQuestions() {
    more?.questions(
      tailHost,
      suggestions,
      starter,
      demoContainer
        ? !suggestions.hidden
        : !starter.hidden &&
            noThreadYet &&
            !(options.chatFirst && (tailHost.policy?.chatFirst || tailHost.policy?.singleConversation)),
      busy || !!pending || !!draft.value.trim(),
      (text) => {
        if (busy || pending || draft.value.trim()) return;
        try {
          options.onStep?.("prompt_used");
        } catch {
          /* Measurement cannot stop a send. */
        }
        draft.value = text;
        draft.focus();
        form.requestSubmit(send);
      },
      warm,
    );
  }
  function fitDraft() {
    draft.style.height = "auto";
    draft.style.height = `${Math.min(draft.scrollHeight, 148)}px`;
  }
  /** One message sends at a time; typing the next one stays free. */
  function showPending() {
    const sending = !!pending && sendState !== "failed";
    send.disabled = busy || !!pending;
    send.setAttribute("aria-busy", String(sending));
    send.setAttribute("aria-label", sending ? "Sending…" : "Send");
    showQuestions();
    tailHost.leadState?.(busy || !!pending, !!info?.handoff);
  }
  let draftStore: typeof import("./support-widget-drafts") | undefined;
  let loadingDraftStore:
    | Promise<typeof import("./support-widget-drafts")>
    | undefined;
  let draftRevision = 0;
  const withDraftStore = () =>
    (loadingDraftStore ??= loadDrafts().then(
      (store) => (draftStore = store),
      (reason) => {
        loadingDraftStore = undefined;
        throw reason;
      },
    ));
  function saveDraft() {
    const revision = ++draftRevision,
      epoch = sessionRevision,
      principal = draftPrincipal;
    if (!principal || options.persistDrafts === false) return;
    const value = {
      text: draft.value,
      transactionHash: tx.value,
      newCaseFrom,
      pending,
      savedAt: Date.now(),
    };
    const store = (module: typeof draftStore) => {
      if (
        !active ||
        revision !== draftRevision ||
        epoch !== sessionRevision ||
        principal !== draftPrincipal
      )
        return;
      try {
        module!.save(draftKey(principal), value);
        draftNotice.textContent = "";
      } catch {
        failed();
      }
    };
    const failed = () => {
      if (active && revision === draftRevision && epoch === sessionRevision)
        draftNotice.textContent =
          "Couldn’t save your draft on this device.";
    };
    if (draftStore) store(draftStore);
    else void withDraftStore().then(store, failed);
  }
  function restoreDraft(principal: string) {
    if (options.persistDrafts === false) return;
    if (!draftStore) {
      void withDraftStore().then(
        () => {
          if (active && principal === draftPrincipal) {
            restoreDraft(principal);
            render();
            showPending();
          }
        },
        () => {},
      );
      return;
    }
    try {
      const value = draftStore.read(draftKey(principal));
      if (!value) return;
      // Whatever the visitor typed in this tab wins over a saved draft.
      if (!draft.value) {
        draft.value = value.text;
        newCaseFrom = value.newCaseFrom;
        if (value.transactionHash !== undefined)
          tx.value = value.transactionHash;
        if (cards) cards.typed();
        else if (tx.value) void withCards();
        if (draft.value)
          draftNotice.textContent = "Draft restored from this device.";
      }
      // An unconfirmed send comes back as its own message, beside any draft.
      const attempt = !pending && draftStore.pending(value.pending);
      if (attempt) {
        pending = attempt;
        newCaseFrom = attempt.newCaseFrom;
        sendState = "failed";
      }
      fitDraft();
    } catch {
      /* Storage is optional; the in-memory draft still works. */
    }
  }
  const warm = () => {
    withExtras();
    void withConsent().catch(showError);
  };
  draft.addEventListener("input", () => {
    saveDraft();
    showPending();
    fitDraft();
    setStarter();
  });
  const withCards = () =>
    (loadingCards ??= loadCard()
      .then((module) =>
        module.card({
          el,
          style,
          card,
          tx,
          txNote,
          policy: () => tailHost.policy,
          saveDraft,
          chain: client.chain,
          focus: () => draft.focus(),
        }),
      )
      .then(
        (loaded) => {
          cards = loaded;
          loaded.set(hostContext);
          setStarter();
        },
        // The next action that needs it loads it again.
        () => {
          loadingCards = undefined;
          showError(new Error(UNAVAILABLE));
        },
      ));
  /** One load at a time; a failed one is tried again by the next render.
   * What waited on it draws once it is here. */
  const withExtras = () =>
    (loadingExtras ??= loadExtras().then(
      (module) => {
        more = module.extras;
        more.identity(subtitle, client.session);
        more.starter(starter, options.intro);
        if (options.container) more.fullPage(style);
        render();
        if (active && !welcome.hidden) sessionChanged();
      },
      () => {
        loadingExtras = undefined;
      },
    ));
  const setContext = (next?: SupportContextInput) => {
    hostContext = next;
    // The page's context for the consent chunk.
    // The ops chunk reads the action name and the install check's values.
    tailHost.offered = next;
    cards?.state?.(client.captureState?.() ?? Promise.resolve(undefined));
    if (cards) cards.set(next);
    else if (next && !demoContainer) void withCards();
  };
  setContext(hostContext);
  attachToggle.addEventListener("click", () => {
    const open = attach.hidden;
    // The field shows once the card's module is ready to check it.
    void withCards().then(() => {
      if (cards) setAttachOpen(open);
      if (open) tx.focus();
    });
  });
  /** The page's callback can't stop the widget. */
  const notify = (count: number) => {
    try {
      options.onUnread?.(count);
    } catch {
      /* Ignored. */
    }
  };
  const showError = (reason: unknown) => {
    // The team raised its minimum: offer the wallet sign-in instead.
    if ((reason as { reason?: string })?.reason === "access-level-required") {
      minimumLevel = "signed";
      sessionChanged();
    }
    const text = widgetErrorMessage(reason);
    // Rewriting the same alert would announce it again.
    if (active && error.textContent !== text) error.textContent = text;
  };
  async function run(action: () => Promise<void>, signing = false) {
    if (busy || !active) return;
    busy = signIn.disabled = true;
    // The team's request to verify in the chat shows the wallet step too.
    if ((tailHost.signing = signing)) {
      signInLabel.textContent = "Check your wallet…";
      render();
    }
    showPending();
    error.textContent = "";
    try {
      await action();
    } catch (reason) {
      showError(reason);
    } finally {
      busy = signIn.disabled = tailHost.signing = false;
      signInLabel.textContent = "Verify wallet";
      showPending();
      if (active && (signing || newCaseFrom)) render();
    }
  }
  const timeFormat = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const button = (text: string, action: () => void) => {
    const node = el("button", text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  /** Builds the list from the pages, the unconfirmed send and the typing mark.
   * Nodes are kept by message, so a poll or a typing mark only adds or removes
   * what changed and earlier bubbles don't animate again. */
  function render(prepended = false) {
    const next = new Map<string, { node: HTMLElement; sig: string }>();
    const add = (
      key: string,
      sig: unknown[],
      fill: (node: HTMLElement) => void,
    ) => {
      if (next.has(key)) return;
      const entry = nodes.get(key) ?? { node: el("div"), sig: "" };
      const signature = JSON.stringify(sig);
      if (entry.sig !== signature) {
        entry.node.replaceChildren();
        fill(entry.node);
        entry.sig = signature;
      }
      next.set(key, entry);
    };
    const bubble = (
      node: HTMLElement,
      message: WidgetMessage,
      who: string,
      mine: boolean,
    ) => {
      node.className = `message${mine ? " own" : ""}`;
      if (mine && message.clientId) node.dataset.clientId = message.clientId;
      if (!mine) messageAuthors.set(node, message.author);
      const author = el("small", who);
      if (!mine && message.teamName && who === message.teamName)
        author.append(" ", el("span", "Team", "tag"));
      node.append(author);
      if (consent) consent.linkify(node, message.text);
      else node.append(message.text);
      const at = message.createdAt ? new Date(message.createdAt) : null;
      if (at && Number.isFinite(at.getTime())) {
        const time = el("time", timeFormat.format(at));
        time.dateTime = at.toISOString();
        node.append(time);
      }
    };
    const attempt = pending;
    const unsent = () =>
      attempt &&
      add(`c${attempt.id}`, [attempt.text, sendState, attempt.sent], (node) => {
        bubble(
          node,
          { author: client.session?.principalId ?? "", ...attempt, clientId: attempt.id, createdAt: new Date(sentAt(attempt.id)).toISOString() },
          "You",
          true,
        );
        const state = el(
          "span",
          undefined,
          sendState === "failed" ? "state failed" : "state",
        );
        if (sendState === "failed")
          state.append(
            el("span", attempt.sent ? "Details not shared." : "Not sent."),
            button("Retry", () => deliver(true)),
            button("Discard", discardPending),
          );
        else
          state.append(
            sendState === "sending"
              ? "Sending…"
              : `Sending again in ${sendState}s`,
          );
        node.append(state);
      });
    const joins = newCaseFrom ? [] : (consent?.join(joined, timeFormat) ?? []);
    (newCaseFrom ? [] : [...earlier, ...latest]).forEach((message, index) => {
      while (joins[0] && (message.createdAt ?? "") >= joins[0][1][0])
        add(...joins.shift()!);
      const mine = own(message.author);
      // A read that already holds a reply still waiting on its context.
      if (attempt && confirms(message, attempt)) return unsent();
      const assistant = authors?.[message.author]?.badges?.includes("bot");
      const who = mine
        ? "You"
        : assistant
          ? "AI agent"
          : message.teamName || options.label || "Team";
      // The visitor's own send keeps its node from pending to confirmed.
      add(
        mine && message.clientId
          ? `c${message.clientId}`
          : `#${message.id ?? `@${index}`}`,
        [message.text, message.createdAt, message.author, assistant, who, consent?.linksReady],
        (node) => {
          bubble(node, message, who, mine);
          node.toggleAttribute("data-assistant", !mine && !!assistant);
        },
      );
    });
    for (const line of joins) add(...line);
    unsent();
    // What happens next, under the newest message. Derived from the thread,
    // never stored or counted as messages; it comes with the extras.
    const shownThread = newCaseFrom ? null : conversation;
    if (!demoContainer && (attempt || shownThread)) {
      if (more)
        for (const line of more.tail(
          tailHost,
          latest,
          typing,
          info,
          authors,
          shownThread,
          verifyRequested,
          fresh,
          attempt ? sendState : undefined,
          waiting,
        ))
          add(...line);
      else withExtras();
    }
    const kept = new Set<Element>([...next.values()].map(({ node }) => node));
    for (const child of [...messages.children])
      if (!kept.has(child)) child.remove();
    [...next.values()].forEach(({ node }, index) => {
      if (messages.children[index] !== node)
        messages.insertBefore(node, messages.children[index] ?? null);
    });
    nodes = next;
    const digest = [...next].map(([key, entry]) => key + entry.sig).join();
    if (digest !== rendered) {
      const first = !rendered;
      rendered = digest;
      changedAt = Date.now();
      if (!prepended)
        body.scrollTop = demoContainer && first ? 0 : body.scrollHeight;
    }
    setStarter();
    tailHost.leadState?.(busy || !!pending, !!info?.handoff);
  }
  function display(data: WidgetMessages, prepend = false) {
    if (error.textContent === UNAVAILABLE) error.textContent = "";
    for (const line of data.joined ?? []) joined[line.at] = line;
    authors = { ...authors, ...data.authors };
    if (prepend) earlier = [...data.messages, ...earlier];
    else {
      // Messages the newest page moved past stay with the earlier ones, so
      // nothing loaded falls between them. A page that starts after
      // everything loaded may leave a gap: the loaded history then starts
      // again from this page, with its own cursor.
      if (earlier.length) {
        const loaded = [...earlier, ...latest];
        const first = data.messages[0]?.id;
        const at =
          first === undefined
            ? -1
            : loaded.findIndex((message) => message.id === first);
        earlier = at < 0 ? [] : loaded.slice(0, at);
      }
      latest = data.messages;
      typing = data.typing ?? null;
      info = data.conversation;
      fresh = false;
      // Poll sooner while the visitor waits for an answer to their latest
      // message, recomputed on every page so the wait ends after 5 minutes.
      const last = latest.at(-1);
      const age =
        last && own(last.author)
          ? Date.now() - Date.parse(last.createdAt ?? "")
          : NaN;
      awaitingReply = !!typing || age < 300000;
      waiting = !!info?.handoff || age < 86400000;
      // Replies newer than the last one the open panel showed light the
      // closed launcher once.
      const replies = latest
        .filter((message) => !own(message.author))
        .map((message) => Date.parse(message.createdAt ?? "") || 0);
      if (!panel.hidden) seen = Math.max(seen, ...replies);
      else if (!unread) {
        const count = replies.filter((time) => time > seen).length;
        if (count) {
          unread = true;
          launcher.dataset.unread = "";
          launcher.setAttribute("aria-label", `${label}, new reply`);
          notify(count);
        }
      }
      // The server already has the unconfirmed send: a lost response
      // settles here without a second request. A reply whose approved
      // context is still unshared waits for that alone.
      if (
        pending &&
        !pending.newCaseFrom &&
        latest.some((message) => confirms(message, pending!))
      ) {
        if (!pending.sent || !sharing(pending)) {
          cards?.confirmed?.(pending.context);
          pending = undefined;
          tailHost.messageSent = true;
          saveDraft();
          showPending();
        }
      }
    }
    if (prepend || !earlier.length) {
      before = data.nextBefore;
      older.hidden = !before;
    }
    render(prepend);
  }
  let pendingPolicy: ReturnType<NonNullable<WidgetClient["policy"]>> | undefined;
  function readPolicy() {
    return pendingPolicy ??= client.policy?.().then((policy) => {
      const saved = policy.appearance;
      if (active && saved) {
        appearance = typeof __TEMPL_WIDGET_BUILD__ === "undefined" && options.fixedAppearance
          ? { ...options.appearance, accent: saved.accent ?? options.appearance?.accent }
          : { ...options.appearance, ...saved };
        boundAppearance?.set({theme: "auto", accent: undefined, radius: "soft", position: "right", ...appearance});
        paintBranding();
        options.appearanceChanged?.(saved);
      }
      return policy;
    }).finally(() => { pendingPolicy = undefined; });
  }
  // A closed launcher needs only public branding. Opening chat still checks
  // today's access policy and creates or restores the visitor session.
  if (!demo && (!launcher.hidden || options.appearanceChanged))
    void readPolicy()?.catch(() => {});

  async function refreshNow(stale: () => boolean): Promise<void> {
    // The demo has no network; it renders even in a background tab. A
    // closed widget reads only while the visitor waits on the team.
    if (
      !active ||
      (panel.hidden && !waiting) ||
      (document.hidden && !demoContainer)
    )
      return;
    const extrasReady = withExtras();
    await goLive();
    // A reply link restores its identity before any guest is created.
    // Ordinary chats can read while the optional controls load.
    if (
      (options.guestLink ?? location.hash ?? "").startsWith("#templ-guest=")
    ) {
      await extrasReady;
      await more?.guest(tailHost);
    }
    // The policy and a returning guest's session load together. Without a
    // readable policy, the wallet sign-in stays in front.
    await Promise.all([
      minimumLevel === undefined &&
        readPolicy()?.then(
            (policy) => {
              // The team's own line, set in its widget settings, once
              // even when two reads overlap.
              if (policy.safetyLine && !tailHost.policy?.safetyLine)
                warning.append(" We never DM you first.");
              if (policy.verifiedDomain)
                loadDomain().then(
                  (module) => module.domain(titles, policy.verifiedDomain!),
                  () => {},
                );
              tailHost.policy = policy;
              attachToggle.hidden = tx.hidden && !policy.diagnostics;
              if (
                options.templLeadCapture &&
                policy.templLeadCapture &&
                !loadingLead
              )
                loadingLead = Promise.all([loadLead(), withConsent()]).then(
                  ([module]) => {
                    if (active) {
                      module.lead(tailHost, panel);
                      showPending();
                    }
                  },
                  () => {
                    loadingLead = undefined;
                    chunkFailed("lead", "landing");
                    showError(
                      new Error(LOAD_FAILED),
                    );
                  },
                );
              return policy.minimumLevel;
            },
            // Unread: the next refresh asks again, and the composer stays.
            () => undefined,
          )
          .then((level) => {
            minimumLevel = level;
            sessionChanged();
          }),
      !client.session &&
        !client.ended &&
        client.guest?.(true).catch((reason) => {
          // A team that now requires more: the policy decides what shows.
          if (
            (reason as { reason?: string })?.reason !== "access-level-required"
          )
            throw reason;
        }),
    ]);
    if (stale()) return;
    // A wallet sign-in ran out: no reads and no guest until they sign in.
    if (client.ended) return sessionChanged();
    const session = client.session;
    if (!session) {
      noThreadYet = minimumLevel !== "signed";
      restoring = false;
      sessionChanged();
      return;
    }
    let thread = conversation;
    if (!thread && !hintTried) {
      hintTried = true;
      thread = session.thread ?? null;

    }
    if (!thread) {
      const status = await client.status();
      if (stale()) return;
      conversation = thread = status.mine;
      if (!status.available || (!status.canAsk && !thread)) {
        throw new Error(NOT_TAKING);
      }
    }
    if (!thread) {
      noThreadYet = true;
      restoring = false;
      setStarter();
      return;
    }
    const guest = !!session.level && session.level !== "signed";
    let page: WidgetMessages;
    try {
      // An open chat in a visible tab tells the team the member saw it.
      page = await client.messages(thread, undefined, !panel.hidden);
    } catch (reason) {
      // A remembered thread this visitor can no longer read: ask for status.
      if (
        conversation ||
        !/^40[34]$/.test(String((reason as { status?: number }).status))
      )
        throw reason;
      return refreshNow(stale);
    }
    if (stale()) return;
    conversation = thread;
    restoring = false;
    formerMembers = page.conversation?.formerMembers ?? [];
    // The team's request to verify shows in the chat, under the thread.
    const asked = page.workflow?.verificationRequested;
    if (guest && asked !== undefined) verifyRequested = !!asked;
    display(page);

  }
  /** A read after a write starts at once; an older read still in flight is
   * then dropped when it lands, results and errors alike. */
  function refresh(afterWrite = false): Promise<void> {
    if (busy && !afterWrite) return Promise.resolve();
    if (refreshing && !afterWrite) return refreshing;
    const mine = ++sequence;
    const stale = () => mine !== sequence || !active;
    const run: Promise<void> = refreshNow(stale)
      .catch((reason) => {
        if (stale()) return;
        restoring = false;
        typing = null;
        render();
        throw reason;
      })
      .finally(() => {
        if (refreshing === run) refreshing = undefined;
      });
    return (refreshing = run);
  }
  /** About 1 and 2 s after a send, every 3 s while a reply is due, 10 s when
   * idle and 30 s after two quiet minutes. Failures back off to a minute. */
  function schedule() {
    clearTimeout(poll);
    const closed = panel.hidden;
    if (
      !active ||
      demoContainer ||
      (closed && (!waiting || unread || !conversation))
    )
      return;
    poll = setTimeout(
      () => {
        if (busy) return schedule();
        void refresh()
          .then(
            () => {
              failures = 0;
            },
            (reason) => {
              failures++;
              showError(reason);
            },
          )
          .finally(schedule);
      },
      failures
        ? Math.min(60000, 3000 * 2 ** failures)
        : closed
          ? 30000
          : quick
            ? (quick--, 1000)
            : awaitingReply
              ? 3000
              : Date.now() - changedAt > 120000
                ? 30000
                : 10000,
    );
  }
  const sessionChanged = () => {
    sessionRevision++;
    cards?.state?.(client.captureState?.() ?? Promise.resolve(undefined));
    const signed = client.session;
    // A wallet sign-in ran out: the thread and the draft stay while the
    // member signs in again.
    const renew = !signed && !!client.ended;
    const guest = !!signed?.level && signed.level !== "signed";
    if (draftPrincipal !== signed?.principalId && !renew) {
      saveDraft();
      tailHost.messageSent = false;
      // A visitor's first session keeps what they already typed or sent.
      const carried = !draftPrincipal && (!!draft.value || !!pending);
      if (draftPrincipal) {
        sequence++;
        pending = undefined;
        newCaseFrom = undefined;
        draft.value = "";
        draftNotice.textContent = "";
        tx.value = "";
        setContext(hostContext);
      }
      // A new guest has no thread yet; a wallet may already have one.
      if (draftPrincipal || signed?.level === "signed") noThreadYet = false;
      draftPrincipal = signed?.principalId;
      conversation = before = null;
      verifyRequested = hintTried = false;
      latest = earlier = [];
      authors = {};
      joined = {};
      typing = null;
      older.hidden = true;
      if (draftPrincipal) {
        restoreDraft(draftPrincipal);
        // What they wrote before it is saved under it at once, so a send
        // that then fails can still be retried after a reload.
        if (carried) saveDraft();
      }
      render();
    }
    showPending();
    const focused = root.activeElement;
    // At the connected minimum a page wallet is the visitor's claim, so
    // they write at once; without one they sign in or use the fallback.
    form.hidden =
      !!demo?.readOnly ||
      (!signed &&
        !renew &&
        (minimumLevel === "signed" ||
          (minimumLevel === "connected" && !client.hasWallet)));
    // The welcome and Sign in again words come with the extras.
    welcome.hidden = !!demo?.readOnly || (!form.hidden && !renew);
    if (!welcome.hidden) {
      if (more) more.welcome(tailHost, renew);
      else withExtras();
    }
    // Keep focus on whichever of the two controls is still on screen.
    if (
      (focused === draft || focused === signIn) &&
      focused.closest("[hidden]")
    )
      (form.hidden ? signIn : draft).focus();
    more?.identity(subtitle, client.session);
    // A guest signs in from the chat when the team asks, or here before
    // their first message; a guest's claimed wallet is not shown as theirs.
    signOut.textContent = signed && !guest ? "Sign out" : "Verify wallet";
    if (!signed && !renew) {
      conversation = null;
      if (form.hidden) setAttachOpen(false);
    }
    setStarter();
  };
  const unsubscribe = client.onSessionChange(sessionChanged);
  sessionChanged();
  // See loadLive. The chunk loads at once for a returning
  // guest or a page with a wallet (a remembered sign-in needs one), and
  // otherwise when the chat opens. `pulse()` says whether the panel is open
  // or the visitor waits; `pulse(1)` marks the visitor waiting and reads now.
  let booting: Promise<unknown> | null | undefined;
  const goLive = () =>
    demoContainer
      ? Promise.resolve()
      : (booting ||= loadLive()
          .then((module) => {
            return module.live(
              client as SupportClient,
              (wake?: number) =>
                wake
                  ? ((waiting = true), refresh().catch(showError), schedule())
                  : !panel.hidden || waiting,
              form,
            );
          })
          .catch((error) => {
            booting = null;
            throw error;
          }));
  if (returning || client.hasWallet) void goLive().catch(showError);
  // The welcome block, the tools row and the team's request to verify all
  // sign in here. A guest's sign-in keeps its thread.
  const walletSignIn = () =>
    void run(async () => {
      await client.signIn();
      verifyRequested = false;
      await refresh(true);
      draft.focus();
    }, true);
  signIn.addEventListener("click", walletSignIn);
  signOut.addEventListener("click", () =>
    client.session?.level != "signed"
      ? walletSignIn()
      : void run(async () => {
          await client.signOut();
        }),
  );
  /** Sends the unconfirmed message. A retry reuses its ID, text and context,
   * so the server takes it once. */
  function deliver(fromClick = false) {
    const attempt = pending;
    if (!attempt) return;
    void run(async () => {
      for (let maySignIn = fromClick; ; maySignIn = false) {
        // A wallet change while waiting took this message with its session.
        if (pending !== attempt || !active) return;
        sendState = "sending";
        render();
        showPending();
        try {
          if (navigator.onLine === false)
            throw new Error(
              "You're offline. It will send when you're back online.",
            );
          // Only a Send or Retry click can request a wallet signature.
          if (client.ended) {
            if (!maySignIn) throw new Error(SIGN_IN_AGAIN);
            await client.signIn();
          } else if (attempt.wallet || !client.session) {
            await client.guest?.(
              false,
              !!attempt.wallet,
              undefined,
              false,
              attempt.wallet,
            );
            attempt.wallet = undefined;
          }
          // A new guest in place of the visitor who wrote it drops it too.
          if (pending !== attempt) return;
          const sendingPrincipal = client.session?.principalId;
          let message: WidgetMessage | undefined;
          let sent: Awaited<ReturnType<WidgetClient["ask"]>> | undefined;
          if (attempt.target) {
            const shared = sharing(attempt);
            if (attempt.sent) {
              if (shared) await client.context(attempt.target, shared);
            } else
              message = (
                await client.reply(
                  attempt.target,
                  attempt.text,
                  attempt.id,
                  shared,
                )
              ).message;
          } else
            sent = await client.ask(
              attempt.text,
              attempt.context,
              attempt.id,
              undefined,
              attempt.newCaseFrom,
            );
          if (
            !active ||
            pending !== attempt ||
            client.session?.principalId !== sendingPrincipal
          )
            return;
          if (sent) {
            if (attempt.newCaseFrom) {
              sequence++;
              earlier = latest = [];
              before = null;
              authors = joined = {};
              older.hidden = true;
              newCaseFrom = undefined;
            }
            info = sent.conversation;
            conversation = sent.conversation.id;
            message = sent.message;
            if (message && sendingPrincipal)
              for (const notify of tailHost.firstMessageListeners ?? []) notify(conversation, sendingPrincipal);
          }
          cards?.confirmed?.(attempt.context);
          pending = undefined;
          // The server's copy confirms the bubble with its time. The demo
          // returns none; its next read replaces this one.
          if (
            !latest.some(
              (item) =>
                confirms(item, attempt) ||
                (!!message?.id && item.id === message.id),
            )
          )
            latest = [
              ...latest,
              message
                ? { ...message, clientId: attempt.id }
                : {
                    author: client.session?.principalId ?? "",
                    text: attempt.text,
                    clientId: attempt.id,
                  },
            ];
          awaitingReply = waiting = fresh = true;
          noThreadYet = false;
          tailHost.messageSent = true;
          quick = 2;
          if (demoContainer) suggestions.hidden = true;
          saveDraft();
          render();
          void refresh(true).catch(showError);
          schedule();
          draft.focus();
          return;
        } catch (reason) {
          // A read already showed it arrived.
          if (pending !== attempt) return;
          const {
            status,
            reason: code,
            retryAfter = 0,
          } = reason as {
            status?: number;
            reason?: string;
            retryAfter?: number;
          };
          // Nothing was stored. A phrase leaves no copy on this device; a
          // hash the service can't read goes back to the visitor.
          if (
            code == "secret-refused" ||
            code == "invalid-transaction" ||
            code == "encrypted-route"
          ) {
            if (code == "encrypted-route") cards?.cancelled?.(attempt.context);
            pending = undefined;
            if (code[0] == "s") {
              draft.value = tx.value = "";
              setContext(hostContext);
            } else {
              draft.value ||= attempt.text;
              if (code == "invalid-transaction") {
                setAttachOpen(true);
                tx.focus();
              }
            }
            saveDraft();
            render();
            throw reason;
          }
          // A pacing or busy answer names its wait. Retry while it is a
          // minute or less, up to 15 minutes after the message was written.
          if (
            !(status == 429 || status == 503) ||
            !(retryAfter > 0 && retryAfter <= 60) ||
            Date.now() + retryAfter * 1000 > sentAt(attempt.id) + 900000
          ) {
            sendState = "failed";
            render();
            throw reason;
          }
          for (let left = Math.ceil(retryAfter); left > 0 && active; left--) {
            sendState = left;
            render();
            await pause(1000);
          }
        }
      }
    });
  }
  function discardPending() {
    if (busy || !pending) return;
    cards?.cancelled?.(pending.context);
    pending = undefined;
    error.textContent = "";
    saveDraft();
    render();
    showPending();
    draft.focus();
  }
  function queueMessage(text: string, wallet?: Selected) {
    if (!active || pending || busy) return;
    pending = {
      id: requestId(),
      text,
      target: newCaseFrom ? null : conversation,
      ...(newCaseFrom ? { newCaseFrom } : {}),
      context: cards?.ticked(),
      wallet,
    };
    formController?.close();
    if (!cards?.mine()) tx.value = "";
    draft.value = "";
    fitDraft();
    setAttachOpen(false);
    saveDraft();
    deliver(true);
  }
  function submitMessage() {
    const text = draft.value.trim();
    if (!text || busy || pending || !active) return;
    // A typed hash waits for the card's module, which checks it. One Templ
    // can't read is never sent; the visitor fixes or clears it.
    if (tx.value.trim() && !cards)
      return void withCards().then(() => cards && submitMessage());
    if (txNote.textContent) return tx.focus();
    const sendMessage = (wallet?: Selected) => {
      queueMessage(text, wallet);
    };
    if (demoContainer) sendMessage();
    else {
      // Give feedback while the consent code or current policy loads. The
      // review still decides whether the draft may enter the send queue.
      send.setAttribute("aria-busy", "true");
      void Promise.all([
        withConsent(),
        minimumLevel === undefined && refreshing,
      ])
        .then(() => consent!.send(text, sendMessage))
        .catch(showError)
        .finally(showPending);
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitMessage();
  });
  let composing = false;
  draft.addEventListener("compositionstart", () => {
    composing = true;
  });
  draft.addEventListener("compositionend", () => {
    composing = false;
  });
  draft.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      composing ||
      event.keyCode === 229 ||
      event.repeat
    )
      return;
    event.preventDefault();
    if (!busy && !pending && active && !form.hidden && draft.value.trim())
      form.requestSubmit(send);
  });
  older.addEventListener("click", () => {
    if (conversation && before)
      void run(async () =>
        display(await client.messages(conversation!, before!), true),
      );
  });
  let openingTrigger: HTMLElement | null = null;
  const open = (focus = true) => {
    const focused = root.activeElement ?? document.activeElement;
    const element = focused instanceof HTMLElement ? focused : null;
    if (panel.hidden || (element && !panel.contains(element)))
      openingTrigger = element === document.body ? null : element;
    panel.hidden = false;
    void withConsent().catch(showError);
    launcher.setAttribute("aria-expanded", "true");
    unread = false;
    delete launcher.dataset.unread;
    launcher.removeAttribute("aria-label");
    notify(0);
    if (focus) (form.hidden ? signIn : draft).focus();
    schedule();
    // The landing keeps its loading view until history and the initial
    // conversation layout have settled. Other hosts can ignore the promise.
    return Promise.all([styleReady, withExtras(), refresh().catch(showError)])
      .then(() => more?.ready());
  };
  const shut = () => {
    if (demoContainer || (options.container && !options.onClose)) return;
    panel.hidden = true;
    options.onClose?.();
    launcher.setAttribute("aria-expanded", "false");
    // Reads continue slowly while the visitor waits on the team.
    schedule();
    if (openingTrigger?.isConnected) openingTrigger.focus();
    else if (!launcher.hidden) launcher.focus();
    openingTrigger = null;
  };
  const onVisible = () => {
    if (!document.hidden && !panel.hidden) void refresh().catch(showError);
  };
  document.addEventListener("visibilitychange", onVisible);
  // A message that failed while offline sends when the browser is back.
  const online = () => {
    if (
      pending &&
      sendState == "failed" &&
      !busy &&
      Date.now() < sentAt(pending.id) + 900000
    )
      deliver();
  };
  window.addEventListener("online", online);
  launcher.addEventListener("click", () => (panel.hidden ? open() : shut()));
  close.addEventListener("click", shut);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") shut();
  });
  const api = {
    // The host reports an action outcome after consent.
    // Calls without the member's case consent record nothing.
    reportOutcome: (value: import("./support-widget-ops").Outcome) =>
      withConsent().then(() => consent?.outcome(value)),
    open,
    async openForm(input: SupportForm) {
      const revision = ++formRevision;
      open(false);
      await refresh();
      const formsKit = await loadLead();
      if (!active || revision !== formRevision) return;
      formController ??= formsKit.forms(
        tailHost,
        body,
        async (text, current) => {
          if (busy || pending)
            throw new Error("Message is still sending.");
          if (form.hidden)
            throw new Error("Verify your wallet first.");
          await withConsent();
          if (!active || !current()) return;
          await consent!.review(text, (wallet) => {
            if (current()) queueMessage(text, wallet);
          });
        },
      );
      formController.open(input);
    },
    setQuestion(text: string) {
      if (busy || pending || typeof text !== "string" || text.length > 2000)
        return;
      draft.value = text;
      fitDraft();
      setStarter();
      saveDraft();
    },
    close: shut,
    setAppearance(next: Partial<SupportWidgetAppearance>) {
      appearance = { ...appearance, ...next };
      boundAppearance?.set(appearance);
      paintBranding();
    },
    setContext,
    /** Clears unsent failure choices without changing the chat or its session. */
    clearCapturedFailures() {
      captureRevision++;
      cards?.clearCapturedFailures?.();
    },
    /** Freezes a failure with the page's typed app details. The network
     * and transactions come from the failure itself or the wallet at that
     * moment only. */
    captureFailure(
      input: SupportContextInput,
      reported?: SupportFailureCapture,
    ) {
      const revision = captureRevision;
      const capture = {
        input: structuredClone({
          ...input,
          app: { ...hostContext?.app, ...input.app },
        }),
        capturedAt: reported ? reported.capturedAt : new Date().toISOString(),
        state: reported
          ? Promise.resolve(undefined)
          : (client.captureState?.() ?? Promise.resolve(undefined)),
        ...(reported ? { reported: structuredClone(reported) } : {}),
        sdk: { widget: WIDGET_BUILD, api: SUPPORT_WIDGET_API_VERSION },
      };
      return withCards().then(() => {
        if (revision !== captureRevision) return;
        if (!active || !cards?.capture) throw new Error(UNAVAILABLE);
        return cards.capture(capture);
      });
    },
    /** The page's wallet was connected, switched or dropped. */
    setWallet: (next: SupportWallet | null) => client.setWallet?.(next),
    destroy() {
      lifetime.abort();
      saveDraft();
      active = false;
      formRevision++;
      formController?.close();
      cards?.destroy?.();
      boundAppearance?.destroy();
      branding?.destroy();
      clearTimeout(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", online);
      unsubscribe();
      client.destroy();
      host.remove();
    },
  };
  // The public calls the install check wraps.
  // The check restores each call when it ends.
  tailHost.api = api;
  return api;
}
