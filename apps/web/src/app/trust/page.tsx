import Link from "next/link";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { TalkToTempl } from "@/components/talk-to-templ";
import { listText, OPERATOR, operatorDetails } from "@/lib/operator";
import {
  ACTIVITY_LOG_GAPS,
  ACTIVITY_LOG_RECORDS,
  PROVIDER_STATUS_LABELS,
  providers,
  RETENTION,
  WIDGET_SOLANA_ADAPTER_METHODS,
  WIDGET_SOLANA_WALLET_FEATURES,
  WIDGET_WALLET_METHODS,
} from "@/lib/trust-facts";
import { ACCESS_AUDIT_RETENTION, AUDIT_RETENTION } from "@templ/chat/audit";
import { CORPUS_LIMITS } from "@templ/chat/plans";
import { getRelease } from "@/lib/config";
import styles from "./trust.module.css";

export const metadata = {
  title: "Trust",
  description:
    "What Templ never does, who can read a case, which providers get data and how long it stays.",
};

const days = (ms: number) => Math.round(ms / 86_400_000);
export default async function TrustPage() {
  const RELEASE = await getRelease();
  return (
    <PolicyPage
      title="Trust"
      description="What Templ never does, who can read a case, who gets your data and how long it stays."
      active="trust"
      updated="27 November 2026"
    >
      <PolicySection title="What Templ never does" id="never">
        <p>Support messages cannot move funds or ask your wallet to sign.</p>
        <ul>
          <li>Templ never asks for a private key or recovery phrase.</li>
          <li>
            In chat, you can sign a message to show support that you control a wallet address. This does not sign you in to Templ or send a transaction.
          </li>
          {RELEASE.bitcoinAccountSignInVerified && (
            <li>
              To sign in with Bitcoin, use the sign-in button and approve a separate message in your wallet.
            </li>
          )}
          <li>
            A support message can&apos;t start a signature, an approval or a
            transaction.
          </li>
        </ul>
        <p>
          {
            "Templ refuses recovery phrases and the private key formats it recognizes. A 64-character hex value can be a transaction hash or a private key. Templ hides it from bots, webhooks, AI and exports unless the user shared it as a transaction. The user and your team still see it in the chat until someone redacts it."
          }
        </p>
        <div className={styles.note}>
          <p>
            With an EVM wallet, the widget calls {WIDGET_WALLET_METHODS.length}{" "}
            wallet methods: {listText(WIDGET_WALLET_METHODS)}.
          </p>
          {RELEASE.supportWidgetSolanaVerified ? (
            <p>
              With a Solana wallet, the widget uses these Wallet Standard
              features: {listText(WIDGET_SOLANA_WALLET_FEATURES)}. A wallet
              adapter uses {listText(WIDGET_SOLANA_ADAPTER_METHODS)}.
            </p>
          ) : (
            <p>Solana wallets cannot sign in to the widget yet.</p>
          )}
          {!RELEASE.solana.signIn && (
            <p>Solana wallets cannot sign in to the Templ app yet.</p>
          )}
          <p>
            Signing in costs nothing and moves no funds. Templ&apos;s servers
            only read public blockchain data, such as balances, receipts and
            logs. They refuse any request that would send a transaction.
          </p>
        </div>
      </PolicySection>
      <PolicySection title="Who can read a case" id="access">
        <p>Every read checks who can access that case now.</p>
        <ul>
          <li>The person who asked</li>
          <li>The workspace manager</li>
          <li>Staff and AI agents the manager gives support access</li>
        </ul>
        <div className={styles.note}>
          <p>
            Assignment, payments, names and badges grant no case access. Staff
            access and support setting changes need a signed-in authorized account
            and confirmation. Owner and billing changes need a wallet session. Removing someone&apos;s access cuts them off from
            history, notes, screenshots, search and exports.
          </p>
          <p>
            Templ’s servers process Standard chat messages. In a
            customer-controlled encrypted chat, approved endpoints use the workspace’s
            keys to read messages. The customer controls its recovery keys and
            backups. For Templ’s own encrypted support, Templ operates the team
            and recovery service. An authorized AI endpoint can share permitted
            content with its model provider. With AI off, agents cannot read or
            work on the case. Earlier messages keep their original protection.
          </p>
        </div>
      </PolicySection>
      <PolicySection title="What Templ's operators see" id="operators">
        <p>
          Templ&apos;s operator pages cannot open your workspace&apos;s cases.
        </p>
        <p>
          Operators see cost totals, onboarding counts and a workspace list. The
          list has each workspace&apos;s name, manager, creation date and
          visibility. Operators also review safety reports, which carry a copy
          of the reported message. No app page or route lets operators open a
          workspace&apos;s cases.
        </p>
        {RELEASE.supportCorpusVerified && (
          <p>
            At most {CORPUS_LIMITS.readers} named Templ readers can read
            de-identified copies of finished cases. This access never opens your
            private cases. Read what these copies keep and remove in{" "}
            <Link href="/privacy#improvement">Privacy</Link>.
          </p>
        )}
      </PolicySection>
      <PolicySection title="Service providers" id="providers">
        <p>These providers receive only the data listed for their work.</p>
        <p>
          A service can be live for one workspace while another uses a different provider or has AI off.{" "}
          <Link href="/availability">Feature availability</Link> lists every
          feature and whether it&apos;s on.
        </p>
        <p>When you ask the Crypto Help Desk to check a wallet or transaction, Templ sends the public address or transaction ID to the services it uses for that network. These include mempool.space, Blockstream, Blockscout, dRPC, PublicNode and Solana’s public RPC. They do not receive your chat messages.</p>
        <ul className={styles.providers}>
          <li className={styles.provider}>
            <div className={styles.providerHead}><strong>Plausible</strong></div>
            <p className={styles.line}>
              Plausible counts visits to the landing page, chat and workspace dashboard. It briefly processes IP addresses and browser details. It receives a generic page name.
            </p>
          </li>
          {providers(RELEASE).map((provider) => (
            <li key={provider.id} className={styles.provider}>
              <div className={styles.providerHead}>
                <strong>{provider.name}</strong>
                <span className={styles.status} data-status={provider.status}>
                  {PROVIDER_STATUS_LABELS[provider.status]}
                </span>
              </div>
              <p className={styles.line}>{provider.purpose}</p>
              <p className={styles.line}>Receives: {provider.data}</p>
            </li>
          ))}
        </ul>
      </PolicySection>
      <PolicySection title="How long data stays" id="retention">
        <p>Templ keeps data for the times listed below.</p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">How long</th>
              </tr>
            </thead>
            <tbody>
              {RETENTION.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.what}</th>
                  <td>{row.howLong}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          When Templ cannot check legal holds, it stops deleting cases. It
          checks again 1 hour later. Cloudflare keeps its backups and logs on
          its own schedule. Templ has not finished checking those settings.
        </p>
      </PolicySection>
      <PolicySection title="Activity log" id="activity">
        <p>The manager can see who changed access or worked on a case.</p>
        <p>
          Each workspace keeps an activity log in 2 parts. An entry says who did
          it and when, never message text. Only the manager can read the log.
        </p>
        <p>Access changes cover:</p>
        <ul>
          {ACTIVITY_LOG_RECORDS.access.map((record) => (
            <li key={record.text}>{record.text}</li>
          ))}
        </ul>
        <p>Case activity covers:</p>
        <ul>
          {ACTIVITY_LOG_RECORDS.chats.map((record) => (
            <li key={record.text}>{record.text}</li>
          ))}
        </ul>
        <p>
          Templ keeps up to{" "}
          {ACCESS_AUDIT_RETENTION.count.toLocaleString("en-US")} access changes
          from the last {days(ACCESS_AUDIT_RETENTION.ms)} days. It keeps up to{" "}
          {AUDIT_RETENTION.count.toLocaleString("en-US")} case entries from the
          last {days(AUDIT_RETENTION.ms)} days. New entries remove older ones.
          The log does not record {listText(ACTIVITY_LOG_GAPS, "or")} yet.
        </p>
      </PolicySection>
      <PolicySection title="Who runs Templ" id="operator">
        <p>These are the operator details Templ can confirm today.</p>
        <dl className={styles.details}>
          {operatorDetails(OPERATOR).map((detail) => (
            <div key={detail.key}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      </PolicySection>
      <PolicySection title="Ask about your data" id="data-requests">
        <p>Ask Templ to help you access, correct or delete your data.</p>
        <p>
          You can read your own chats, stop team messages and remove extra
          wallets from your account yourself. Deleting an account or a workspace
          isn&apos;t self-serve yet.
        </p>
        <p>
          For a copy of your data, a correction, a deletion or any other data
          question, ask us. A person on the Templ team answers.
        </p>
        <div className={styles.actions}>
          <TalkToTempl
            topic="privacy"
            label="Ask about your data"
            className={styles.action}
          >
            Ask about your data
          </TalkToTempl>
        </div>
        <p>
          Legal requests and notices required by law go through{" "}
          <Link href="/safety">Safety</Link>.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
