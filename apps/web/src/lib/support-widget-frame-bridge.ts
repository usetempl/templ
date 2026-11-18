/** Frame mode's `framebridge` chunk: the page's side
 * of the frame's wallet, loaded by the frame host for a page that passed a
 * wallet. It reads what the wallet shows without a prompt, follows its
 * changes, and answers every wallet call the frame asks for. It passes on
 * passive account reads, a connect prompt
 * at most every 10 seconds, and one kind of signature: Templ's sign-in
 * message for this page's domain and origin, this workspace, and the account
 * and network the page's wallet reports right now, one at a time and at
 * most three a minute. Anything else is refused and the wallet is never
 * called. */
import {
  checkFrameSignIn,
  WIDGET_FRAME_SIGNS_PER_MINUTE,
  WIDGET_FRAME_SIGN_IN_BYTES,
} from "@templ/chat/widget-frame";
import { widgetSignInResource } from "@templ/chat/widget-wallet";
import type {
  SupportSolanaWallet,
  SupportWallet,
  SupportWalletProvider,
} from "./support-widget";
import { solanaAddress } from "./support-widget-frame-wallet";

type StandardSolana = {
  accounts: readonly { address: string; chains?: readonly string[] }[];
  features: {
    "standard:connect"?: { connect?(): Promise<unknown> };
    "solana:signMessage"?: {
      signMessage?(input: {
        account: { address: string };
        message: Uint8Array;
      }): Promise<
        readonly { signedMessage?: Uint8Array; signature?: Uint8Array }[]
      >;
    };
  };
};
type AdapterSolana = {
  publicKey: { toBase58(): string } | null;
  signMessage?(
    message: Uint8Array,
  ): Promise<Uint8Array | { signature: Uint8Array }>;
  connect?(): Promise<unknown>;
};

/** The error every refused call answers with. */
export const REFUSED = "unavailable";
const refused = () => new Error(REFUSED);

const utf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refused();
  }
};

/** @public Lazy chunk entry: the frame host loads it through a dynamic
 * import, which the dead-code check cannot follow. Returns, for one mount,
 * the wallet's state, a watch of its changes and the call handler. */
export function bridge(input: {
  wallet: () => SupportWallet | null;
  workspace: string;
  /** Templ's app origin, which the sign-in's one resource names. */
  appOrigin: string;
}) {
  const signs: number[] = [];
  let signing = false,
    connectAt = 0;
  const expectation = (address: string, chainId?: number) => ({
    host: location.host,
    origin: location.origin,
    hosted:
      location.origin === input.appOrigin &&
      location.pathname === `/help/${input.workspace}`,
    address,
    chainId,
    resource: widgetSignInResource(input.appOrigin, input.workspace),
    now: Date.now(),
  });
  /** One sign-in at a time, and at most three a minute. */
  async function signOnce<T>(run: () => Promise<T>): Promise<T> {
    const now = Date.now();
    while (signs.length && signs[0] <= now - 60_000) signs.shift();
    if (signing || signs.length >= WIDGET_FRAME_SIGNS_PER_MINUTE)
      throw refused();
    signing = true;
    signs.push(now);
    try {
      return await run();
    } finally {
      signing = false;
    }
  }
  function connectOnce() {
    const now = Date.now();
    if (now - connectAt < 10_000) throw refused();
    connectAt = now;
  }
  async function evm(
    provider: SupportWalletProvider,
    method: string,
    params: unknown[],
  ) {
    if (method === "eth_accounts" || method === "eth_chainId") {
      if (params.length) throw refused();
      return provider.request({ method, params: [] });
    }
    if (method === "eth_requestAccounts" && !params.length) {
      connectOnce();
      return provider.request({ method, params: [] });
    }
    const [hex, address] = params;
    if (
      method !== "personal_sign" ||
      params.length != 2 ||
      typeof hex != "string" ||
      typeof address != "string" ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(hex) ||
      hex.length > 2 + WIDGET_FRAME_SIGN_IN_BYTES * 2
    )
      throw refused();
    const text = utf8(
      Uint8Array.from(hex.slice(2).match(/../g)!, (byte) =>
        Number.parseInt(byte, 16),
      ),
    );
    return signOnce(async () => {
      const [accounts, chain] = await Promise.all([
        provider.request({ method: "eth_accounts" }),
        provider.request({ method: "eth_chainId" }),
      ]);
      const current = Array.isArray(accounts) ? accounts[0] : undefined;
      if (
        typeof current != "string" ||
        typeof chain != "string" ||
        current.toLowerCase() !== address.toLowerCase() ||
        !checkFrameSignIn(
          "evm",
          text,
          expectation(current, Number.parseInt(chain, 16)),
        )
      )
        throw refused();
      return provider.request({ method, params: [hex, address] });
    });
  }
  async function solana(
    wallet: SupportSolanaWallet,
    method: string,
    params: unknown[],
  ) {
    const standard =
      "accounts" in wallet ? (wallet as unknown as StandardSolana) : null;
    if (method === "solana_read" && !params.length)
      return { address: solanaAddress(wallet) };
    if (method === "solana_connect" && !params.length) {
      connectOnce();
      await (
        standard
          ? standard.features["standard:connect"]
          : (wallet as AdapterSolana)
      )?.connect?.();
      return { address: solanaAddress(wallet) };
    }
    const bytes = params[0];
    if (
      method !== "solana_signMessage" ||
      params.length != 1 ||
      !(bytes instanceof Uint8Array) ||
      bytes.length > WIDGET_FRAME_SIGN_IN_BYTES
    )
      throw refused();
    const text = utf8(bytes);
    return signOnce(async () => {
      const address = solanaAddress(wallet);
      if (!address || !checkFrameSignIn("solana", text, expectation(address)))
        throw refused();
      let signature: unknown;
      if (standard) {
        const account = standard.accounts.find(
          (item) => item.address === address,
        );
        const feature = standard.features["solana:signMessage"];
        if (!account || !feature?.signMessage) throw refused();
        const [output] = await feature.signMessage({ account, message: bytes });
        // A wallet that signed other bytes than these is refused.
        if (
          output?.signedMessage &&
          output.signedMessage.join() !== bytes.join()
        )
          throw refused();
        signature = output?.signature;
      } else {
        const signer = wallet as AdapterSolana;
        if (!signer.signMessage) throw refused();
        const output = await signer.signMessage(bytes);
        signature = output instanceof Uint8Array ? output : output?.signature;
      }
      if (!(signature instanceof Uint8Array) || signature.length !== 64)
        throw refused();
      return signature;
    });
  }
  const keys = {
    guest: `templ:support-guest:v1:${input.workspace}`,
    thread: `templ:support-guest-thread:v1:${input.workspace}`,
    draft: `templ:support-draft:v1:${location.origin}:${input.workspace}:`,
  };
  const drafts = () =>
    Object.keys(localStorage).filter((key) => key.startsWith(keys.draft));
  /** The draft keys sent to the frame; only these go once it has them. */
  let sent: string[] = [];
  return {
    /** What the page held for the regular widget: its guest credential and
     * thread, and up to three drafts as composer text and a transaction
     * hash, for the frame to take. An unconfirmed message comes back as
     * composer text: the member decides whether to send it again. */
    adoption() {
      try {
        const credential = localStorage.getItem(keys.guest) ?? "";
        const thread = localStorage.getItem(keys.thread) ?? "";
        const moving = drafts()
          .slice(0, 3)
          .map((key) => {
            let value = "";
            try {
              const saved = JSON.parse(localStorage.getItem(key) ?? "");
              value = JSON.stringify({
                text: saved.text || saved.pending?.text,
                transactionHash: saved.transactionHash,
                savedAt: saved.savedAt,
              });
            } catch {
              /* An unreadable draft moves as nothing. */
            }
            return { key, principal: key.slice(keys.draft.length), value };
          })
          .filter((draft) => draft.value.length <= 4096);
        sent = moving.map((draft) => draft.key);
        return {
          ...(/^[0-9a-f]{64}$/.test(credential) ? { credential } : {}),
          ...(/^tc-[0-9a-f]{32}$/.test(thread) ? { thread } : {}),
          drafts: moving.map(({ principal, value }) => ({ principal, value })),
        };
      } catch {
        return undefined;
      }
    },
    /** The frame took them, or the service ended them: they go. */
    adopted() {
      try {
        localStorage.removeItem(keys.guest);
        localStorage.removeItem(keys.thread);
        for (const key of sent) localStorage.removeItem(key);
      } catch {
        /* Storage is optional. */
      }
    },
    /** One call from the frame: the method, its parameters. */
    async call(method: string, params: unknown) {
      const wallet = input.wallet();
      if (!Array.isArray(params)) throw refused();
      if (wallet?.evm && !method.startsWith("solana_"))
        return evm(wallet.evm, method, params);
      if (wallet?.solana && method.startsWith("solana_"))
        return solana(wallet.solana, method, params);
      throw refused();
    },
    /** What the page's wallet shows now, read without a prompt. */
    async state() {
      const wallet = input.wallet();
      const provider = wallet?.evm;
      if (provider) {
        const read = (method: string) =>
          provider.request({ method }).catch(() => null);
        const [accounts, chainId] = await Promise.all([
          read("eth_accounts"),
          read("eth_chainId"),
        ]);
        return {
          family: "evm" as const,
          accounts: Array.isArray(accounts)
            ? accounts.filter((item) => typeof item == "string").slice(0, 4)
            : [],
          chainId: typeof chainId == "string" ? chainId : "",
        };
      }
      return wallet?.solana
        ? { family: "solana" as const, address: solanaAddress(wallet.solana) }
        : null;
    },
    /** Calls `changed` when the wallet's account or network changes, until
     * the returned function is called. */
    watch(changed: () => void) {
      const wallet = input.wallet();
      const provider = wallet?.evm;
      provider?.on?.("accountsChanged", changed);
      provider?.on?.("chainChanged", changed);
      const off = (
        wallet?.solana as {
          features?: {
            "standard:events"?: {
              on?(event: "change", listener: () => void): unknown;
            };
          };
        }
      )?.features?.["standard:events"]?.on?.("change", changed);
      return () => {
        provider?.removeListener?.("accountsChanged", changed);
        provider?.removeListener?.("chainChanged", changed);
        if (typeof off == "function") off();
      };
    },
  };
}
