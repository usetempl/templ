"use client";

import { useEffect, useRef, useState } from "react";
import { isSolanaAddress } from "@templ/chat/solana";
import { TemplMark } from "@/components/brand/templ-mark";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { supportPageWallet } from "@/lib/support-page-wallet";
import type {
  mountSupportWidget,
  SupportSolanaWallet,
} from "@/lib/support-widget";
import { SITE } from "@/lib/site-environment";
import { trackEvent } from "@/lib/analytics";
import {
  publicSolanaFailure,
  PUBLIC_SOLANA_QUESTION,
} from "@/lib/example-solana";
import styles from "../vault/vault.module.css";

type Widget = ReturnType<typeof mountSupportWidget>;
type PageWallet = SupportSolanaWallet & {
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
};

function walletAddress(wallet: SupportSolanaWallet | undefined): string | null {
  const address = wallet
    ? "accounts" in wallet
      ? wallet.accounts.find(
          (account) =>
            !account.chains ||
            account.chains.some((chain) => chain.startsWith("solana:")),
        )?.address
      : wallet.publicKey?.toBase58()
    : undefined;
  return isSolanaAddress(address) ? address : null;
}

export function SolanaExample({
  workspace,
  nonce,
}: {
  workspace: string;
  nonce?: string;
}) {
  const [chat, setChat] = useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = useState(0);
  const [sample, setSample] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const [reset, setReset] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletFailed, setWalletFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const widget = useRef<Widget | null>(null);
  const capturing = useRef(false);
  const resetRequested = useRef(false);
  const connectionRequested = useRef(false);

  useEffect(() => {
    const wallet = supportPageWallet("solana").solana as PageWallet;
    const refresh = () => setAddress(walletAddress(wallet));
    refresh();
    for (const event of ["connect", "disconnect", "accountChanged"])
      wallet.on?.(event, refresh);
    const stop =
      "features" in wallet
        ? (
            wallet.features as {
              "standard:events"?: {
                on?(event: "change", listener: () => void): unknown;
              };
            }
          )["standard:events"]?.on?.("change", refresh)
        : undefined;
    return () => {
      for (const event of ["connect", "disconnect", "accountChanged"])
        wallet.removeListener?.(event, refresh);
      if (typeof stop === "function") stop();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let mounted: Widget | undefined;
    const restarting = resetRequested.current;
    async function mount() {
      if (restarting) {
        const keys = [
          "guest",
          "guest-thread",
          "member",
          "wait",
          "tab",
          "keep",
        ].map((name) => `templ:support-${name}:v1:${workspace}`);
        const draft = `templ:support-draft:v1:${location.origin}:${workspace}:`;
        for (const storage of [localStorage, sessionStorage]) {
          for (const key of Object.keys(storage)) {
            if (keys.includes(key) || key.startsWith(draft))
              storage.removeItem(key);
          }
        }
      }
      const widgetModule = await loadTemplSupportWidget();
      if (disposed) return;
      mounted = widgetModule.mountSupportWidget({
        workspace,
        apiUrl: SITE.community,
        wallet: supportPageWallet("solana"),
        styleNonce: nonce,
        label: "Solana support",
        appearance: { theme: "auto", accent: "#99FF00", radius: "square" },
      });
      widget.current = mounted;
      if (restarting) {
        mounted.open();
        setSample("idle");
        setReset("ready");
      }
      resetRequested.current = false;
      setChat("ready");
    }
    void mount().catch(() => {
      if (disposed) return;
      resetRequested.current = false;
      if (restarting) setReset("failed");
      setChat("failed");
      trackEvent("example_support_failed");
      console.warn(
        JSON.stringify({
          event: "TEMPL_SUPPORT_FAILURE",
          route: "example-solana",
          reason: "widget-load",
        }),
      );
    });
    return () => {
      disposed = true;
      widget.current = null;
      mounted?.destroy();
    };
  }, [workspace, nonce, retry]);

  function openSupport() {
    if (!widget.current) return;
    try {
      widget.current.open();
      setOpenFailed(false);
      trackEvent("example_support_opened");
    } catch {
      setOpenFailed(true);
      trackEvent("example_support_failed");
    }
  }

  function resetSupport() {
    if (!widget.current || capturing.current || resetRequested.current) return;
    resetRequested.current = true;
    setReset("loading");
    setChat("loading");
    setOpenFailed(false);
    setRetry((value) => value + 1);
  }

  async function connectWallet() {
    if (connectionRequested.current) return;
    connectionRequested.current = true;
    setConnecting(true);
    setWalletFailed(false);
    try {
      const selected = supportPageWallet("solana");
      const wallet = selected.solana!;
      if ("accounts" in wallet) {
        const feature = (
          wallet.features as {
            "standard:connect"?: { connect?(): Promise<unknown> };
          }
        )["standard:connect"];
        if (!feature?.connect) throw new Error("Wallet unavailable");
        await feature.connect();
      } else {
        if (!wallet.connect) throw new Error("Wallet unavailable");
        await wallet.connect();
      }
      const connected = walletAddress(wallet);
      if (!connected) throw new Error("Wallet did not share an account");
      widget.current?.setWallet(selected);
      setAddress(connected);
    } catch {
      setWalletFailed(true);
    } finally {
      connectionRequested.current = false;
      setConnecting(false);
    }
  }

  async function loadSample() {
    const current = widget.current;
    if (!current || capturing.current || resetRequested.current) return;
    capturing.current = true;
    setSample("loading");
    setReset("idle");
    try {
      const failure = publicSolanaFailure();
      try {
        throw new Error(failure.app?.error?.message);
      } catch (error) {
        await current.captureFailure({
          ...failure,
          app: {
            ...failure.app,
            error: { ...failure.app?.error, message: (error as Error).message },
          },
        });
      }
      if (widget.current !== current) return;
      current.setQuestion(PUBLIC_SOLANA_QUESTION);
      setSample("ready");
      trackEvent("example_scenario_changed");
      openSupport();
    } catch {
      if (widget.current !== current) return;
      setSample("failed");
      trackEvent("example_support_failed");
    } finally {
      capturing.current = false;
    }
  }

  return (
    <div className={`${styles.page} ${styles.demoPage}`}>
      <header className={styles.header}>
        <TemplMark className={styles.stamp} decorative />
        <h1>Try Solana support</h1>
        <p>Try support as a user, then view the case as the team.</p>
      </header>
      <div className={`${styles.vault} ${styles.demoShell}`}>
        <header className={styles.demoNav}>
          <strong>Solana vault</strong>
          <nav aria-label="Protocol preview">
            <span aria-disabled="true">Vaults</span>
            <span aria-disabled="true">Activity</span>
          </nav>
          <span className={styles.demoNetwork}>Solana</span>
        </header>
        <div className={styles.demoColumns}>
          <section className={styles.demoStep} aria-labelledby="solana-error">
            <h2 id="solana-error">1. Try a failed transfer</h2>
            <div
              className={styles.demoPreview}
              aria-label="Inactive transfer preview"
            >
              <strong>Send USDC</strong>
              <div className={styles.demoField}>
                <span>Token</span>
                <strong>USDC</strong>
              </div>
              <div className={styles.demoField}>
                <span>Amount</span>
                <span>Enter an amount</span>
              </div>
              <div className={styles.demoField}>
                <span>Recipient</span>
                <span>Choose a wallet</span>
              </div>
            </div>
            <p className={styles.notice}>
              This public USDC transfer is not your transaction or wallet. No
              transaction is sent.
            </p>
            <button
              className="button"
              type="button"
              disabled={chat !== "ready" || sample === "loading" || connecting}
              aria-busy={sample === "loading"}
              onClick={() => void loadSample()}
            >
              {sample === "failed" ? "Try again" : "Try failed transfer"}
            </button>
            {sample === "loading" && (
              <p className={styles.notice} role="status">
                Loading the failure…
              </p>
            )}
            {sample === "ready" && (
              <div className={styles.demoError} role="alert">
                <strong>Transfer failed</strong>
                <p>{publicSolanaFailure().app?.error?.message}</p>
              </div>
            )}
            {sample === "failed" && (
              <p className={styles.notice} role="alert">
                Support could not load the sample. Try again.
              </p>
            )}
          </section>
          <div className={styles.demoSupport}>
            <section className={styles.demoStep} aria-labelledby="solana-chat">
              <h2 id="solana-chat">2. Send a message</h2>
              <p className={styles.notice}>
                Choose the details to share, then send the question in chat.
              </p>
              <div className={styles.demoWallet}>
                <span>{address ? "Wallet connected" : "Guest support"}</span>
                {address && <span>Not verified</span>}
                <button
                  className="button quiet"
                  type="button"
                  disabled={
                    connecting || sample === "loading" || reset === "loading"
                  }
                  aria-busy={connecting}
                  onClick={() => void connectWallet()}
                >
                  {connecting ? "Connecting…" : "Connect wallet"}
                </button>
              </div>
              {address ? (
                <code className={styles.demoAddress}>{address}</code>
              ) : (
                <p className={styles.notice}>You can ask without a wallet.</p>
              )}
              {walletFailed && (
                <p className={styles.notice} role="alert">
                  Wallet could not connect. Open this page in your Solana wallet
                  browser, or continue as a guest.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  className="button"
                  type="button"
                  disabled={chat !== "ready"}
                  onClick={openSupport}
                >
                  Open support
                </button>
                <button
                  className="button quiet"
                  type="button"
                  disabled={
                    chat !== "ready" || sample === "loading" || connecting
                  }
                  aria-busy={reset === "loading"}
                  onClick={resetSupport}
                >
                  Reset support
                </button>
              </div>
              {chat === "loading" && (
                <p className={styles.notice} role="status">
                  {reset === "loading"
                    ? "Resetting support…"
                    : "Loading support…"}
                </p>
              )}
              {chat === "failed" && (
                <div className={styles.notice} role="alert">
                  <p>
                    {reset === "failed"
                      ? "Support could not reset. Try again."
                      : "Support could not load."}
                  </p>
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      resetRequested.current = reset === "failed";
                      setChat("loading");
                      if (reset === "failed") setReset("loading");
                      setRetry((value) => value + 1);
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
              {reset === "ready" && (
                <p className={styles.notice} role="status">
                  Support reset. Your next message creates a new case. Previous
                  cases stay in the inbox.
                </p>
              )}
              {openFailed && (
                <p className={styles.notice} role="alert">
                  Support could not open. Try again.
                </p>
              )}
            </section>
            <section className={styles.demoStep} aria-labelledby="solana-inbox">
              <h2 id="solana-inbox">3. See the team inbox</h2>
              <p className={styles.notice}>
                Sign in with <strong>hackathon@colosseum.com</strong> to open
                the judge workspace.
              </p>
              <a
                className="button quiet"
                href={`/inbox/${workspace}`}
              >
                Open team inbox
              </a>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
