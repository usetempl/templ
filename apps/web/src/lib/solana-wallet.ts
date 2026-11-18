import {
  base58Encode,
  isSolanaAddress,
  SOLANA_WALLET_CHAIN,
} from "@templ/chat/solana";

/** Solana wallets in this browser. Discovery follows the Wallet Standard
 * (the `wallet-standard:app-ready` and `wallet-standard:register-wallet`
 * events and the `navigator.wallets` list), with the older injected
 * providers (`window.solana`, Phantom, Solflare, Backpack) as a fallback.
 * Sign-in asks the wallet to sign text. The transaction helper asks a Wallet
 * Standard account to sign and send a reviewed payload. Private keys stay
 * in the wallet. */
export type SolanaSigner = {
  /** The wallet's own name, for the sign-in button. */
  name: string;
  /** Base58 public key of the connected account. */
  address: string;
  /** Signs a UTF-8 text and returns the 64-byte signature in base58. */
  signMessage: (text: string) => Promise<string>;
};
export const SOLANA_WALLET_MISSING =
  "No Solana wallet was found in this browser. Install one such as Phantom, Solflare or Backpack, then try again.";
export class SolanaWalletMissing extends Error {
  constructor() {
    super(SOLANA_WALLET_MISSING);
    this.name = "SolanaWalletMissing";
  }
}

type StandardAccount = {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
};
type StandardWallet = {
  version: string;
  name: string;
  icon?: string;
  chains: readonly string[];
  features: Record<string, unknown>;
  accounts: readonly StandardAccount[];
};
type ConnectFeature = {
  connect: (input?: {
    silent?: boolean;
  }) => Promise<{ accounts: readonly StandardAccount[] }>;
};
type SignMessageFeature = {
  signMessage: (
    ...inputs: { account: StandardAccount; message: Uint8Array }[]
  ) => Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
};
type RegisterApi = { register: (...wallets: StandardWallet[]) => () => void };
type PublicKeyLike = { toBase58?: () => string; toString: () => string };
type InjectedProvider = {
  publicKey?: PublicKeyLike | null;
  connect: (input?: {
    onlyIfTrusted?: boolean;
  }) => Promise<{ publicKey?: PublicKeyLike } | void>;
  signMessage: (
    message: Uint8Array,
    display?: "utf8" | "hex",
  ) => Promise<{ signature: Uint8Array } | Uint8Array>;
};

const registered = new Map<string, StandardWallet>();
let listening = false;
function isSolanaWallet(wallet: unknown): wallet is StandardWallet {
  const w = wallet as Partial<StandardWallet> | null;
  return (
    !!w &&
    typeof w === "object" &&
    typeof w.name === "string" &&
    Array.isArray(w.chains) &&
    w.chains.some((chain) => String(chain).startsWith("solana:")) &&
    !!w.features &&
    typeof (w.features["standard:connect"] as ConnectFeature | undefined)
      ?.connect === "function" &&
    typeof (w.features["solana:signMessage"] as SignMessageFeature | undefined)
      ?.signMessage === "function"
  );
}
/** Starts listening once. Wallets registered later still appear because the
 * `register-wallet` listener and the `navigator.wallets` hook stay in place. */
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const api: RegisterApi = {
    register: (...wallets) => {
      for (const wallet of wallets)
        if (isSolanaWallet(wallet)) registered.set(wallet.name, wallet);
      return () => {};
    },
  };
  const callback = (value: unknown) => {
    try {
      if (typeof value === "function")
        (value as (api: RegisterApi) => void)(api);
    } catch {
      /* A wallet that throws while registering is left out. */
    }
  };
  window.addEventListener("wallet-standard:register-wallet", (event) =>
    callback((event as CustomEvent<unknown>).detail),
  );
  try {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:app-ready", { detail: api }),
    );
  } catch {
    /* No wallet is listening yet. */
  }
  try {
    const nav = window.navigator as Navigator & { wallets?: unknown };
    const existing = Array.isArray(nav.wallets) ? [...nav.wallets] : [];
    for (const entry of existing) callback(entry);
    Object.defineProperty(nav, "wallets", {
      configurable: true,
      value: Object.freeze({
        push: (...entries: unknown[]) => {
          for (const entry of entries) callback(entry);
          return entries.length;
        },
      }),
    });
  } catch {
    /* The navigator list is optional in the standard. */
  }
}
function injectedProvider(): InjectedProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as Window & {
    phantom?: { solana?: InjectedProvider };
    solflare?: InjectedProvider;
    backpack?: InjectedProvider;
    solana?: InjectedProvider;
  };
  const candidates = [w.phantom?.solana, w.solflare, w.backpack, w.solana];
  return candidates.find(
    (candidate) =>
      !!candidate &&
      typeof candidate.connect === "function" &&
      typeof candidate.signMessage === "function",
  );
}
/** Whether this browser has a Solana wallet to offer. */
export function solanaWalletAvailable(): boolean {
  listen();
  return registered.size > 0 || Boolean(injectedProvider());
}
const publicKeyText = (key: PublicKeyLike | null | undefined) =>
  key ? (key.toBase58?.() ?? key.toString()) : "";
const signatureBytes = (value: unknown): Uint8Array | null => {
  const bytes =
    value instanceof Uint8Array
      ? value
      : ((value as { signature?: unknown } | null)?.signature ?? null);
  return bytes instanceof Uint8Array && bytes.length === 64 ? bytes : null;
};

/** Connects the first Solana wallet found (a wallet that already shares an
 * account wins) and returns a signer for one address. The wallet's own
 * prompt decides; a refusal surfaces as the wallet's error. */
export async function connectSolanaWallet(): Promise<SolanaSigner> {
  listen();
  const wallets = [...registered.values()];
  const wallet =
    wallets.find((entry) =>
      entry.accounts.some((account) =>
        account.chains.includes(SOLANA_WALLET_CHAIN),
      ),
    ) ?? wallets[0];
  if (wallet) {
    const connect = wallet.features["standard:connect"] as ConnectFeature;
    const { accounts } = await connect.connect();
    const account =
      accounts.find((entry) =>
        entry.chains.some((chain) => chain.startsWith("solana:")),
      ) ?? accounts[0];
    if (!account || !isSolanaAddress(account.address))
      throw new Error("The wallet did not share a Solana account.");
    const sign = wallet.features["solana:signMessage"] as SignMessageFeature;
    return {
      name: wallet.name,
      address: account.address,
      signMessage: async (text) => {
        const [output] = await sign.signMessage({
          account,
          message: new TextEncoder().encode(text),
        });
        const bytes = signatureBytes(output);
        if (!bytes) throw new Error("The wallet did not sign the message.");
        return base58Encode(bytes);
      },
    };
  }
  const injected = injectedProvider();
  if (!injected) throw new SolanaWalletMissing();
  const connected = await injected.connect();
  const address = publicKeyText(
    (connected && "publicKey" in connected ? connected.publicKey : null) ??
      injected.publicKey,
  );
  if (!isSolanaAddress(address))
    throw new Error("The wallet did not share a Solana account.");
  return {
    name: "Solana wallet",
    address,
    signMessage: async (text) => {
      const output = await injected.signMessage(
        new TextEncoder().encode(text),
        "utf8",
      );
      const bytes = signatureBytes(output);
      if (!bytes) throw new Error("The wallet did not sign the message.");
      return base58Encode(bytes);
    },
  };
}

/** A Wallet Standard account sends its own transaction on Solana mainnet. */
export async function connectSolanaTransactionWallet(expectedAddress?: string) {
  listen();
  type SendFeature = {
    signAndSendTransaction: (
      ...inputs: {
        account: StandardAccount;
        chain: string;
        transaction: Uint8Array;
        options: { preflightCommitment: "confirmed" };
      }[]
    ) => Promise<readonly { signature: Uint8Array }[]>;
  };
  const wallet = [...registered.values()].find(
    (w) =>
      w.chains.includes(SOLANA_WALLET_CHAIN) &&
      typeof (
        w.features["solana:signAndSendTransaction"] as SendFeature | undefined
      )?.signAndSendTransaction === "function",
  );
  if (!wallet)
    throw new Error(
      "Use a Solana wallet that supports Wallet Standard transaction signing.",
    );
  const { accounts } = await (
    wallet.features["standard:connect"] as ConnectFeature
  ).connect();
  const account = accounts.find(
    (a) =>
      a.chains.includes(SOLANA_WALLET_CHAIN) &&
      a.features.includes("solana:signAndSendTransaction") &&
      (!expectedAddress || a.address === expectedAddress),
  );
  if (!account || !isSolanaAddress(account.address))
    throw new Error(
      expectedAddress
        ? "Choose the Solana wallet verified for this account."
        : "Choose a Solana mainnet account in your wallet.",
    );
  if (base58Encode(account.publicKey) !== account.address)
    throw new Error("The wallet account could not be verified.");
  return {
    address: account.address,
    send: async (transaction: Uint8Array) => {
      if (
        !wallet.accounts.some(
          (a) =>
            a.address === account.address &&
            a.chains.includes(SOLANA_WALLET_CHAIN) &&
            a.features.includes("solana:signAndSendTransaction"),
        )
      )
        throw new Error("The wallet account changed. Connect again.");
      const [result] = await (
        wallet.features["solana:signAndSendTransaction"] as SendFeature
      ).signAndSendTransaction({
        account,
        chain: SOLANA_WALLET_CHAIN,
        transaction,
        options: { preflightCommitment: "confirmed" },
      });
      if (
        !(result?.signature instanceof Uint8Array) ||
        result.signature.length !== 64
      )
        throw new Error("The wallet did not return a transaction signature.");
      return base58Encode(result.signature);
    },
  };
}
