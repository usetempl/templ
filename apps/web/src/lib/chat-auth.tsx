"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { IconMail, IconX, IconWallet } from "@tabler/icons-react";
import { useWallet, walletError } from "./wallet";
import { ChatSignInCanceledError } from "./chat-auth-cancellation";
import {
  attachCommunityWallet,
  communitySessionRevision,
  detachCommunityWallet,
  peekCommunitySession,
  readChatCapabilities,
  readCommunitySession,
  signInCommunity,
  startEmailCommunitySignIn,
  verifyEmailCommunitySignIn,
  signInWithBitcoin,
  signInWithSolana,
  signOutCommunity,
  subscribeCommunitySession,
  type ChatCapabilities,
  type CommunitySession,
} from "./community-auth";
import {
  readLastSignInMethod,
  rememberSignInMethod,
  type SignInMethod,
} from "./last-sign-in-method";
import { connectSolanaWallet, type SolanaSigner } from "./solana-wallet";
import type { BitcoinSigner } from "./bitcoin-wallet";
import { addBitcoinWallet, addSolanaWallet, readAccountMethods } from "./account-methods";
import { trackEvent } from "./analytics";
import { CommunityApiError } from "./community-client";
import { WalletHandoffRequired } from "./wallet-handoff";
import { LoadingSpinner } from "@/components/loading-state";
import { copy as t } from "@/lib/copy";
import { useRelease } from "./release-context";
import { useDismissDialog } from "./use-dismiss-dialog";
import styles from "@/components/chat-sign-in.module.css";

async function selectMessageWallet(network: "solana" | "bitcoin"): Promise<ConnectedWallet> {
  if (network === "solana") return { method: network, signer: await connectSolanaWallet() };
  const { connectBitcoinWallet } = await import("./bitcoin-wallet");
  return { method: network, signer: await connectBitcoinWallet("sign-in") };
}

type Auth = {
  session?: CommunitySession;
  restoring: boolean;
  signIn: (options?: {
    connectCode?: string;
    refreshEmail?: true;
  }) => Promise<CommunitySession>;
  signOut: () => Promise<void>;
  connectWallet: () => Promise<CommunitySession>;
  disconnectWallet: () => Promise<void>;
};
const Context = createContext<Auth | null>(null);
type SignInAction =
  | "wallet"
  | "solana"
  | "bitcoin"
  | "sign"
  | "email-start"
  | "email-verify";
type ConnectedWallet =
  | { method: "wallet"; address: `0x${string}` }
  | { method: "solana"; signer: SolanaSigner }
  | { method: "bitcoin"; signer: BitcoinSigner };

function verifiedWalletSession(address: `0x${string}`) {
  const value = peekCommunitySession();
  if (
    value?.authMethod !== "wallet" ||
    value.address?.toLowerCase() !== address.toLowerCase()
  )
    throw new Error("Sign in again.");
  return value;
}

export function ChatAuthProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const session = peekCommunitySession();
  const [restoring, setRestoring] = useState(true);
  const [open, setOpen] = useState(false);
  const [strongOnly, setStrongOnly] = useState(false);
  const [preferEmail, setPreferEmail] = useState(false);
  const [connectCode, setConnectCode] = useState<string>();
  useEffect(() => {
    const prompt = () => {
      setStrongOnly(true);
      setPreferEmail(false);
      setOpen(true);
    };
    window.addEventListener("templ:strong-auth-required", prompt);
    return () =>
      window.removeEventListener("templ:strong-auth-required", prompt);
  }, []);
  const pending = useRef<{
    promise: Promise<CommunitySession>;
    resolve: (value: CommunitySession) => void;
    reject: (error: Error) => void;
    connectCode?: string;
    refreshEmail?: true;
  } | null>(null);
  /** True while the dialog runs a wallet action; a session found by the
   * background check then waits for that action instead of closing it. */
  const dialogBusy = useRef(false);
  const capabilities = useRef<Promise<ChatCapabilities> | null>(null);
  const loadCapabilities = useCallback((force = false) => {
    if (force || !capabilities.current) {
      const request = readChatCapabilities();
      capabilities.current = request;
      request.catch(() => {
        if (capabilities.current === request) capabilities.current = null;
      });
    }
    return capabilities.current;
  }, []);
  useEffect(() => {
    let active = true;
    const restore = () =>
      void readCommunitySession()
        .catch(() => {})
        .finally(() => {
          if (active) setRestoring(false);
        });
    restore();
    window.addEventListener("focus", restore);
    return () => {
      active = false;
      window.removeEventListener("focus", restore);
    };
  }, []);
  const complete = useCallback((value?: CommunitySession) => {
    setOpen(false);
    setConnectCode(undefined);
    // A confirmation prompt for a sensitive change is not a new sign-in.
    if (value && pending.current) trackEvent("sign_in_completed");
    if (value) pending.current?.resolve(value);
    else pending.current?.reject(new ChatSignInCanceledError());
    pending.current = null;
  }, []);
  const signIn = useCallback(
    async (options?: { connectCode?: string; refreshEmail?: true }) => {
      const requestedCode = options?.connectCode;
      const refreshEmail = options?.refreshEmail;
      // A remembered session is checked as before; without one the dialog opens
      // at once and the cookie check runs behind it.
      if (!requestedCode && !refreshEmail && peekCommunitySession()) {
        const current = await readCommunitySession().catch(() =>
          peekCommunitySession(),
        );
        if (current) return current;
      }
      if (pending.current) {
        if (
          pending.current.connectCode !== requestedCode ||
          pending.current.refreshEmail !== refreshEmail
        )
          throw new Error("Wait for the current sign-in.");
        return pending.current.promise;
      }
      let resolve!: (value: CommunitySession) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<CommunitySession>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const entry = {
        promise,
        resolve,
        reject,
        connectCode: requestedCode,
        refreshEmail,
      };
      pending.current = entry;
      setStrongOnly(false);
      setPreferEmail(refreshEmail === true);
      setConnectCode(requestedCode);
      setOpen(true);
      trackEvent("sign_in_opened");
      if (!requestedCode && !refreshEmail)
        void readCommunitySession().then(
          (current) => {
            if (current && pending.current === entry && !dialogBusy.current)
              complete(current);
          },
          () => {},
        );
      return promise;
    },
    [complete],
  );
  // A Solana session adds the connected EVM wallet to the
  // account through the shared wallet routes; an EVM session signs in.
  const connectWallet = async () => {
    const current = await signIn();
    const address = wallet.account ?? (await wallet.connect());
    if (current.authMethod !== "wallet")
      return attachCommunityWallet(
        address,
        wallet.signingReady ?? wallet.ready,
      );
    await signInCommunity(address, wallet.signingReady ?? wallet.ready);
    return verifiedWalletSession(address);
  };
  const disconnectWallet = async () => {
    const current = peekCommunitySession();
    if (current && current.authMethod !== "wallet")
      await detachCommunityWallet();
    else await signOutCommunity();
    wallet.disconnect();
  };
  return (
    <Context.Provider
      value={{
        session,
        restoring,
        signIn,
        signOut: signOutCommunity,
        connectWallet,
        disconnectWallet,
      }}
    >
      {children}
      {open && (
        <SignInDialog
          onComplete={complete}
          strongOnly={strongOnly}
          preferEmail={preferEmail}
          connectCode={connectCode}
          loadCapabilities={loadCapabilities}
          onBusyChange={(value) => {
            dialogBusy.current = value;
          }}
        />
      )}
    </Context.Provider>
  );
}

function SignInDialog({
  onComplete,
  strongOnly = false,
  preferEmail = false,
  connectCode,
  loadCapabilities,
  onBusyChange,
}: {
  onComplete: (session?: CommunitySession) => void;
  strongOnly?: boolean;
  preferEmail?: boolean;
  connectCode?: string;
  loadCapabilities: (force?: boolean) => Promise<ChatCapabilities>;
  onBusyChange: (busy: boolean) => void;
}) {
  const wallet = useWallet();
  const release = useRelease();
  const dialog = useRef<HTMLDialogElement>(null);
  // "unknown" until the worker answers; the wallet button shows meanwhile
  // and stays when the answer fails.
  const [methodsAvailability, setMethodsAvailability] = useState<
    "unknown" | "ready" | "failed"
  >("unknown");
  const [walletEnabled, setWalletEnabled] = useState(true);
  const [emailOffered, setEmailOffered] = useState(false);
  const emailEnabled =
    release.emailSignInVerified === true &&
    emailOffered &&
    !strongOnly &&
    !connectCode;
  const [method, setMethod] = useState<"wallet" | "email">(
    preferEmail ||
      (release.emailSignInVerified === true &&
        readLastSignInMethod() === "email")
      ? "email"
      : "wallet",
  );
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailChallenge, setEmailChallenge] = useState<{
    expiresAt: number;
    resendAfter: number;
  }>();
  const emailRequestId = useRef<string | undefined>(undefined);
  const [emailNow, setEmailNow] = useState(Date.now);
  const resendSeconds = Math.max(
    0,
    Math.ceil(((emailChallenge?.resendAfter ?? 0) - emailNow) / 1_000),
  );
  useEffect(() => {
    if (!emailChallenge) return;
    setEmailNow(Date.now());
    if (emailChallenge.resendAfter <= Date.now()) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setEmailNow(now);
      if (now >= emailChallenge.resendAfter) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [emailChallenge]);
  const [bitcoinOffered, setBitcoinOffered] = useState(false);
  const bitcoinEnabled =
    release.bitcoinAccountSignInVerified === true && bitcoinOffered;
  const [solanaOffered, setSolanaOffered] = useState(false);
  const solanaEnabled = release.solana.signIn && solanaOffered;
  const [activeAction, setActiveAction] = useState<SignInAction | null>(null);
  const [connected, setConnected] = useState<ConnectedWallet | null>(() =>
    wallet.account && !wallet.walletChoiceRequired
      ? { method: "wallet", address: wallet.account }
      : null,
  );
  useEffect(() => {
    setConnected((current) =>
      current && current.method !== "wallet"
        ? current
        : wallet.account && !wallet.walletChoiceRequired
          ? { method: "wallet", address: wallet.account }
          : null,
    );
  }, [wallet.account, wallet.walletChoiceRequired]);
  const actionPending = useRef(false);
  const busy = activeAction !== null;
  const selectedMethodEnabled =
    connected?.method === "bitcoin" ? bitcoinEnabled :
    connected?.method === "solana" ? solanaEnabled : walletEnabled;
  const [changingMethod, setChangingMethod] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const checkMethods = useCallback(
    async (force = false) => {
      try {
        const value = await loadCapabilities(force);
        if (alive.current) {
          setWalletEnabled(value.wallet);
          setEmailOffered(value.emailSignIn);
          setSolanaOffered(value.solana.signIn);
          setBitcoinOffered(value.bitcoin?.signIn === true);
          setMethodsAvailability("ready");
        }
      } catch {
        if (alive.current) setMethodsAvailability("failed");
      }
    },
    [loadCapabilities],
  );
  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    void checkMethods();
    return () => {
      alive.current = false;
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [checkMethods]);
  // An email account confirms a wallet-only change with a wallet on that
  // account. A new wallet is added first, so its sign-in opens no other account.
  const [emailAccount] = useState(() => {
    const current = strongOnly ? peekCommunitySession() : undefined;
    return current?.authMethod === "email" ? current.principalId : undefined;
  });
  const [accountWallets, setAccountWallets] = useState<string[]>();
  const readAccountWallets = useCallback(async () => {
    if (!emailAccount) return undefined;
    const { methods } = await readAccountMethods(emailAccount);
    const addresses = [...methods.wallets, ...methods.solanaWallets, ...(methods.bitcoinWallets ?? [])].map(
      ({ address }) => address,
    );
    if (alive.current) setAccountWallets(addresses);
    return addresses;
  }, [emailAccount]);
  useEffect(() => {
    void readAccountWallets().catch(() => {});
  }, [readAccountWallets]);
  async function perform(name: SignInAction, action: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    onBusyChange(true);
    setActiveAction(name);
    setError("");
    if (
      !strongOnly &&
      (name === "sign" || name === "wallet" || name === "solana" || name === "bitcoin")
    )
      trackEvent(
        name === "sign"
          ? "sign_in_verify_clicked"
          : "sign_in_wallet_connect_clicked",
      );
    try {
      await action();
    } catch (reason) {
      if (!strongOnly)
        trackEvent(
          (reason as { code?: number } | null)?.code === 4001
            ? "sign_in_cancelled"
            : "sign_in_failed",
        );
      if (
        name === "email-start" &&
        reason instanceof CommunityApiError &&
        reason.status === 409
      )
        emailRequestId.current = undefined;
      console.warn(
        JSON.stringify({
          event: "TEMPL_SUPPORT_FAILURE",
          route: "sign-in",
          step:
            name === "sign" || name === "email-verify" ? "verify" : "connect",
          reason:
            reason instanceof CommunityApiError
              ? "service-refused"
              : reason instanceof WalletHandoffRequired
                ? "wallet-unavailable"
                : (reason as { code?: number } | null)?.code === 4001
                  ? "wallet-cancelled"
                  : reason instanceof TypeError
                    ? "connection-failed"
                    : "wallet-failed",
        }),
      );
      if (alive.current)
        setError(
          name.startsWith("email-")
            ? reason instanceof CommunityApiError
              ? reason.message
              : "Email sign-in could not finish. Try again."
            : walletError(reason),
        );
    } finally {
      actionPending.current = false;
      onBusyChange(false);
      if (alive.current) setActiveAction(null);
    }
  }
  function completeSignIn(method: SignInMethod, session: CommunitySession) {
    if (!alive.current) return;
    rememberSignInMethod(method);
    onComplete(session);
  }
  const anyMethod = walletEnabled || solanaEnabled || bitcoinEnabled || emailEnabled;
  const usingEmail = emailEnabled && method === "email";
  const checkingEmail = methodsAvailability === "unknown" &&
    release.emailSignInVerified === true && !strongOnly && !connectCode;
  const showEmailChoice = emailEnabled || checkingEmail;
  const emailInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (usingEmail) emailInput.current?.focus();
  }, [usingEmail, emailChallenge]);
  const connectedAddress =
    connected?.method === "wallet"
      ? connected.address
      : connected?.signer.address;
  const connectedLabel =
    connectedAddress &&
    `${connectedAddress.slice(0, connected?.method === "solana" ? 4 : 6)}…${connectedAddress.slice(-4)}`;
  const accountAddress =
    connected?.method === "wallet"
      ? connected.address.toLowerCase()
      : connected?.signer.address;
  const newWallet =
    !!accountWallets &&
    !!accountAddress &&
    !accountWallets.includes(accountAddress);
  const dismiss = useDismissDialog(() => onComplete(), { disabled: busy });
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="chat-sign-in-title"
      {...dismiss}
    >
      <header className={styles.header}>
        <h2 id="chat-sign-in-title">{t("shell.signIn.title")}</h2>
        <button
          type="button"
          className={styles.close}
          disabled={busy}
          onClick={() => onComplete()}
          aria-label={t("shell.signIn.close")}
        >
          <IconX size={20} />
        </button>
      </header>
      {strongOnly && (
        <p className={styles.hint}>
          {emailAccount
            ? "This change needs a wallet. Sign in with one on your account, or add one here. Then submit the change again."
            : "Confirm your identity with a wallet already on this account. Then review and submit the change again."}
        </p>
      )}
      {connectCode && (
        <p className={styles.hint}>
          Sign in to review this app. You choose its workspace in the next step.
        </p>
      )}
      {usingEmail ? (
        <form
          className={styles.emailForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (emailChallenge) {
              void perform("email-verify", async () => {
                const session = await verifyEmailCommunitySignIn(
                  email.trim(),
                  emailCode.trim(),
                );
                completeSignIn("email", session);
              });
            } else {
              emailRequestId.current ??= crypto.randomUUID();
              void perform("email-start", async () => {
                const challenge = await startEmailCommunitySignIn(
                  email.trim(),
                  emailRequestId.current!,
                );
                if (alive.current) {
                  setEmailChallenge(challenge);
                  emailRequestId.current = undefined;
                }
              });
            }
          }}
        >
          {emailChallenge ? (
            <>
              <p>Enter the code sent to {email}.</p>
              <label htmlFor="chat-email-code">Email code</label>
              <input
                className={styles.emailInput}
                ref={emailInput}
                id="chat-email-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={emailCode}
                disabled={busy}
                onChange={(event) =>
                  setEmailCode(event.target.value.replace(/[^0-9]/g, ""))
                }
              />
              <button
                className={styles.primary}
                disabled={busy}
                aria-busy={activeAction === "email-verify"}
                type="submit"
              >
                {activeAction === "email-verify" && <LoadingSpinner />}Sign in
              </button>
              <button
                className={styles.textButton}
                type="button"
                disabled={busy || resendSeconds > 0}
                aria-busy={activeAction === "email-start"}
                onClick={() => {
                  if (Date.now() < emailChallenge.resendAfter) return;
                  emailRequestId.current ??= crypto.randomUUID();
                  void perform("email-start", async () => {
                    const challenge = await startEmailCommunitySignIn(
                      email.trim(),
                      emailRequestId.current!,
                    );
                    if (alive.current) {
                      setEmailChallenge(challenge);
                      setEmailCode("");
                      emailRequestId.current = undefined;
                    }
                  });
                }}
              >
                {resendSeconds ? `Resend in ${resendSeconds}s` : "Resend code"}
              </button>
              <button
                className={styles.textButton}
                type="button"
                disabled={busy}
                onClick={() => {
                  setEmailChallenge(undefined);
                  setEmailCode("");
                  emailRequestId.current = undefined;
                  setError("");
                }}
              >
                Use another email
              </button>
            </>
          ) : (
            <>
              <label htmlFor="chat-sign-in-email">Email address</label>
              <input
                className={styles.emailInput}
                ref={emailInput}
                id="chat-sign-in-email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(event) => {
                  setEmail(event.target.value);
                  emailRequestId.current = undefined;
                }}
              />
              <button
                className={styles.primary}
                disabled={busy}
                aria-busy={activeAction === "email-start"}
                type="submit"
              >
                {activeAction === "email-start" && <LoadingSpinner />}Send
                sign-in code
              </button>
            </>
          )}
          {(walletEnabled || solanaEnabled || bitcoinEnabled) && (
            <button
              type="button"
              className={styles.textButton}
              disabled={busy}
              onClick={() => {
                setMethod("wallet");
                setChangingMethod(true);
                setError("");
              }}
            >
              Use a wallet instead
            </button>
          )}
        </form>
      ) : (
        <>
          {connected &&
          selectedMethodEnabled &&
          !changingMethod ? (
            <div className={styles.wallets}>
              <p className={styles.account}>
                {{ wallet: "Ethereum", solana: "Solana", bitcoin: "Bitcoin" }[connected.method]} ·{" "}
                <span title={connectedAddress}>{connectedLabel}</span>
              </p>
              <button
                type="button"
                className={styles.primary}
                disabled={busy}
                aria-busy={activeAction === "sign"}
                onClick={() =>
                  void perform("sign", async () => {
                    // A failed read stops here: an unknown wallet never signs in.
                    const onAccount = await readAccountWallets();
                    if (
                      emailAccount &&
                      accountAddress &&
                      onAccount &&
                      !onAccount.includes(accountAddress)
                    ) {
                      if (!newWallet) return;
                      if (connected.method === "bitcoin")
                        await addBitcoinWallet(emailAccount, async () => connected.signer);
                      else if (connected.method === "solana")
                        await addSolanaWallet(
                          emailAccount,
                          async () => connected.signer,
                        );
                      else
                        await attachCommunityWallet(
                          connected.address,
                          wallet.signingReady ?? wallet.ready,
                          undefined,
                          emailAccount,
                        );
                      if (alive.current)
                        setAccountWallets([...onAccount, accountAddress]);
                    }
                    if (connected.method === "bitcoin") {
                      const value = await signInWithBitcoin(async () => connected.signer, connectCode);
                      completeSignIn("bitcoin", value);
                    } else if (connected.method === "solana") {
                      const value = await signInWithSolana(
                        async () => connected.signer,
                        connectCode,
                      );
                      completeSignIn("solana", value);
                    } else {
                      await signInCommunity(
                        connected.address,
                        wallet.signingReady ?? wallet.ready,
                        strongOnly,
                        connectCode,
                      );
                      completeSignIn(
                        "wallet",
                        verifiedWalletSession(connected.address),
                      );
                    }
                  })
                }
              >
                {activeAction === "sign" && <LoadingSpinner />}
                {activeAction === "sign"
                  ? "Check your wallet…"
                  : emailAccount && !accountWallets
                    ? "Check wallet"
                    : newWallet
                      ? "Add wallet and sign in"
                      : "Sign in"}
              </button>
              <button
                type="button"
                className={styles.textButton}
                disabled={busy}
                onClick={() => {
                  setChangingMethod(true);
                  setError("");
                }}
              >
                Use another sign-in method
              </button>
            </div>
          ) : (
            <div className={styles.wallets} aria-label="Sign-in methods">
              {showEmailChoice && (
                <button
                  type="button"
                  className={styles.walletOption}
                  disabled={busy || !emailEnabled}
                  onClick={() => {
                    setMethod("email");
                    setError("");
                  }}
                >
                  <IconMail size={19} aria-hidden="true" />
                  Continue with Email
                </button>
              )}
              {walletEnabled && (
                <button
                  type="button"
                  className={showEmailChoice ? `${styles.walletOption} secondary` : styles.walletOption}
                  disabled={busy}
                  aria-busy={activeAction === "wallet"}
                  onClick={() => {
                    void perform("wallet", async () => {
                      const address = await wallet.connect({
                        useDetectedWallet: true,
                        selectAccount:
                          changingMethod && connected?.method === "wallet",
                      });
                      if (alive.current) {
                        setConnected({ method: "wallet", address });
                        setChangingMethod(false);
                      }
                    });
                  }}
                >
                  {activeAction === "wallet" ? (
                    <LoadingSpinner />
                  ) : (
                    <IconWallet size={19} aria-hidden="true" />
                  )}
                  Continue with Ethereum
                </button>
              )}
              {(["solana", "bitcoin"] as const).map(network => {
                if (!(network === "solana" ? solanaEnabled : bitcoinEnabled)) return null;
                return (
                  <button
                    key={network}
                    type="button"
                    className={showEmailChoice ? `${styles.walletOption} secondary` : styles.walletOption}
                    disabled={busy}
                    aria-busy={activeAction === network}
                    onClick={() => void perform(network, async () => {
                      const selected = await selectMessageWallet(network);
                      if (alive.current) {
                        setConnected(selected);
                        setChangingMethod(false);
                      }
                    })}
                  >
                    {activeAction === network ? <LoadingSpinner /> : <IconWallet size={19} aria-hidden="true" />}
                    {network === "solana" ? "Continue with Solana" : "Continue with Bitcoin"}
                  </button>
                );
              })}
            </div>
          )}
          {(methodsAvailability === "failed" ||
            (methodsAvailability === "ready" && !anyMethod)) && (
            <div className={styles.methodRetry}>
              <p className={styles.hint} role="status">
                {t(
                  methodsAvailability === "failed"
                    ? "shell.signIn.methodsCheckFailed"
                    : "shell.signIn.methodsUnavailable",
                )}
              </p>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => {
                  setMethodsAvailability("unknown");
                  void checkMethods(true);
                }}
              >
                {t("shell.common.tryAgain")}
              </button>
            </div>
          )}
        </>
      )}
      <p className={styles.policies}>
        <Link href="/terms">{t("shell.common.terms")}</Link>
        <Link href="/privacy">{t("shell.common.privacy")}</Link>
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
export function useChatAuth() {
  const value = useContext(Context);
  if (!value) throw new Error("ChatAuthProvider is missing.");
  return value;
}
