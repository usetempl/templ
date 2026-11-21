import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import type { Capability } from "@templ/chat/availability";
import { getChatChain } from "@templ/chat/chains";
import { PRODUCT_CHECKOUT_OPTIONS } from "@templ/chat/product-payment";
import { PRODUCT_STANDARD_PRICES } from "@templ/chat/plans";
import { getRelease, SITE, railOpen } from "@/lib/config";
import { capabilities } from "@/lib/current-capabilities";
import { PAYMENT_RECIPIENTS } from "@/lib/release-public";
import { PUBLIC_LABELS, STATE_LABELS } from "@/lib/availability-labels";
import {
  capabilityVerified,
  WIDGET_WALLET_SUPPORT,
} from "@/lib/support-availability";
import { WorksToday } from "@/components/works-today";
import { formatUsd } from "@/lib/product-format";
import styles from "./availability.module.css";

export const metadata = {
  title: "Feature availability",
  description:
    "Current availability for the support widget, team inbox and billing.",
};

function groupOf(row: Capability): string {
  const prefix = row.id.split(".")[0];
  return (
    {
      accounts: "Accounts",
      plans: "Billing",
      conversations: "Support",
      agents: "AI agents",
    }[prefix] ?? "Other"
  );
}

/** Public release facts use the same evidence-backed flags as the app. */
export default async function AvailabilityPage() {
  const RELEASE = await getRelease();
  const CAPABILITIES = capabilities(RELEASE, PAYMENT_RECIPIENTS);
  const SUPPORT_NOTIFICATIONS_VERIFIED = capabilityVerified(
    "SUPPORT_NOTIFICATIONS_VERIFIED",
    RELEASE,
  );
  const groups = new Map<string, Capability[]>();
  const supportCapabilities = CAPABILITIES.filter((row) =>
    ["accounts", "plans", "conversations", "agents"].includes(
      row.id.split(".")[0],
    ),
  );
  for (const row of supportCapabilities) {
    const key = groupOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          <IconArrowLeft aria-hidden="true" /> Back to Templ
        </Link>
        <h1>Feature availability</h1>
        <p>
          The tables show what is available and what still needs checks.{" "}
          <Link href="/api/status">App status</Link> has the full record.
        </p>
      </header>
      <WorksToday />
      <section className={styles.section} aria-labelledby="availability-widget">
        <h2 id="availability-widget">Wallet support widget</h2>
        <p data-widget-available={RELEASE.supportWidgetVerified}>
          {RELEASE.supportWidgetVerified
            ? "The widget is available on public HTTPS websites."
            : "The widget is being verified and is not available yet."}{" "}
          Visitors can ask without a wallet unless the team requires one.
          Signing in uses the wallet already connected to your app. Users
          approve a separate sign-in message.
          {RELEASE.supportWidgetSolanaVerified &&
            " EVM and Solana wallets can sign in."}
          {WIDGET_WALLET_SUPPORT === "eoa-only" &&
            " Sign-in supports standard EVM wallets (EOAs). Smart-wallet signatures are not supported yet."}
        </p>
        <a href={`${SITE.docs}/install`}>Install the widget</a>
      </section>
      {[...groups.entries()].map(([group, rows]) => (
        <section
          key={group}
          className={styles.section}
          aria-labelledby={`availability-${group.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <h2 id={`availability-${group.toLowerCase().replace(/\s+/g, "-")}`}>
            {group}
          </h2>
          {group === "Support" && (
            <p>
              {RELEASE.supportWorkflowVerified
                ? "The team inbox includes assignment, internal notes, saved replies, status and reporting."
                : "The team inbox's assignment, internal notes, saved replies, status and reporting are being verified."}{" "}
              Private screenshots and exports check current access.{" "}
              {RELEASE.mediaStorageVerified
                ? "Storage isolation, deletion, retention and cost checks have passed."
                : "Storage isolation, deletion, retention and cost verification are still pending."}{" "}
              {!SUPPORT_NOTIFICATIONS_VERIFIED &&
                "Email alerts are not available yet. Users see replies when they open the case again. Your team checks the Templ inbox."}
            </p>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Status</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-capability={row.id}>
                  <th scope="row">{row.label}</th>
                  <td>
                    <span className={styles.badge} data-public={row.public}>
                      {PUBLIC_LABELS[row.public]}
                    </span>
                  </td>
                  <td>
                    {row.chains ? (
                      <ul className={styles.chains}>
                        {row.chains.map((chain) => (
                          <li key={chain.chainId}>
                            <strong>{chain.name}</strong>:{" "}
                            {STATE_LABELS[chain.state]}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      STATE_LABELS[row.state]
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <section
        className={styles.section}
        aria-labelledby="availability-checkout"
      >
        <h2 id="availability-checkout">Payments per network</h2>
        <p>
          The Templ Hosted Plus plan costs{" "}
          {formatUsd(PRODUCT_STANDARD_PRICES.workspaceMonthlyUsdCents)} per
          month. Each month includes{" "}
          {PRODUCT_STANDARD_PRICES.includedAnsweredCasesPerMonth} answered cases
          and {formatUsd(PRODUCT_STANDARD_PRICES.includedAiCreditUsdCents)} in
          AI credit. New workspaces can choose Starter. Select a verified payment network in Plan &amp; usage. Each
          payment starts one month; renewal needs another payment.{" "}
          <a href={`${SITE.docs}/pricing`}>Read pricing</a>.
        </p>
        <ul className={styles.purchase}>
          {/* Each token and network has its own payment gate. */}
          {PRODUCT_CHECKOUT_OPTIONS.map(({ network, symbol }) => {
            const payable = railOpen(RELEASE, network, symbol);
            return (
              <li key={`${network}:${symbol}`} data-chain={network}>
                {symbol} on{" "}
                {network === "solana" ? "Solana" : getChatChain(network).name}:{" "}
                {payable ? "open" : "not open yet"}.
              </li>
            );
          })}
        </ul>
      </section>
      {RELEASE.cardBillingVerified && (
        <section className={styles.section} aria-labelledby="availability-card">
          <h2 id="availability-card">Monthly card invoices</h2>
          <p>
            {RELEASE.cardBillingVerified
              ? "Monthly card billing is available."
              : "Monthly card billing is not available yet."}{" "}
            Stripe bills final resolved cases each month at the same graduated
            price. You save and manage your card on Stripe&apos;s hosted pages.
            Templ never handles card numbers. Verified signed webhooks confirm
            payment status. Returning from Stripe grants no payment coverage.
          </p>
        </section>
      )}
      <section className={styles.section} aria-labelledby="availability-more">
        <h2 id="availability-more">More</h2>
        <ul className={styles.purchase}>
          <li>
            <a href={`${SITE.docs}/pricing`}>Support pricing</a>
          </li>
          <li>
            <a href={`${SITE.docs}/developers/widget`}>Widget integration</a>
          </li>
          <li>
            <Link href="/api/status">Machine-readable status</Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
