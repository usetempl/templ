"use client";

import { useEffect, useState, type Ref } from "react";
import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { copy as t } from "@/lib/copy";
import { readChatCapabilities } from "@/lib/community-auth";
import { solanaBrowserLinks, type WalletHandoff } from "@/lib/wallet-handoff";
import styles from "./wallet-handoff-dialog.module.css";

/** Whether the service offers Solana sign-in. A failed read offers no
 * Solana wallet. */
const readSolanaOffered = (): Promise<boolean> =>
  readChatCapabilities().then(
    (value) => value.solana.signIn,
    () => false,
  );

/** Solana wallet-app links appear only once the service says Solana sign-in
 * works, so a Solana-only wallet never opens a page it can't sign in to. */
function useSolanaOffered(wanted: boolean) {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    void readSolanaOffered().then((value) => {
      if (alive) setOffered(value);
    });
    return () => {
      alive = false;
    };
  }, [wanted]);
  return offered;
}

/** The ways to leave this browser for a wallet app: MetaMask's link, the
 * Solana wallets' browse links and a copy of the cleaned link. Every link
 * is built from `walletHandoff`, which drops anything outside its
 * allowlist. */
export function WalletAppLinks({
  options,
  primaryRef,
}: {
  options: WalletHandoff;
  primaryRef?: Ref<HTMLAnchorElement>;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const solana = solanaBrowserLinks(options);
  const offered = useSolanaOffered(solana.length > 0);
  const request = options.request === true;

  async function copyLink() {
    if (!options.siteUrl) return;
    try {
      await navigator.clipboard.writeText(options.siteUrl);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  }

  return (
    <>
      <a
        ref={primaryRef}
        className={styles.primary}
        href={options.deepLink ?? "https://metamask.io/download"}
        rel="noreferrer noopener"
        referrerPolicy="no-referrer"
      >
        {options.deepLink
          ? t("room.handoff.openMetaMask")
          : t("room.handoff.getMetaMask")}
        <IconExternalLink size={19} aria-hidden="true" />
      </a>
      {offered && (
        <div
          className={styles.wallets}
          role="group"
          aria-label={t("phone.handoff.solana")}
        >
          {solana.map((link) => (
            <a
              key={link.wallet}
              className={styles.wallet}
              href={link.href}
              rel="noreferrer noopener"
              referrerPolicy="no-referrer"
            >
              {t("phone.handoff.openIn", { name: link.name })}
            </a>
          ))}
        </div>
      )}
      {options.siteUrl && (
        <button type="button" className={styles.copy} onClick={copyLink}>
          {copyState === "copied" ? (
            <IconCheck size={17} aria-hidden="true" />
          ) : (
            <IconCopy size={17} aria-hidden="true" />
          )}
          {copyState === "copied"
            ? t(request ? "phone.handoff.copied" : "room.handoff.copied")
            : t(request ? "phone.handoff.copyLink" : "room.handoff.copyLink")}
        </button>
      )}
      {options.siteUrl && request && (
        <p className={styles.hint}>{t("phone.handoff.copyHint")}</p>
      )}
      {copyState === "manual" && (
        <label className={styles.manual}>
          {t("room.handoff.copyThisLink")}
          <input
            readOnly
            value={options.siteUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
      <span className={styles.status} role="status">
        {copyState === "copied"
          ? t(request ? "phone.handoff.linkCopied" : "room.handoff.linkCopied")
          : ""}
      </span>
    </>
  );
}
