"use client";

import { useMemo, useSyncExternalStore } from "react";
import { IconWallet } from "@tabler/icons-react";
import { copy as t } from "@/lib/copy";
import { useWallet } from "@/lib/wallet";
import { walletHandoff, type WalletHandoff } from "@/lib/wallet-handoff";
import { solanaWalletAvailable } from "@/lib/solana-wallet";
import { WalletAppLinks } from "@/components/wallet-app-links";
import styles from "./wallet-app-card.module.css";

const noSubscription = () => () => {};

/** A staff link (`team=1`) opened in a phone browser that has no wallet and
 * no session: the handoff for this page, or null. It is read in the
 * browser after wallet discovery, never on the server, and forwards only
 * what `walletHandoff` keeps. */
export function usePhoneWalletHandoff(
  signedOut: boolean,
): WalletHandoff | null {
  const { providerFound } = useWallet();
  const href = useSyncExternalStore(
    noSubscription,
    () => window.location.href,
    () => null,
  );
  return useMemo(() => {
    if (!href || !signedOut || providerFound !== false) return null;
    let team: string | null = null;
    try {
      team = new URL(href).searchParams.get("team");
    } catch {
      return null;
    }
    if (team !== "1" || solanaWalletAvailable()) return null;
    const options = walletHandoff(
      href,
      navigator.userAgent,
      navigator.maxTouchPoints,
    );
    return options.mobile && options.deepLink ? options : null;
  }, [href, signedOut, providerFound]);
}

/** Shown before the sign-in prompt on a phone browser without a wallet. */
export function WalletAppCard({
  options,
  onStayHere,
}: {
  options: WalletHandoff;
  onStayHere: () => void;
}) {
  return (
    <section className={styles.card} aria-labelledby="wallet-app-card-title">
      <span className={styles.icon} aria-hidden="true">
        <IconWallet />
      </span>
      <h1 id="wallet-app-card-title">{t("phone.handoff.titleRequest")}</h1>
      <p>{t("phone.card.body")}</p>
      <div className={styles.links}>
        <WalletAppLinks options={options} />
      </div>
      <button type="button" className={styles.here} onClick={onStayHere}>
        {t("phone.card.here")}
      </button>
    </section>
  );
}
