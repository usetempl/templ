// Types for Templ's support widget, https://usetempl.com/support-widget.js
// (https://templ.vip/support-widget.js on staging).
//
// Save this file next to your code and list it in your tsconfig "include"
// (or add `/// <reference path="./support-widget.d.ts" />`). It types the
// widget's URL on both hosts, so a dynamic import needs no local package:
//
//   const { mountSupportWidget } = await import(
//     /* webpackIgnore: true */ /* @vite-ignore */
//     "https://usetempl.com/support-widget.js"
//   );
//
// The same types cover a versioned build, https://usetempl.com/support-widget/<id>.js.

declare namespace TemplSupport {
  /** An EIP-1193 provider (window.ethereum, a wagmi connector's provider).
   * The widget calls only eth_accounts, eth_chainId, eth_requestAccounts
   * (from a Sign in click) and personal_sign for the sign-in message. */
  type SupportWalletProvider = {
    request(input: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: "accountsChanged" | "chainChanged", handler: () => void): void;
    removeListener?(
      event: "accountsChanged" | "chainChanged",
      handler: () => void,
    ): void;
  };
  /** A Wallet Standard wallet with solana:signMessage, or a wallet-adapter
   * style signer (useWallet(), an adapter or window.phantom.solana). The
   * widget reads its account, connects only from a Sign in click and signs
   * only the sign-in message. */
  type SupportSolanaWallet =
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
  /** The one wallet the visitor uses on your page, under its family key. */
  type SupportWallet =
    | { evm: SupportWalletProvider; solana?: never }
    | { solana: SupportSolanaWallet; evm?: never };
  /** The app's wallet and time when an action fails. This grants no access. */
  type SupportFailureCapture = {
    capturedAt: string;
    wallet:
      | { network: "evm"; address: `0x${string}`; chainId: number }
      | { network: "solana"; address: string }
      | null;
  };
  /** Details the visitor may share with the team, one row each. Nothing is
   * sent until the visitor ticks a row. */
  type SupportContextInput = {
    description?: string;
    /** "eip155:8453", "solana", or a known name such as "Base". */
    network?: string;
    chainId?: number;
    /** One hash or explorer link. */
    transactionHash?: string;
    /** Up to five hashes or Solana signatures. */
    transactions?: { hash: string; network?: string; chainId?: number }[];
    /** Typed details from your app, one row each. */
    app?: SupportAppContextInput;
  };
  /** What the visitor was doing in your app. Each field is checked on its
   * own; one Templ can't read is left out with a console warning. */
  type SupportAppContextInput = {
    /** "/" and a path, with no query or fragment; at most 200 characters. */
    page?: string;
    action?:
      | "deposit"
      | "withdraw"
      | "claim"
      | "migrate"
      | "swap"
      | "stake"
      | "unstake"
      | "approve"
      | "bridge"
      | "other";
    /** A vault, pool or market: a label, or an address with its network. */
    product?: {
      label?: string;
      address?: string;
      network?: string | number;
      key?: string;
    };
    /** The value your app showed, such as "4.2%", with what it measures. */
    shown?: {
      value: string;
      metric?: { key?: string; label?: string };
      /** The time the value covers, such as "7 days". */
      period?: string;
      /** When your app showed it, ISO 8601. */
      asOf?: string;
    };
    error?: { code?: string; message?: string };
    /** The wallet app, such as "MetaMask". */
    connector?: string;
    appVersion?: string;
    /** Such as "Chrome 129 on macOS". */
    device?: string;
    /** Optional diagnostics. Each is a separate choice on a flagged workspace. */
    browser?: string;
    operatingSystem?: string;
    viewport?: { width: number; height: number };
    screen?: { width: number; height: number };
    language?: string;
    timeZone?: string;
    connection?: {
      online: boolean;
      effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
      saveData?: boolean;
    };
    /** The failure before or after broadcast. Amount is a decimal string, at most 40 characters. */
    failure?: {
      kind: "rejected" | "simulation" | "submission" | "broadcast" | "other";
      at?: string;
      asset?: { symbol?: string; address?: string; network?: string | number };
      amount?: string;
    };
  };
  type SupportWidgetAppearance = {
    /** Auto follows the host page, then the visitor's system setting. Defaults to Auto. */
    theme?: "dark" | "light" | "auto";
    /** One six-digit hex color, or a color for each theme. Invalid colors use the default. */
    accent?: string | { light: string; dark: string };
    /** Panel and control corners. Defaults to soft. */
    radius?: "square" | "soft" | "round";
    /** Use square action buttons with a two-pixel outline. */
    outlinedButtons?: boolean;
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
  type SupportWidgetOptions = {
    /** The workspace ID from Templ. */
    workspace: string;
    /** Requires the workspace's chat-first server flag. Default off. */
    chatFirst?: boolean;
    /** Mount the real chat across a page container. */
    container?: HTMLElement;
    /** The page's wallet. Leave it out on a page without one, and visitors
     * can still write as guests. Call setWallet() when it changes. */
    wallet?: SupportWallet | null;
    /** The same as wallet: { evm: provider }. Pass one or the other. */
    provider?: SupportWalletProvider;
    apiUrl?: string;
    label?: string;
    context?: SupportContextInput;
    /** Your CSP nonce for the widget's style element. */
    styleNonce?: string;
    persistDrafts?: boolean;
    /** Hide the floating launcher when your app has its own support button. */
    showLauncher?: boolean;
    /** Fix this embed to one theme and hide its visitor theme switch. */
    lockedTheme?: "light" | "dark";
    appearance?: SupportWidgetAppearance;
    /** Up to four common questions, each at most 80 characters. */
    prompts?: string[];
    /** The empty chat's title (up to 80 characters) and one line (up to 200). */
    intro?: { title: string; text?: string };
    /** Offer "Add a transaction hash". Defaults to true. */
    transactionField?: boolean;
    /** Team replies the visitor hasn't seen while the widget is closed, and 0
     * when it opens. */
    onUnread?: (count: number) => void;
  };
  /** The mounted widget. */
  type SupportWidget = {
    /** The form stays inside the chat. Its answers are shared on Send. */
    openForm(form: {
      title: string;
      text?: string;
      message?: string;
      fields: {
        id: string;
        label: string;
        type?: "text" | "email" | "website";
        required?: boolean;
        value?: string;
      }[];
    }): Promise<void>;
    /** Reports an app outcome only after the member allowed it for this case.
     * Does not resolve the case or trigger a wallet action. */
    reportOutcome(value: {
      action:
        | "deposit"
        | "withdraw"
        | "swap"
        | "bridge"
        | "stake"
        | "claim"
        | "other";
      status: "completed" | "failed";
    }): Promise<void>;
    /** Opens the chat. `focus` moves focus into it (default true). */
    open(focus?: boolean): void;
    /** Puts a question in the message box without sending it. Does nothing
     * while a message is sending or when the text is over 2,000 characters. */
    setQuestion(text: string): void;
    close(): void;
    /** Updates appearance now. Omitted options keep their value. No request or wallet action runs. */
    setAppearance(partial: Partial<SupportWidgetAppearance>): void;
    /** Replaces the details the visitor may share. */
    setContext(next?: SupportContextInput): void;
    /** Clears unsent failure choices. Keeps the chat, draft and details already being sent. */
    clearCapturedFailures(): void;
    /** Freezes the failure, wallet and network now. The widget adds its own build and API version.
     * Up to three snapshots stay on this page. Each row starts selected.
     * The user can remove any detail before Send.
     * Pass a saved app-reported wallet and time after a delayed load.
     * The saved wallet stays unverified. */
    captureFailure(
      input: SupportContextInput,
      capture?: SupportFailureCapture,
    ): Promise<void>;
    /** The page's wallet was connected, switched or dropped. */
    setWallet(next: SupportWallet | null): void;
    /** Removes the widget and ends its session. */
    destroy(): void;
  };
  /** Access a workspace allows: anyone, a connected wallet, or a signed one. */
  type SupportAccessLevel = "anonymous" | "connected" | "signed";
  /** The headless client, for a support screen you build yourself. */
  type SupportClient = {
    readonly session:
      | {
          address: string;
          principalId: string;
          expiresAt: number;
          level: SupportAccessLevel;
          thread?: string;
        }
      | undefined;
    readonly ended: boolean;
    readonly hasWallet: boolean;
    policy(): Promise<{
      minimumLevel: "anyone" | "connected" | "signed";
      walletFallback?: boolean;
      askPerson?: boolean;
      replyEmail?: boolean;
      safetyLine?: boolean;
      /** Saved workspace display settings; disabled notice text is omitted. */
      appearance?: SupportWidgetAppearance;
      /** The domain this website proved with a DNS record, when it did. */
      verifiedDomain?: string;
      /** Members may add screenshots to their requests. */
      screenshots?: boolean;
    }>;
    guest(
      resumeOnly?: boolean,
      renew?: boolean,
      check?: string,
      walletUnavailable?: boolean,
      /** The exact wallet the user approved sharing, without a wallet proof. */
      consentedWallet?: {
        address: string;
        chainId?: number;
        network?: "solana";
      },
    ): Promise<unknown>;
    /** The wallet the page's provider reports, read without a signature. */
    reportedWallet(): Promise<
      { address: string; chainId?: number; network?: "solana" } | undefined
    >;
    signIn(): Promise<unknown>;
    signOut(): Promise<void>;
    status(): Promise<unknown>;
    ask(
      text: string,
      context?: SupportContextInput,
      clientId?: string,
    ): Promise<{ conversation: { id: string } }>;
    /** `seen` marks the newest page as read by the member. */
    messages(id: string, before?: string, seen?: boolean): Promise<unknown>;
    reply(
      id: string,
      text: string,
      clientId?: string,
      context?: SupportContextInput,
    ): Promise<{ conversation: { id: string } }>;
    context(id: string, context: SupportContextInput): Promise<unknown>;
    confirm(id: string, solved: boolean): Promise<{ reopened?: boolean }>;
    /** With no thread yet, creates the member's thread with a person handoff. */
    askPerson(id?: string): Promise<{
      handoff?: { at: string; by?: string };
      conversation?: { id: string };
    }>;
    onSessionChange(listener: () => void): () => void;
    setWallet(next: SupportWallet | null): void;
    destroy(): void;
  };
  interface WidgetModule {
    mountSupportWidget(options: SupportWidgetOptions): SupportWidget;
    createSupportClient(
      options: SupportWidgetOptions,
      runtime?: {
        fetch?: typeof fetch;
        origin?: string;
        load?: (path: string) => Promise<unknown>;
      },
    ): SupportClient;
  }
}

declare module "https://templ.vip/support-widget.js" {
  export type SupportWalletProvider = TemplSupport.SupportWalletProvider;
  export type SupportSolanaWallet = TemplSupport.SupportSolanaWallet;
  export type SupportWallet = TemplSupport.SupportWallet;
  export type SupportContextInput = TemplSupport.SupportContextInput;
  export type SupportFailureCapture = TemplSupport.SupportFailureCapture;
  export type SupportAppContextInput = TemplSupport.SupportAppContextInput;
  export type SupportWidgetAppearance = TemplSupport.SupportWidgetAppearance;
  export type SupportWidgetOptions = TemplSupport.SupportWidgetOptions;
  export type SupportWidget = TemplSupport.SupportWidget;
  export type SupportClient = TemplSupport.SupportClient;
  export const mountSupportWidget: TemplSupport.WidgetModule["mountSupportWidget"];
  export const createSupportClient: TemplSupport.WidgetModule["createSupportClient"];
}

declare module "https://templ.vip/support-widget/*" {
  export type SupportFailureCapture = TemplSupport.SupportFailureCapture;
  export type SupportWidgetOptions = TemplSupport.SupportWidgetOptions;
  export type SupportWidget = TemplSupport.SupportWidget;
  export type SupportClient = TemplSupport.SupportClient;
  export const mountSupportWidget: TemplSupport.WidgetModule["mountSupportWidget"];
  export const createSupportClient: TemplSupport.WidgetModule["createSupportClient"];
}

declare module "https://usetempl.com/support-widget.js" {
  export type SupportWalletProvider = TemplSupport.SupportWalletProvider;
  export type SupportSolanaWallet = TemplSupport.SupportSolanaWallet;
  export type SupportWallet = TemplSupport.SupportWallet;
  export type SupportContextInput = TemplSupport.SupportContextInput;
  export type SupportFailureCapture = TemplSupport.SupportFailureCapture;
  export type SupportAppContextInput = TemplSupport.SupportAppContextInput;
  export type SupportWidgetAppearance = TemplSupport.SupportWidgetAppearance;
  export type SupportWidgetOptions = TemplSupport.SupportWidgetOptions;
  export type SupportWidget = TemplSupport.SupportWidget;
  export type SupportClient = TemplSupport.SupportClient;
  export const mountSupportWidget: TemplSupport.WidgetModule["mountSupportWidget"];
  export const createSupportClient: TemplSupport.WidgetModule["createSupportClient"];
}

declare module "https://usetempl.com/support-widget/*" {
  export type SupportFailureCapture = TemplSupport.SupportFailureCapture;
  export type SupportWidgetOptions = TemplSupport.SupportWidgetOptions;
  export type SupportWidget = TemplSupport.SupportWidget;
  export type SupportClient = TemplSupport.SupportClient;
  export const mountSupportWidget: TemplSupport.WidgetModule["mountSupportWidget"];
  export const createSupportClient: TemplSupport.WidgetModule["createSupportClient"];
}
