"use client";

import { useEffect, useId, useRef } from "react";
import { IconArrowRight, IconLock, IconX } from "@tabler/icons-react";
import type { WalletHandoff } from "@/lib/wallet-handoff";
import { copy as t } from "@/lib/copy";
import { useDismissDialog } from "@/lib/use-dismiss-dialog";
import styles from "./wallet-handoff-dialog.module.css";
import { WalletAppLinks } from "./wallet-app-links";

export function WalletHandoffDialog({
  options,
  wallets,
  onSelect,
  onClose,
}: {
  options: WalletHandoff;
  wallets?: { id: string; name: string }[];
  onSelect?: (id: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLAnchorElement>(null);
  const dismiss = useDismissDialog(onClose);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    primary.current?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      {...dismiss}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Tab") {
          const targets = event.currentTarget.querySelectorAll<HTMLElement>(
            "a[href], button:not(:disabled), input:not(:disabled)",
          );
          const first = targets[0];
          const last = targets[targets.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className={styles.header}>
        <h2 id={titleId}>
          {wallets
            ? "Choose your Ethereum wallet"
            : options.request
              ? t("phone.handoff.titleRequest")
              : t("room.handoff.title")}
        </h2>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={t("room.handoff.close")}
        >
          <IconX size={20} aria-hidden="true" />
        </button>
      </div>
      <p id={descriptionId}>
        {wallets
          ? "Choose the wallet you want to use, then try again."
          : options.deepLink
            ? t("room.handoff.continueInWallet")
            : t("room.handoff.useWallet")}
      </p>
      {wallets ? (
        <div className={styles.wallets}>
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              className={styles.wallet}
              onClick={() => onSelect?.(wallet.id)}
            >
              {wallet.name}
            </button>
          ))}
        </div>
      ) : (
        <>
          <section className={styles.step} data-state="current">
            <div className={styles.stepHeader}>
              <span className={styles.stepNumber} aria-hidden="true">
                1
              </span>
              <h3>Connect wallet</h3>
              <IconArrowRight size={20} aria-hidden="true" />
            </div>
            <WalletAppLinks options={options} primaryRef={primary} />
          </section>
          <section className={styles.step} data-state="locked">
            <div className={styles.stepHeader}>
              <span className={styles.stepNumber} aria-hidden="true">
                2
              </span>
              <h3>Sign to verify</h3>
              <IconLock size={18} aria-hidden="true" />
            </div>
            <p className={styles.stepHint}>Connect in your wallet app first.</p>
          </section>
        </>
      )}
    </dialog>
  );
}
