"use client";

import { useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/loading-state";
import styles from "@/components/account-methods.module.css";
import { useChatAuth } from "@/lib/chat-auth";
import { previewBitcoinAccount, verifyBitcoinPreview } from "@/lib/community-auth";
import { connectBitcoinWallet } from "@/lib/bitcoin-wallet";

export function BitcoinPreviewPanel({
  workspaceId, workerVersion,
}: { workspaceId: string; workerVersion: string }) {
  const { session, restoring } = useChatAuth();
  const principal = session?.principalId;
  const [eligibleFor, setEligibleFor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const key = JSON.stringify([principal, workspaceId, workerVersion]);
  useEffect(() => {
    if (!principal) return;
    const controller = new AbortController();
    void verifyBitcoinPreview({ expectedPrincipalId: principal, workspaceId, workerVersion }, controller.signal)
      .then(eligible => { if (!controller.signal.aborted) setEligibleFor(eligible ? key : undefined); })
      .catch(() => { if (!controller.signal.aborted) setEligibleFor(undefined); });
    return () => controller.abort();
  }, [principal, workspaceId, workerVersion, key]);

  async function run(action: "add" | "sign-in") {
    if (eligibleFor !== key || !principal || pending) return;
    setPending(true);
    setMessage("");
    try {
      await previewBitcoinAccount(action, { expectedPrincipalId: principal, workspaceId, workerVersion },
        () => connectBitcoinWallet(action === "add" ? "attach" : "sign-in"));
      setMessage(action === "add" ? "Bitcoin wallet added." : "Signed in with Bitcoin.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className={styles.page}>
      <h1>Bitcoin sign-in preview</h1>
      {eligibleFor === key ? (
        <>
          <div className={styles.actions}>
            <button className={styles.secondary} disabled={pending} onClick={() => void run("add")}>Add a Bitcoin wallet</button>
            <button className={styles.secondary} disabled={pending} onClick={() => void run("sign-in")}>Sign in with Bitcoin</button>
          </div>
          <p role="status" className={styles.hint}>{pending ? <LoadingSpinner /> : message}</p>
        </>
      ) : restoring ? <LoadingSpinner /> : <p>Preview unavailable.</p>}
    </main>
  );
}
