"use client";

import { useEffect, useRef, useState } from "react";
import { IconKey, IconMail, IconPlus, IconWallet } from "@tabler/icons-react";
import type { Address } from "viem";
import {
  CHAT_CHAINS,
  isChatChainId,
  type ChatChainId,
} from "@templ/chat/chains";
import { principalLabel, type ChatPrincipalId } from "@templ/chat/principal";
import { shortSolanaAddress } from "@templ/chat/solana";
import type {
  AccountBitcoinWalletMethod,
  AccountMethods,
  AccountSolanaWalletMethod,
  AccountWalletMethod,
  ChatAccount,
} from "@templ/chat/wallets";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import {
  readChatCapabilities,
  readCommunitySession,
} from "@/lib/community-auth";
import { useRelease } from "@/lib/release-context";
import { useWallet, walletError } from "@/lib/wallet";
import {
  connectSolanaWallet,
  solanaWalletAvailable,
} from "@/lib/solana-wallet";
import { connectBitcoinWallet } from "@/lib/bitcoin-wallet";
import {
  ACCOUNT_METHOD_LIMITS,
  addBitcoinWallet,
  addSolanaWallet,
  readAccountMethods,
  removeAccountEmail,
  removeBitcoinWallet,
  removeSolanaWallet,
  startEmailLink,
  verifyEmailLink,
} from "@/lib/account-methods";
import {
  addWalletWithSignature,
  removeAccountWallet,
} from "@/lib/wallet-links";
import { LoadingSpinner, Skeleton } from "./loading-state";
import { copy as t } from "@/lib/copy";
import styles from "./account-methods.module.css";

/** The /settings/account screen. One account, signed in by any of its
 * proven EVM, Solana or Bitcoin wallets, plus an optional alert email that
 * receives support alerts and never signs in. Nothing here spends, signs
 * transactions or grants a permission, and no field ever takes a key. */
const dateLabel = (iso: string | null) => {
  if (!iso) return null;
  const time = Date.parse(iso);
  return time > 0 ? new Date(time).toLocaleDateString() : null;
};

export function AccountMethodsPage() {
  const auth = useChatAuth();
  const sessionPrincipal = auth.session?.principalId;
  // A wallet switch drops the cached session for a moment; keep the panel
  // mounted until the cookie check confirms the person is signed out.
  const [remembered, setRemembered] = useState(sessionPrincipal);
  const [signedOut, setSignedOut] = useState(false);
  if (sessionPrincipal && sessionPrincipal !== remembered)
    setRemembered(sessionPrincipal);
  if (sessionPrincipal && signedOut) setSignedOut(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (sessionPrincipal || auth.restoring) return;
    let active = true;
    void readCommunitySession()
      .catch(() => undefined)
      .then((session) => {
        if (active && !session) setSignedOut(true);
      });
    return () => {
      active = false;
    };
  }, [sessionPrincipal, auth.restoring]);
  const principal = sessionPrincipal ?? (signedOut ? undefined : remembered);
  const checking = !principal && !signedOut;
  return (
    <div className={styles.page}>
      <h1>{t("shell.account.title")}</h1>
      <p className={styles.lead}>{t("shell.account.lead")}</p>
      {auth.restoring || checking ? (
        <Skeleton width="100%" height="120px" />
      ) : principal ? (
        <AccountMethodsPanel key={principal} principal={principal} />
      ) : (
        <div className={styles.gate}>
          <p>{t("shell.account.gate")}</p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setError("");
              void auth.signIn().catch((reason) => {
                if (!isChatSignInCanceled(reason))
                  setError(walletError(reason));
              });
            }}
          >
            <IconKey size={18} aria-hidden="true" /> {t("shell.common.signIn")}
          </button>
          {error && (
            <p className={styles.hint} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The send-code-then-verify flow for the alert email. */
function useEmailLink(api: {
  start: (email: string, requestId: string) => Promise<{ resendAfter: number }>;
  verify: (email: string, code: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentEmail, setSentEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const intent = useRef<{ email: string; id: string } | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  async function submit(resend = false) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      if (sentEmail && !resend) await api.verify(sentEmail, code);
      else {
        const target = email.trim();
        if (intent.current?.email !== target || resend)
          intent.current = { email: target, id: crypto.randomUUID() };
        const value = await api.start(target, intent.current!.id);
        if (alive.current) {
          setSentEmail(target);
          setCode("");
          setResendAt(value.resendAfter);
        }
      }
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error
            ? reason.message
            : t("shell.account.emailFailed"),
        );
    } finally {
      if (alive.current) setPending(false);
    }
  }
  return {
    email,
    setEmail,
    code,
    setCode: (value: string) => setCode(value.replace(/\D/g, "").slice(0, 6)),
    sentEmail,
    changeEmail: () => {
      setSentEmail("");
      setCode("");
    },
    pending,
    error,
    resendIn: now < resendAt ? Math.ceil((resendAt - now) / 1000) : 0,
    submit,
  };
}

type Busy =
  | "load"
  | "email-add"
  | "email-remove"
  | "wallet-add"
  | "wallet-remove"
  | "solana-add"
  | "solana-remove"
  | "bitcoin-add"
  | "bitcoin-remove"
  | null;
type AlertEmail = Pick<
  ChatAccount,
  "emailVerified" | "emailMasked" | "alertEmailAvailable"
>;
const alertEmailOf = (account: ChatAccount): AlertEmail => ({
  emailVerified: account.emailVerified,
  emailMasked: account.emailMasked,
  alertEmailAvailable: account.alertEmailAvailable,
});

export function AccountMethodsPanel({
  principal,
}: {
  principal: ChatPrincipalId;
}) {
  const wallet = useWallet();
  // Synced on every render so an async step reads the wallet's latest account.
  const latestAccount = useRef(wallet.account);
  latestAccount.current = wallet.account;
  const [methods, setMethods] = useState<AccountMethods>();
  const [alert, setAlert] = useState<AlertEmail>();
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [addingEmail, setAddingEmail] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [chainId, setChainId] = useState<ChatChainId>(1);
  // Solana wallets: offered when the worker signs them in and this browser
  // has one. Discovery runs after mount, so the server render matches.
  const [solanaSignIn, setSolanaSignIn] = useState<boolean>();
  const [solanaAvailable, setSolanaAvailable] = useState(false);
  useEffect(() => {
    setSolanaAvailable(solanaWalletAvailable());
  }, []);
  const [bitcoinOffered, setBitcoinOffered] = useState(false);
  const bitcoinSignIn =
    useRelease().bitcoinAccountSignInVerified === true && bitcoinOffered;

  useEffect(() => {
    const controller = new AbortController();
    setBusy("load");
    void readAccountMethods(principal, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setMethods(value.methods);
        setAlert(alertEmailOf(value));
        setError("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(walletError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    void readChatCapabilities()
      .then((value) => {
        if (controller.signal.aborted) return;
        setSolanaSignIn(value.solana.signIn);
        setBitcoinOffered(value.bitcoin?.signIn === true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSolanaSignIn(false);
        setBitcoinOffered(false);
      });
    return () => controller.abort();
  }, [principal, retry]);

  /** After a change, the session's verified wallet may differ or the session
   * may be gone; read both back before showing the new list. */
  async function reload(next?: AccountMethods) {
    const session = await readCommunitySession(true);
    if (!session || session.principalId !== principal) return;
    if (next) {
      setMethods(next);
      return;
    }
    const account = await readAccountMethods(principal);
    setMethods(account.methods);
    setAlert(alertEmailOf(account));
  }
  async function run(kind: Busy, task: () => Promise<AccountMethods | void>) {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const next = await task();
      await reload(next ?? undefined);
      return true;
    } catch (reason) {
      if (isChatSignInCanceled(reason)) return false;
      const message = walletError(reason);
      if (message) setError(message);
      return false;
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  const emailLink = useEmailLink({
    start: (email, requestId) => startEmailLink(principal, email, requestId),
    verify: async (email, code) => {
      await verifyEmailLink(principal, email, code);
      setAddingEmail(false);
      setNotice(t("shell.account.emailAdded"));
      await reload();
    },
  });

  async function addWallet() {
    const ok = await run("wallet-add", () =>
      addWalletWithSignature(
        principal,
        wallet,
        chainId,
        () => latestAccount.current,
      ).then(() => undefined),
    );
    if (ok) setNotice(t("shell.account.walletAdded"));
  }
  async function removeWallet(address: Address) {
    const ok = await run("wallet-remove", () =>
      removeAccountWallet(principal, address).then(() => undefined),
    );
    if (ok) setNotice(t("shell.account.walletRemoved"));
  }
  async function removeEmail() {
    const ok = await run("email-remove", () =>
      removeAccountEmail(principal).then(() => undefined),
    );
    if (ok) setNotice(t("shell.account.emailRemoved"));
  }
  async function addSolana() {
    const ok = await run("solana-add", () =>
      addSolanaWallet(principal, connectSolanaWallet),
    );
    if (ok) setNotice(t("shell.account.solanaAdded"));
  }
  async function dropSolana(address: string) {
    const ok = await run("solana-remove", () =>
      removeSolanaWallet(principal, address),
    );
    if (ok) setNotice(t("shell.account.solanaRemoved"));
  }
  async function addBitcoin() {
    const ok = await run("bitcoin-add", () =>
      addBitcoinWallet(principal, () => connectBitcoinWallet("attach")),
    );
    if (ok) setNotice(t("shell.account.bitcoinAdded"));
  }
  async function dropBitcoin(address: string) {
    const ok = await run("bitcoin-remove", () =>
      removeBitcoinWallet(principal, address),
    );
    if (ok) setNotice(t("shell.account.bitcoinRemoved"));
  }
  async function copyAccountId() {
    setError("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(principal);
      setNotice(t("shell.account.idCopied"));
    } catch {
      setError(t("shell.account.copyFailed"));
    }
  }

  const pending = busy !== null || emailLink.pending;
  if (!methods || !alert)
    return (
      <div>
        {error && (
          <p className={styles.hint} role="alert">
            {error}
          </p>
        )}
        {busy === "load" ? (
          <Skeleton width="100%" height="120px" />
        ) : (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setRetry(retry + 1)}
          >
            {t("shell.common.tryAgain")}
          </button>
        )}
      </div>
    );
  const bitcoinWallets = methods.bitcoinWallets ?? [];
  const canRemoveWhileBitcoinPaused =
    bitcoinSignIn ||
    bitcoinWallets.length === 0 ||
    methods.wallets.length + methods.solanaWallets.length > 1;
  return (
    <div>
      {error && (
        <p className={styles.hint} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <section className={styles.section} aria-labelledby="account-id">
        <h2 id="account-id">{t("shell.account.idTitle")}</h2>
        <p className={styles.hint}>{t("shell.account.idHint")}</p>
        <code className={styles.address}>{principal}</code>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void copyAccountId()}
          >
            {t("shell.account.copyId")}
          </button>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="account-wallets">
        <h2 id="account-wallets">{t("shell.common.wallets")}</h2>
        <p className={styles.hint}>
          {t("shell.account.walletsHint", {
            count: ACCOUNT_METHOD_LIMITS.wallets,
          })}
        </p>
        {methods.wallets.length === 0 ? (
          <p className={styles.empty}>{t("shell.account.noWallet")}</p>
        ) : (
          <ul className={styles.list} aria-label={t("shell.common.wallets")}>
            {methods.wallets.map((entry) => (
              <WalletRow
                key={entry.address}
                entry={entry}
                allowed={methods.canRemove.wallets && canRemoveWhileBitcoinPaused}
                confirming={confirming === `wallet:${entry.address}`}
                pending={pending}
                onAsk={() => {
                  setError("");
                  setNotice("");
                  setConfirming(`wallet:${entry.address}`);
                }}
                onKeep={() => setConfirming(null)}
                onConfirm={() => void removeWallet(entry.address)}
              />
            ))}
          </ul>
        )}
        <div className={styles.form}>
          <label>
            {t("shell.account.network")}
            <select
              value={chainId}
              disabled={pending}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (isChatChainId(next)) setChainId(next);
              }}
            >
              {CHAT_CHAINS.map((chain) => (
                <option key={chain.id} value={chain.id}>
                  {chain.name}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.hint}>{t("shell.account.walletHint")}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={
                pending ||
                methods.wallets.length >= ACCOUNT_METHOD_LIMITS.wallets
              }
              onClick={() => void addWallet()}
            >
              {busy === "wallet-add" ? (
                <LoadingSpinner />
              ) : (
                <IconWallet size={16} aria-hidden="true" />
              )}
              {busy === "wallet-add"
                ? t("shell.account.waitingWallet")
                : t("shell.account.addWallet")}
            </button>
            {wallet.account && (
              <span className={styles.hint}>
                {t("shell.account.connected", {
                  address: principalLabel(wallet.account.toLowerCase()),
                })}
              </span>
            )}
          </div>
        </div>
      </section>

      {(solanaSignIn || methods.solanaWallets.length > 0) && (
        <section className={styles.section} aria-labelledby="account-solana">
          <h2 id="account-solana">{t("shell.account.solanaWallets")}</h2>
          <p className={styles.hint}>
            {t("shell.account.solanaHint", {
              count: ACCOUNT_METHOD_LIMITS.solanaWallets,
            })}
          </p>
          {methods.solanaWallets.length === 0 ? (
            <p className={styles.empty}>{t("shell.account.noSolanaWallet")}</p>
          ) : (
            <ul
              className={styles.list}
              aria-label={t("shell.account.solanaWallets")}
            >
              {methods.solanaWallets.map((entry) => (
                <AccountAddressRow
                  chain="Solana"
                  key={entry.address}
                  entry={entry}
                  allowed={methods.canRemove.solanaWallets && canRemoveWhileBitcoinPaused}
                  confirming={confirming === `solana:${entry.address}`}
                  pending={pending}
                  onAsk={() => {
                    setError("");
                    setNotice("");
                    setConfirming(`solana:${entry.address}`);
                  }}
                  onKeep={() => setConfirming(null)}
                  onConfirm={() => void dropSolana(entry.address)}
                />
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={
                pending ||
                !solanaSignIn ||
                !solanaAvailable ||
                methods.solanaWallets.length >=
                  ACCOUNT_METHOD_LIMITS.solanaWallets
              }
              onClick={() => void addSolana()}
            >
              {busy === "solana-add" ? (
                <LoadingSpinner />
              ) : (
                <IconWallet size={16} aria-hidden="true" />
              )}
              {busy === "solana-add"
                ? t("shell.account.waitingSolanaWallet")
                : t("shell.account.addSolanaWallet")}
            </button>
            {!solanaAvailable && (
              <span className={styles.hint}>
                {t("shell.account.solanaWalletMissing")}
              </span>
            )}
          </div>
        </section>
      )}

      {(bitcoinSignIn || bitcoinWallets.length > 0) && (
        <section className={styles.section} aria-labelledby="account-bitcoin">
          <h2 id="account-bitcoin">{t("shell.account.bitcoinWallets")}</h2>
          {bitcoinSignIn && (
            <p className={styles.hint}>
              {t("shell.account.bitcoinHint", {
                count: ACCOUNT_METHOD_LIMITS.bitcoinWallets,
              })}
            </p>
          )}
          {bitcoinWallets.length === 0 ? (
            <p className={styles.empty}>{t("shell.account.noBitcoinWallet")}</p>
          ) : (
            <ul
              className={styles.list}
              aria-label={t("shell.account.bitcoinWallets")}
            >
              {bitcoinWallets.map((entry) => (
                <AccountAddressRow
                  chain="Bitcoin"
                  key={entry.address}
                  entry={entry}
                  allowed={methods.canRemove.bitcoinWallets === true}
                  confirming={confirming === `bitcoin:${entry.address}`}
                  pending={pending}
                  onAsk={() => {
                    setError("");
                    setNotice("");
                    setConfirming(`bitcoin:${entry.address}`);
                  }}
                  onKeep={() => setConfirming(null)}
                  onConfirm={() => void dropBitcoin(entry.address)}
                />
              ))}
            </ul>
          )}
          {bitcoinSignIn && (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={
                  pending ||
                  bitcoinWallets.length >= ACCOUNT_METHOD_LIMITS.bitcoinWallets
                }
                onClick={() => void addBitcoin()}
              >
                {busy === "bitcoin-add" ? (
                  <LoadingSpinner />
                ) : (
                  <IconWallet size={16} aria-hidden="true" />
                )}
                {busy === "bitcoin-add"
                  ? t("shell.account.waitingWallet")
                  : t("shell.account.addBitcoinWallet")}
              </button>
            </div>
          )}
        </section>
      )}

      <section className={styles.section} aria-labelledby="account-email">
        <h2 id="account-email">{t("shell.account.alertEmail")}</h2>
        <p className={styles.hint}>{t("shell.account.alertEmailHint")}</p>
        {alert.emailVerified && alert.emailMasked ? (
          <ul
            className={styles.list}
            aria-label={t("shell.account.alertEmail")}
          >
            <li className={styles.row}>
              <div className={styles.rowHead}>
                <IconMail size={18} aria-hidden="true" />
                <span className={styles.name}>{alert.emailMasked}</span>
              </div>
              <RemoveControl
                label={t("shell.account.removeEmail")}
                notice={t("shell.account.emailRemoveNotice")}
                allowed
                confirming={confirming === "email"}
                pending={pending}
                onAsk={() => {
                  setError("");
                  setNotice("");
                  setConfirming("email");
                }}
                onKeep={() => setConfirming(null)}
                onConfirm={() => void removeEmail()}
              />
            </li>
          </ul>
        ) : addingEmail ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void emailLink.submit();
            }}
          >
            {emailLink.sentEmail ? (
              <>
                <label>
                  {t("shell.common.codeSentTo", { email: emailLink.sentEmail })}
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    autoFocus
                    value={emailLink.code}
                    disabled={pending}
                    onChange={(event) => emailLink.setCode(event.target.value)}
                  />
                </label>
                <div className={styles.links}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={emailLink.changeEmail}
                  >
                    {t("shell.common.changeEmail")}
                  </button>
                  <button
                    type="button"
                    disabled={pending || emailLink.resendIn > 0}
                    onClick={() => void emailLink.submit(true)}
                  >
                    {emailLink.resendIn > 0
                      ? t("shell.common.resendIn", {
                          seconds: emailLink.resendIn,
                        })
                      : t("shell.common.resendCode")}
                  </button>
                </div>
              </>
            ) : (
              <label>
                {t("shell.common.email")}
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  maxLength={254}
                  value={emailLink.email}
                  disabled={pending}
                  onChange={(event) => emailLink.setEmail(event.target.value)}
                />
              </label>
            )}
            {emailLink.error && (
              <p className={styles.hint} role="alert">
                {emailLink.error}
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="submit"
                className={styles.secondary}
                disabled={pending}
              >
                {emailLink.pending ? <LoadingSpinner /> : null}
                {emailLink.sentEmail
                  ? t("shell.account.verifyEmail")
                  : t("shell.account.sendCode")}
              </button>
              <button
                type="button"
                className={styles.secondary}
                disabled={pending}
                onClick={() => setAddingEmail(false)}
              >
                {t("shell.common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={pending || !alert.alertEmailAvailable}
              onClick={() => {
                setError("");
                setNotice("");
                setAddingEmail(true);
              }}
            >
              <IconPlus size={16} aria-hidden="true" />{" "}
              {t("shell.account.addEmail")}
            </button>
            {!alert.alertEmailAvailable && (
              <span className={styles.hint}>
                {t("shell.account.alertEmailUnavailable")}
              </span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function RemoveControl({
  label,
  notice,
  allowed,
  confirming,
  pending,
  onAsk,
  onKeep,
  onConfirm,
}: {
  label: string;
  notice: string;
  allowed: boolean;
  confirming: boolean;
  pending: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  if (!allowed)
    return <p className={styles.hint}>{t("shell.account.lastMethodNotice")}</p>;
  if (confirming)
    return (
      <div
        className={styles.confirm}
        role="group"
        aria-label={t("shell.account.confirm", { label })}
      >
        <p>{notice}</p>
        <div className={styles.rowActions}>
          <button
            type="button"
            className={`${styles.secondary} ${styles.danger}`}
            disabled={pending}
            onClick={onConfirm}
          >
            {label}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={pending}
            onClick={onKeep}
          >
            {t("shell.common.keepIt")}
          </button>
        </div>
      </div>
    );
  return (
    <div className={styles.rowActions}>
      <button
        type="button"
        className={`${styles.secondary} ${styles.danger}`}
        disabled={pending}
        onClick={onAsk}
      >
        {t("shell.common.remove")}
      </button>
    </div>
  );
}

function WalletRow({
  entry,
  ...control
}: {
  entry: AccountWalletMethod;
  allowed: boolean;
  confirming: boolean;
  pending: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const added = dateLabel(entry.addedAt);
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.address} title={entry.address}>
          {principalLabel(entry.address)}
        </span>
        {entry.current && (
          <span className={styles.badge}>{t("shell.account.current")}</span>
        )}
      </div>
      <p className={styles.meta}>
        {entry.kind === "contract" && (
          <span>{t("shell.common.smartWallet")}</span>
        )}
        {added && <span>{t("shell.common.added", { date: added })}</span>}
      </p>
      <RemoveControl
        label={t("shell.account.removeWallet")}
        notice={t("shell.account.walletRemoveNotice")}
        {...control}
      />
    </li>
  );
}

function AccountAddressRow({
  chain,
  entry,
  ...control
}: {
  chain: "Bitcoin" | "Solana";
  entry: AccountBitcoinWalletMethod | AccountSolanaWalletMethod;
  allowed: boolean;
  confirming: boolean;
  pending: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const added = dateLabel(entry.addedAt);
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.address} title={entry.address}>
          {chain === "Bitcoin"
            ? `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`
            : shortSolanaAddress(entry.address)}
        </span>
        {entry.current && (
          <span className={styles.badge}>{t("shell.account.current")}</span>
        )}
      </div>
      <p className={styles.meta}>
        <span>{chain}</span>
        {added && <span>{t("shell.common.added", { date: added })}</span>}
      </p>
      <RemoveControl
        label={t(chain === "Bitcoin" ? "shell.account.removeBitcoinWallet" : "shell.account.removeSolanaWallet")}
        notice={t("shell.account.walletRemoveNotice")}
        {...control}
      />
    </li>
  );
}
