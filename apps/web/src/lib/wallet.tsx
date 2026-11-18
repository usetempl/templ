"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type EIP1193Provider,
} from "viem";
import type { SupportWalletProvider } from "./support-widget";
import { mainnet, base, bsc, robinhood as robinhoodChain } from "viem/chains";
import { isChatChainId, type ChatChainId } from "@templ/chat/chains";
import {
  invalidateCommunitySession,
  peekCommunitySession,
} from "./community-auth";
import { WalletHandoffDialog } from "@/components/wallet-handoff-dialog";
import {
  walletHandoff,
  WalletHandoffRequired,
  type WalletHandoff,
} from "./wallet-handoff";

type InjectedProvider = EIP1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};
const accountChanged = () =>
  new Error("Your wallet account changed or disconnected. Connect again.");
const selectedAccount = (accounts: unknown): Address | undefined => {
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
    return undefined;
  try {
    return getAddress(accounts[0]);
  } catch {
    return undefined;
  }
};
const signingMethods = new Set([
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_sendCalls",
]);
const walletClient = (
  provider: InjectedProvider,
  account: Address,
  assertCurrent: () => void,
  messageOnly = false,
  signingChain = robinhoodChain as
    | typeof robinhoodChain
    | typeof mainnet
    | typeof base
    | typeof bsc,
) => {
  const guardedProvider: Pick<EIP1193Provider, "request"> = {
    request: (async (args: { method: string; params?: unknown }) => {
      assertCurrent();
      if (signingMethods.has(args.method)) {
        if (messageOnly && args.method !== "personal_sign")
          throw new Error(
            "Prepare a transaction wallet before signing a transaction.",
          );
        // RPC simulation may take seconds after ready(). Check again immediately
        // before asking the wallet to sign, including providers with no events.
        const accounts = await provider.request({ method: "eth_accounts" });
        assertCurrent();
        if (selectedAccount(accounts) !== account) throw accountChanged();
        if (!messageOnly || args.method !== "personal_sign") {
          const chain = await provider.request({ method: "eth_chainId" });
          assertCurrent();
          if (Number(chain) !== signingChain.id)
            throw new Error(`Switch your wallet to ${signingChain.name}.`);
        }
      }
      return provider.request(
        args as Parameters<EIP1193Provider["request"]>[0],
      );
    }) as EIP1193Provider["request"],
  };
  return createWalletClient({
    account,
    chain: signingChain,
    transport: custom(guardedProvider, { retryCount: 0 }),
  });
};
type DiscoveredWallet = {
  id: string;
  name: string;
  provider: InjectedProvider;
};
type Wallet = {
  wallets?: { id: string; name: string }[];
  selectedWallet?: string;
  walletChoiceRequired?: boolean;
  selectWallet?: (id: string) => void;
  account?: Address;
  restoring?: boolean;
  connect: (options?: { selectAccount?: boolean }) => Promise<Address>;
  ready: (chainId?: ChatChainId) => Promise<ReturnType<typeof walletClient>>;
  signingReady?: () => Promise<ReturnType<typeof walletClient>>;
  disconnect: () => void;
  /** The selected wallet's limited account and message-signing interface. */
  supportProvider?: SupportWalletProvider;
  /** After discovery: whether this browser has an EVM wallet at all. A
   * phone browser has none, so staff open links in a wallet app. */
  providerFound?: boolean;
};
const WalletContext = createContext<Wallet | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<InjectedProvider | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { ethereum?: InjectedProvider }).ethereum,
  );
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const discovered = useRef<DiscoveredWallet[]>([]);
  const [walletChosen, setWalletChosen] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const chosen = useRef(false);
  const activeProvider = useRef(provider);
  activeProvider.current = provider;
  const [account, setAccount] = useState<Address>();
  const [restoredProvider, setRestoredProvider] = useState<InjectedProvider>();
  const [browserChecked, setBrowserChecked] = useState(false);
  const [handoff, setHandoff] = useState<WalletHandoff | null>(null);
  const offerWallet = useCallback((): never => {
    setHandoff(
      walletHandoff(
        window.location.href,
        navigator.userAgent,
        navigator.maxTouchPoints,
      ),
    );
    // Abort this action. Installing/opening a wallet must never resume a queued
    // transaction or signature request from the original browser.
    throw new WalletHandoffRequired();
  }, []);
  const selection = useRef({
    account: undefined as Address | undefined,
    revision: 0,
    read: 0,
    event: 0,
    connection: 0,
    lifetime: 0,
    disconnected: false,
  });
  const applyAccount = useCallback((next?: Address) => {
    const current = selection.current;
    ++current.read;
    if (current.account !== next) {
      ++current.revision;
      // Keep the browser cookie, but require a fresh identity check for a new selection.
      // A Solana session is the only non-EVM case left: its EVM wallet is a
      // proven wallet on the account, not the browser's selection, so a
      // switch leaves it alone.
      const session = peekCommunitySession();
      if (session && session.authMethod !== "wallet") {
        /* The account and its wallets are unchanged. */
      } else if (current.account !== undefined || session)
        invalidateCommunitySession();
    }
    current.account = next;
    setAccount(next);
  }, []);
  const changeProvider = useCallback(
    (next: InjectedProvider) => {
      if (activeProvider.current === next) return;
      const current = selection.current;
      ++current.lifetime;
      ++current.connection;
      ++current.revision;
      current.disconnected = false;
      activeProvider.current = next;
      applyAccount(undefined);
      setProvider(next);
      setHandoff(null);
    },
    [applyAccount],
  );
  const selectWallet = useCallback(
    (id: string) => {
      const next = discovered.current.find((entry) => entry.id === id);
      if (!next)
        throw new Error(
          "That wallet is no longer available. Reload and try again.",
        );
      chosen.current = true;
      setWalletChosen(true);
      changeProvider(next.provider);
      setChoiceOpen(false);
    },
    [changeProvider],
  );
  const assertWalletChoice = useCallback(() => {
    if (discovered.current.length > 1 && !chosen.current) {
      setChoiceOpen(true);
      throw new Error("Choose the Ethereum wallet you want to use.");
    }
  }, []);
  const disconnect = useCallback(() => {
    const current = selection.current;
    current.disconnected = true;
    ++current.connection;
    ++current.revision;
    applyAccount(undefined);
    setRestoredProvider(provider);
    setHandoff(null);
  }, [applyAccount, provider]);

  useEffect(() => {
    let active = true;
    const announce = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          provider?: InjectedProvider;
          info?: { uuid?: unknown; name?: unknown };
        }>
      ).detail;
      const announced = detail?.provider;
      const info = detail?.info;
      if (
        !announced ||
        typeof announced.request !== "function" ||
        typeof info?.uuid !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(info.uuid) ||
        typeof info.name !== "string" ||
        !info.name.trim() ||
        info.name.length > 64 ||
        discovered.current.length >= 32 ||
        discovered.current.some(
          (entry) => entry.id === info.uuid || entry.provider === announced,
        )
      )
        return;
      const entry = {
        id: info.uuid,
        name: info.name.trim(),
        provider: announced,
      };
      discovered.current = [...discovered.current, entry];
      setWallets(discovered.current);
      // Use the direct announced provider instead of a competing window.ethereum shim.
      // With multiple wallets, connect/sign require the person's explicit selection.
      if (discovered.current.length === 1 && !chosen.current)
        changeProvider(announced);
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // The server and first client render both show restoration in progress.
    // Settle a provider-free browser only after hydration and discovery.
    queueMicrotask(() => {
      if (active) setBrowserChecked(true);
    });
    return () => {
      active = false;
      window.removeEventListener("eip6963:announceProvider", announce);
    };
  }, [changeProvider]);

  useEffect(() => {
    if (!provider) return;
    const state = selection.current;
    const lifetime = ++state.lifetime;
    const finishRestore = () => {
      if (selection.current.lifetime === lifetime)
        setRestoredProvider(provider);
    };
    // A stalled extension cannot keep the public chat's composer in loading.
    const restoreTimeout = window.setTimeout(finishRestore, 5_000);
    const accountsChanged = (...values: unknown[]) => {
      if (selection.current.lifetime !== lifetime) return;
      const current = selection.current;
      ++current.event;
      ++current.read;
      if (!current.disconnected) applyAccount(selectedAccount(values[0]));
      finishRestore();
    };
    const readAccounts = (initial = false) => {
      if (selection.current.lifetime !== lifetime) return;
      const request = ++selection.current.read;
      void provider
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          const current = selection.current;
          if (
            current.lifetime === lifetime &&
            current.read === request &&
            !current.disconnected
          )
            applyAccount(selectedAccount(accounts));
        })
        .catch(() => {})
        .finally(() => {
          if (initial) finishRestore();
        });
    };
    // A chain switch does not itself change the selected account. Its read may
    // update the account only if no newer account event/read has superseded it.
    const chainChanged = () => readAccounts();
    const providerDisconnected = () => {
      if (selection.current.lifetime !== lifetime) return;
      ++selection.current.revision;
      applyAccount(undefined);
      finishRestore();
    };
    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("chainChanged", chainChanged);
    provider.on?.("disconnect", providerDisconnected);
    readAccounts(true);
    return () => {
      window.clearTimeout(restoreTimeout);
      ++state.lifetime;
      ++state.connection;
      ++state.read;
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("chainChanged", chainChanged);
      provider.removeListener?.("disconnect", providerDisconnected);
    };
  }, [provider, applyAccount]);

  const connect = useCallback(
    async (options?: { selectAccount?: boolean }) => {
      assertWalletChoice();
      if (!provider) return offerWallet();
      chosen.current = true;
      setWalletChosen(true);
      const current = selection.current;
      const connection = ++current.connection;
      const lifetime = current.lifetime;
      const eventAtStart = current.event;
      const wasDisconnected = current.disconnected;
      current.disconnected = false;
      ++current.read;
      const assertConnection = () => {
        if (
          selection.current.connection !== connection ||
          selection.current.lifetime !== lifetime ||
          selection.current.disconnected
        )
          throw accountChanged();
      };
      try {
        if (options?.selectAccount) {
          try {
            await provider.request({
              method: "wallet_requestPermissions",
              params: [{ eth_accounts: {} }],
            });
            assertConnection();
          } catch (error) {
            const code = (error as { code?: number })?.code;
            if (code !== -32601 && code !== 4200) throw error;
          }
          assertConnection();
        }
        const accounts = await provider.request({
          method: "eth_requestAccounts",
        });
        assertConnection();
        const selected = selectedAccount(accounts);
        if (!selected) throw new Error("Choose an account in your wallet.");
        const fresh = await provider.request({ method: "eth_accounts" });
        assertConnection();
        if (
          selectedAccount(fresh) !== selected ||
          (selection.current.event !== eventAtStart &&
            selection.current.account !== selected)
        )
          throw accountChanged();
        applyAccount(selected);
        return selected;
      } catch (error) {
        if (wasDisconnected && selection.current.connection === connection)
          disconnect();
        throw error;
      }
    },
    [provider, applyAccount, disconnect, offerWallet, assertWalletChoice],
  );

  const signingReady = useCallback(async () => {
    assertWalletChoice();
    if (!provider) return offerWallet();
    const selected = selection.current.account ?? (await connect());
    const revision = selection.current.revision;
    const lifetime = selection.current.lifetime;
    const assertCurrent = () => {
      const current = selection.current;
      if (
        current.account !== selected ||
        current.revision !== revision ||
        current.lifetime !== lifetime ||
        current.disconnected
      )
        throw accountChanged();
    };
    const accounts = await provider.request({ method: "eth_accounts" });
    assertCurrent();
    if (selectedAccount(accounts) !== selected) throw accountChanged();
    const chainId = Number(await provider.request({ method: "eth_chainId" }));
    assertCurrent();
    if (!isChatChainId(chainId))
      throw new Error(
        "Choose Ethereum, Base, BNB Chain or Robinhood Chain in your wallet.",
      );
    const chain = { 1: mainnet, 8453: base, 56: bsc, 4663: robinhoodChain }[
      chainId
    ];
    return walletClient(provider, selected, assertCurrent, true, chain);
  }, [provider, connect, offerWallet, assertWalletChoice]);

  const ready = useCallback(
    async (targetChainId: ChatChainId = 4663) => {
      assertWalletChoice();
      if (!isChatChainId(targetChainId))
        throw new Error("Choose a supported wallet network.");
      const targetChain = {
        1: mainnet,
        8453: base,
        56: bsc,
        4663: robinhoodChain,
      }[targetChainId];
      const targetHex = `0x${targetChainId.toString(16)}`;
      if (!provider) return offerWallet();
      const selected = selection.current.account ?? (await connect());
      const revision = selection.current.revision;
      const lifetime = selection.current.lifetime;
      const assertCurrent = () => {
        const current = selection.current;
        if (
          current.account !== selected ||
          current.revision !== revision ||
          current.lifetime !== lifetime ||
          current.disconnected
        )
          throw accountChanged();
      };
      assertCurrent();
      const connected = await provider.request({ method: "eth_accounts" });
      assertCurrent();
      if (selectedAccount(connected) !== selected) throw accountChanged();
      const chainId = await provider.request({ method: "eth_chainId" });
      assertCurrent();
      if (Number(chainId) !== targetChainId) {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: targetHex }],
          });
          assertCurrent();
        } catch (error) {
          assertCurrent();
          if ((error as { code?: number }).code !== 4902) throw error;
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: targetHex,
                chainName: targetChain.name,
                nativeCurrency: targetChain.nativeCurrency,
                rpcUrls: [...targetChain.rpcUrls.default.http],
                blockExplorerUrls: [targetChain.blockExplorers.default.url],
              },
            ],
          });
          assertCurrent();
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: targetHex }],
          });
          assertCurrent();
        }
      }
      const chain = await provider.request({ method: "eth_chainId" });
      assertCurrent();
      if (Number(chain) !== targetChainId)
        throw new Error(`Switch your wallet to ${targetChain.name}.`);
      const accounts = await provider.request({ method: "eth_accounts" });
      assertCurrent();
      if (selectedAccount(accounts) !== selected) throw accountChanged();
      return walletClient(
        provider,
        selected,
        assertCurrent,
        false,
        targetChain,
      );
    },
    [provider, connect, offerWallet, assertWalletChoice],
  );

  const supportProvider = useMemo<SupportWalletProvider | undefined>(() => {
    if (!provider) return undefined;
    const assertProvider = () => {
      if (activeProvider.current !== provider) throw accountChanged();
    };
    return {
      on: (event, listener) => provider.on?.(event, listener),
      removeListener: (event, listener) =>
        provider.removeListener?.(event, listener),
      async request({ method, params }) {
        assertProvider();
        if (
          ![
            "eth_accounts",
            "eth_chainId",
            "eth_requestAccounts",
            "personal_sign",
          ].includes(method)
        )
          throw new Error(
            "Support can only connect a wallet and sign a message.",
          );
        if (method === "eth_requestAccounts") {
          const selected = await connect();
          assertProvider();
          return [selected];
        }
        if (selection.current.disconnected) {
          if (method === "eth_accounts") return [];
          throw accountChanged();
        }
        const revision = selection.current.revision;
        const lifetime = selection.current.lifetime;
        const assertCurrent = () => {
          assertProvider();
          const current = selection.current;
          if (
            current.disconnected ||
            current.revision !== revision ||
            current.lifetime !== lifetime
          )
            throw accountChanged();
        };
        if (method === "eth_accounts") {
          const accounts = await provider.request({ method: "eth_accounts" });
          assertCurrent();
          const selected = selectedAccount(accounts);
          applyAccount(selected);
          return selected ? [selected] : [];
        }
        if (method === "eth_chainId") {
          const chain = await provider.request({ method: "eth_chainId" });
          assertCurrent();
          return chain;
        }
        assertWalletChoice();
        const selected = selection.current.account;
        if (
          !selected ||
          !Array.isArray(params) ||
          params.length !== 2 ||
          typeof params[0] !== "string" ||
          !/^0x(?:[0-9a-f]{2})+$/i.test(params[0]) ||
          selectedAccount([params[1]]) !== selected
        )
          throw new Error("Use the connected wallet to sign in to support.");
        const checkAccount = async () => {
          const accounts = await provider.request({ method: "eth_accounts" });
          assertCurrent();
          if (selectedAccount(accounts) !== selected) throw accountChanged();
        };
        await checkAccount();
        const signature = await provider.request({
          method: "personal_sign",
          params: [params[0] as `0x${string}`, selected],
        });
        await checkAccount();
        return signature;
      },
    };
  }, [provider, connect, applyAccount, assertWalletChoice]);

  return (
    <WalletContext.Provider
      value={{
        account,
        wallets: wallets.map(({ id, name }) => ({ id, name })),
        selectedWallet: wallets.find((entry) => entry.provider === provider)
          ?.id,
        walletChoiceRequired: wallets.length > 1 && !walletChosen,
        selectWallet,
        restoring: provider ? restoredProvider !== provider : !browserChecked,
        connect,
        ready,
        signingReady,
        disconnect,
        supportProvider,
        providerFound: provider ? true : browserChecked ? false : undefined,
      }}
    >
      {children}
      {choiceOpen && (
        <WalletHandoffDialog
          options={{ mobile: false }}
          wallets={wallets.map(({ id, name }) => ({ id, name }))}
          onSelect={selectWallet}
          onClose={() => setChoiceOpen(false)}
        />
      )}
      {handoff && !provider && (
        <WalletHandoffDialog
          options={handoff}
          onClose={() => setHandoff(null)}
        />
      )}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("WalletProvider is missing.");
  return wallet;
}
export function walletError(error: unknown) {
  if (error instanceof WalletHandoffRequired) return "";
  const e = error as {
    code?: number;
    shortMessage?: string;
    message?: string;
    cause?: { code?: number };
  };
  if (e?.code === 4001 || e?.cause?.code === 4001)
    return "Your wallet declined the request. Check the wallet prompt and try again.";
  return (
    e?.shortMessage ?? e?.message ?? "The request failed. Please try again."
  );
}
