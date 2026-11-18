"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { readAccountMethods } from "@/lib/account-methods";

/** The identity store supplies the choices; the worker checks proof again. */
export function CheckoutPaymentPayer({
  principal,
  network,
  value,
  onChange,
  disabled,
}: {
  principal: ChatPrincipalId | undefined;
  network: "evm" | "solana";
  value: string | undefined;
  onChange: (address: string | undefined) => void;
  disabled: boolean;
}) {
  const [loaded, setLoaded] = useState<{
    key: string;
    wallets?: string[];
    failed?: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  const key = `${principal}:${network}:${attempt}`;
  useEffect(() => {
    if (!principal) return;
    const controller = new AbortController();
    void readAccountMethods(principal, controller.signal).then(
      (account) => {
        if (controller.signal.aborted) return;
        const methods =
          network === "solana"
            ? account.methods.solanaWallets
            : account.methods.wallets;
        const wallets = methods
          .slice()
          .sort((a, b) => Number(b.current) - Number(a.current))
          .map((wallet) => wallet.address);
        setLoaded({ key, wallets });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ key, failed: true });
      },
    );
    return () => controller.abort();
  }, [principal, network, key]);
  const current = loaded?.key === key ? loaded : undefined;
  useEffect(() => {
    if (!current?.wallets) return;
    if (value && current.wallets.includes(value)) return;
    onChange(current.wallets[0]);
  }, [current, value, onChange]);
  if (!current) return <p role="status">Reading your wallets…</p>;
  if (current.failed)
    return (
      <p role="alert">
        Your wallets could not load.{" "}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAttempt((v) => v + 1)}
        >
          Try again
        </button>
      </p>
    );
  if (!current.wallets?.length)
    return (
      <p>
        Link a wallet to pay on this network.{" "}
        <Link href="/settings/wallets">Manage wallets</Link>
      </p>
    );
  return (
    <label>
      Pay from{" "}
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {current.wallets.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
    </label>
  );
}
