import Link from "next/link";
import { SiteStatisticsPreference } from "@/components/site-statistics-preference";
import { CORPUS_LIMITS, PRODUCT_LIMITS } from "@templ/chat/plans";
import { EVAL_LIMITS } from "@templ/chat/support-eval";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { TalkToTempl } from "@/components/talk-to-templ";
import { SITE } from "@/lib/release-public";
import { OPERATOR } from "@/lib/operator";
import { getRelease } from "@/lib/config";
import { capabilityVerified } from "@/lib/support-availability";
import {
  ACCESS_AUDIT_RETENTION,
  AUDIT_RETENTION,
  READ_AUDIT_RETENTION,
} from "@templ/chat/audit";
import { FUNNEL_POLICY } from "@templ/chat/funnel";
import { ONBOARDING_POLICY } from "@templ/chat/onboarding";
import { SUPPORT_REFUSAL_POLICY } from "@templ/chat/support";
import { days, DEVICE_FACTS, WORKER_FACTS } from "@/lib/trust-facts";

export const metadata = {
  title: "Privacy",
  description:
    "How Templ uses personal data, who can read it and how long it stays.",
};

export default async function PrivacyPage() {
  const RELEASE = await getRelease();
  const SUPPORT_NOTIFICATIONS_VERIFIED = capabilityVerified(
    "SUPPORT_NOTIFICATIONS_VERIFIED",
    RELEASE,
  );
  return (
    <PolicyPage
      title="Privacy"
      description="How Templ uses and keeps the information you share."
      active="privacy"
      updated="27 November 2026"
    >
      <p>
        {
          "Your protocol team controls your support case. Templ runs support for that team. We also use account, billing and security data. Enabled AI may read your case. Improvement copies have separate rules and time limits. You can ask about your data for free."
        }
      </p>
      <PolicySection title="Report brand impersonation" id="impersonation">
        <p>
          If a Templ line impersonates your brand,{" "}
          <a href={SITE.origin + "/#support"}>message Templ Support</a> or{" "}
          <a href={`mailto:${OPERATOR.legalContact}?subject=Brand%20impersonation`}>email the team</a>{" "}
          with your official domain and the reported Templ link or name. We will
          give you a one-time code to publish on your website or in a DNS TXT record.
        </p>
        <p>
          Templ uses those details and the public proof to verify domain control,
          investigate the report and handle any appeal. A person decides the
          outcome. Our <Link href="#retention">retention periods</Link> apply to
          the support and enforcement records. See the{" "}
          <Link href="/terms#impersonation">hosted line takedown and refund terms</Link>.
        </p>
      </PolicySection>
      <PolicySection title="1. Who operates Templ" id="operator">
        <p>
          {
            "templ.fun Ltd operates Templ. This policy explains how Templ uses personal data."
          }
        </p>
        <p>
          {
            "templ.fun Ltd is a BVI Limited Company. Its company number is 2191511. It registered on 28 October 2025."
          }
        </p>
        <p>
          {
            "Its registered and mailing address is Quijano Chambers, P.O. Box 3159, Road Town, British Virgin Islands."
          }
        </p>
        <p>
          {
            "This policy covers Templ's app, support widget, API, docs and blog. Customer websites and wallets have their own notices."
          }
        </p>
        <p>
          {
            "“Customer” means the organization that runs a workspace. “User” means a person who asks that Customer for support. “Team” means the Customer's manager, staff and authorized AI agents. Personal data means information that identifies someone or can reasonably link to them."
          }
        </p>
        <p>
          {
            "Features can be enabled separately for each workspace. A description here does not activate a feature. Check your workspace's settings and "
          }
          <Link href="/availability">{"Feature availability"}</Link>
          {"."}
        </p>
      </PolicySection>
      <PolicySection title="2. Who controls your data" id="service">
        <p>
          {
            "Your Customer controls its support data. Templ processes that data for the Customer."
          }
        </p>
        <p>
          {
            "The Customer is the controller of user support data. Templ is its processor. We store, deliver and process that data under documented instructions. The "
          }
          <Link href="/dpa">{"Data Processing Addendum"}</Link>
          {" sets those duties."}
        </p>
        <p>
          {
            "This includes authorized AI answers, drafts and agreed done-for-you support. Templ staff answer for the Customer under its instructions. Its manager must explicitly grant each person's staff access. Buying a service grants no inbox access."
          }
        </p>
        <p>
          {
            "Templ controls its own account administration, billing, business measurement and direct support data. It also controls necessary platform security and verified legal-intake records. This role does not authorize other uses of private Customer cases."
          }
        </p>
        <p>
          {
            "When lawfully enabled, Templ controls the separate improvement purpose described in "
          }
          <Link href="#improvement">{"section 7"}</Link>
          {
            ". That role starts with its separate de-identification step. Accepting the DPA alone supplies no lawful basis for that purpose."
          }
        </p>
        <p>
          {
            "If the Customer acts for another controller, Templ acts as its subprocessor. The Customer must have authority to give instructions."
          }
        </p>
      </PolicySection>
      <PolicySection title="3. What data we receive" id="data">
        <p>
          {"We receive what you share and the records needed to run support."}
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Data"}</th>
              <th scope="col">{"Source and purpose"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Account and access records"}</td>
              <td>
                {
                  "You and your manager supply wallets, verified sign-in emails, sign-in proofs, account identifiers, chosen names and roles. We use them for sign-in and access checks."
                }
              </td>
            </tr>
            <tr>
              <td>{"User support data"}</td>
              <td>
                {
                  "Users and their team supply messages, screenshots, approved app context and shared transactions. We use them to deliver and answer cases."
                }
              </td>
            </tr>
            <tr>
              <td>{"Team support data"}</td>
              <td>
                {
                  "The team supplies internal notes, drafts, knowledge, case facts, follow-ups and reply reviews. We use them for that workspace's support."
                }
              </td>
            </tr>
            <tr>
              <td>{"Case activity"}</td>
              <td>
                {
                  "The service records times, status, handoffs, AI mode and authorized actions. We use these records to run cases and count resolved cases."
                }
              </td>
            </tr>
            <tr>
              <td>{"Billing data"}</td>
              <td>
                {
                  "Managers, order forms and blockchains supply payer wallets, tokens, amounts and transaction references. We verify transfers and record charges, credit and disputes."
                }
              </td>
            </tr>
            <tr>
              <td>{"Contact data"}</td>
              <td>
                {
                  "Users and managers supply optional emails, preferences and business contact details. We send enabled notices and answer requests."
                }
              </td>
            </tr>
            <tr>
              <td>{"Device and network data"}</td>
              <td>
                {
                  "Browsers and requests supply IP addresses, request metadata, browser information and session records. We deliver the service, prevent abuse and diagnose failures."
                }
              </td>
            </tr>
            <tr>
              <td>{"Service counts"}</td>
              <td>
                {
                  "The service counts fixed steps and failures. We use these counts to check service use and fix failures."
                }
              </td>
            </tr>
            <tr>
              <td>{"Legal and safety records"}</td>
              <td>
                {
                  "Reporters, authorities and operators supply requests, contact details, legal grounds and evidence references. We check authority and handle legal duties and appeals."
                }
              </td>
            </tr>
            <tr>
              <td>{"Improvement copies"}</td>
              <td>
                {
                  "Eligible cases supply cleaned messages, pseudonyms and limited case facts. Section 7 limits their creation and use."
                }
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          {
            "An account does not normally require your real name, phone number or identity document. A wallet address can still be personal data. We may need limited identity proof for a legal or privacy request."
          }
        </p>
        <p>
          {
            "Share only what the case needs. Never share private keys, recovery phrases, passwords or access codes. Free text and screenshots may contain sensitive data. Share sensitive data only where needed and lawfully permitted."
          }
        </p>
        <p>
          {
            "Public blockchain data comes from networks and RPC providers. Sharing a wallet or transaction may link that public data to your case. When you ask the Crypto Help Desk to check activity, you can paste any public address or use a wallet you already verified in that chat. Templ sends the address or transaction ID to a blockchain data provider. The AI uses the results to answer your question."
          }
        </p>
      </PolicySection>
      <PolicySection title="4. Why we use data" id="legal-bases">
        <p>
          {
            "Each use needs a lawful basis. Optional permissions cover only their stated purpose."
          }
        </p>
        <p>
          {
            "The Customer chooses lawful grounds for its support data. It must provide the notices and choices its users' laws require."
          }
        </p>
        <p>
          {
            "Where the EU GDPR or UK GDPR applies to Templ as controller, these bases apply:"
          }
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Purpose"}</th>
              <th scope="col">{"Legal basis"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Provide an individual account or requested support"}</td>
              <td>
                {
                  "Contract performance where you are personally a party. Otherwise, legitimate interests in serving users and business Customers."
                }
              </td>
            </tr>
            <tr>
              <td>{"Manage billing and Customer relationships"}</td>
              <td>
                {
                  "Legitimate interests in accurate billing and service administration. Contract performance where you are personally a party."
                }
              </td>
            </tr>
            <tr>
              <td>{"Protect access and investigate abuse"}</td>
              <td>
                {
                  "Legitimate interests in secure access and safe support. Legal obligation where an applicable EU or UK duty supports that basis."
                }
              </td>
            </tr>
            <tr>
              <td>
                {"Keep required records and answer mandatory legal requests"}
              </td>
              <td>
                {
                  "Compliance with applicable EU or UK legal obligations where that basis applies. Other duties require separate lawful grounds."
                }
              </td>
            </tr>
            <tr>
              <td>{"Send optional notices"}</td>
              <td>
                {
                  "Consent where required. Necessary service notices use the relevant account or Customer relationship basis."
                }
              </td>
            </tr>
            <tr>
              <td>{"Count service use"}</td>
              <td>
                {
                  "Legitimate interests in checking service performance. Consent where law requires it."
                }
              </td>
            </tr>
            <tr>
              <td>{"Optional third-party measurement"}</td>
              <td>{"Consent where required, before collection starts."}</td>
            </tr>
            <tr>
              <td>{"Address an urgent threat to life"}</td>
              <td>{"Vital interests where the law permits that use."}</td>
            </tr>
          </tbody>
        </table>
        <p>
          {
            "We must assess necessity and the effect on your rights before relying on legitimate interests. You can object to those uses."
          }
        </p>
        <p>
          {"The "}
          <a href="https://eservices.gov.vg/gazette/sites/eservices.gov.vg.gazette/files/newattachments/Act%20No.%203%20of%202021-Data%20Protection%20Act%2C%202021.pdf">
            {"BVI Data Protection Act, 2021"}
          </a>
          {
            " has been in force since 9 July 2021. Its consent rules and exceptions apply separately. A GDPR legitimate-interest basis does not replace BVI requirements."
          }
        </p>
        <p>
          {
            "You can withdraw consent through the relevant control or a privacy request. Withdrawal does not undo earlier lawful processing. Missing required data may prevent us from providing the relevant feature."
          }
        </p>
        <p>
          {
            "Improvement copying needs its own lawful grounds, notices and transfer safeguards. We must keep it off where those requirements are unmet. California restrictions in section 17 also apply."
          }
        </p>
      </PolicySection>
      <PolicySection title="5. Who can read your case" id="access">
        <p>
          {
            "Users see their own cases. Staff and agents need current permission to read private data."
          }
        </p>
        <p>
          {
            "A user can read their own case history. The manager and authorized staff can read retained cases their permissions cover. Newly authorized staff can read retained messages. Billing access, token ownership, names and ordinary case assignments grant no case access."
          }
        </p>
        <p>
          {
            "Specialists have access only through a qualifying follow-up or recent team mention. Their access covers that case alone. It ends when the condition or role ends. Specialists cannot reply to users, resolve, assign, export or search cases."
          }
        </p>
        <p>
          {
            "Every private read, write, search result, export, attachment and event checks current access. Internal notes, AI drafts and team case facts stay with the team. Member exports exclude internal notes and other team-only records."
          }
        </p>
        <p>
          {
            "Templ staff need the Customer manager's explicit staff grant to enter its inbox. This includes done-for-you support. Narrow infrastructure, security or legal processing follows the DPA or applicable law. It grants no ordinary support role."
          }
        </p>
        <p>
          {
            "Recipients can copy data they may read. Removing access cannot erase copies they already made. Customers remain responsible for those copies and their own providers."
          }
        </p>
      </PolicySection>
      <PolicySection title="6. How AI uses cases" id="workspace-improvement">
        <p>
          {
            "Enabled AI can read case content. A draft stays with the team until a person sends it."
          }
        </p>
        <p>
          {
            "Treat AI instructions and sources as public. An agent may quote them in replies to users. Do not add secrets or documents users must not see."
          }
        </p>
        <p>
          {
            "The Customer can authorize its own agent or an agreed Templ-managed agent. Each case has an enforced mode: AI answers, AI drafts only or AI off. The team controls that mode. Agents cannot change it themselves."
          }
        </p>
        <p>
          {
            "An authorized agent may receive permitted messages, knowledge and relevant shared transaction checks. It may also receive permitted team case facts. Customer-run agents may send this data to the Customer's model providers. The Customer must explain its own recipients and uses."
          }
        </p>
        <p>
          {
            "The new prepaid Templ AI service sends permitted case messages and approved knowledge to OpenAI through Cloudflare AI Gateway when a workspace enables it and meets its service requirements. An existing workspace follows its order and can use Anthropic for managed AI. Secret filters can miss content."
          }
        </p>
        <p>
          {
            "Templ uses OpenAI for its own support as controller. With AI off, agents cannot read or work on the case. Model providers do not receive improvement-store copies."
          }
        </p>
        <p>
          {
            "Enabled native Telegram integrations use the workspace's GPT agent to prepare reply drafts. It receives the member-visible conversation, relevant team replies and details the user shared. It receives no internal notes, other workspaces' cases or improvement copies. A current group administrator reviews and sends the reply."
          }
        </p>
        <p>
          {
            "A linked Telegram group receives case notices, human replies and reply drafts. Anyone in that group can read them. Customers control group membership and must review who can read these records. Removing Templ access does not remove copies in Telegram."
          }
        </p>
        <p>
          {
            "AI answers may be wrong, incomplete or out of date. Check answers before relying on them. A person decides whether to send a draft. You can ask the team for a person in your own case. That request adds no charge."
          }
        </p>
        <p>
          {
            "Chat and AI cannot sign transactions or transfer funds. Legal and privacy requests need a person. Customers must not use support AI for unlawful automated decisions."
          }
        </p>
        <p>
          {
            "The Customer may save de-identified evaluation cases inside its workspace. A person checks each copy before saving it. These copies can still contain personal data. They stay up to "
          }
          {EVAL_LIMITS.retentionDays}
          {
            " days after saving and may outlive the source case. A linked privacy request or workspace deletion removes them sooner. Legal holds never extend their retention."
          }
        </p>
        <p>
          {
            "Evaluation copies leave through authorized exports or agents the manager allows. Templ does not read them for its own improvement purpose. Templ trains no model on these copies or Customer support data."
          }
        </p>
        <p>
          {
            "Provider retention depends on the applicable agreement and settings. We do not promise zero provider retention. Managed model processing needs terms that prohibit training on Customer data. Customer-run model providers follow the Customer's separate arrangements."
          }
        </p>
      </PolicySection>
      <PolicySection title="7. How improvement copies work" id="improvement">
        <p>
          {
            "An eligible finished case may produce a de-identified copy. That copy remains personal data."
          }
        </p>
        <p>
          {RELEASE.supportCorpusVerified
            ? "Improvement copying is enabled under these rules."
            : "Templ does not make improvement copies yet."}{" "}
          <Link href="/availability">Feature availability</Link>
          {" shows public features."}
        </p>
        <p>
          {
            "Improvement copying has a separate release gate. Workspace feature flags do not enable it. The widget must show the notice before the opening message is sent. The notice links here, and its version stays with the case."
          }
        </p>
        <p>
          {
            "A case becomes eligible after resolution and its reopen window. Cases without a message for "
          }
          {CORPUS_LIMITS.idleDays}
          {
            " days may also become eligible. Tests, spam and cases under legal hold are excluded."
          }
        </p>
        <p>
          {
            "The workspace cleans text before sending it to the separate improvement store. The rules replace wallet addresses, transaction hashes and signatures, emails, ENS and SNS names, handles, phone numbers and IP addresses. They replace external links, exact dates, times, block numbers, long identifiers and the names they find. Amounts are rounded."
          }
        </p>
        <p>
          {"Writers receive stable pseudonyms within their workspace, such as "}
          <code>{"member-3f9a2c1b"}</code>
          {", "}
          <code>{"staff-7d10e4aa"}</code>
          {" and "}
          <code>{"ai-agent"}</code>
          {
            ". The copy holds no direct mapping back to those writers. It may hold cleaned messages, week, networks, sign-in level, resolution, handoff, labels and time ranges."
          }
        </p>
        <p>
          {
            "The copy excludes internal notes, screenshots, other files, account identifiers, wallets, website data and IP data. Cases with detected keys or recovery phrases keep no text. Messages with detected leftover identifiers are dropped."
          }
        </p>
        <p>
          {
            "The rules can miss an unusual name. Public blockchain facts can sometimes identify someone. De-identified copies can still identify people. Templ treats every copy as personal data."
          }
        </p>
        <p>
          {
            "Copies help Templ improve AI answers, rules and setup. They also help check resolution rules and review disputed charges. Copies never create or change a charge. Templ never uses them to profile or contact users. Templ never sells them or tries to identify people from them."
          }
        </p>
        <p>
          {
            "Copies go to no model provider. Templ trains and fine-tunes no model on them. Customer-authorized AI processing in section 6 is a separate use."
          }
        </p>
        <p>
          {"At most "}
          {CORPUS_LIMITS.readers}
          {
            " named Templ readers may read copies. Each needs a valid wallet sign-in and a stated purpose. Every read is logged. The workspace sees a monthly read count. Reader access cannot open raw private cases."
          }
        </p>
        <p>
          {"Copies stay at most "}
          {CORPUS_LIMITS.retentionDays}
          {
            " days after creation. Ordinary source-case deletion does not shorten that separate period. A legal hold never keeps a copy."
          }
        </p>
        <p>
          {"You can object for free at any time. Ask the team in your chat or "}
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {
            ". A manager or support lead records the request. It removes every improvement copy of your cases in that workspace. This includes copies whose source cases are gone. It also stops new copies of your cases there. Workspace deletion removes all its copies."
          }
        </p>
        <p>
          {
            "No product setting excludes a workspace. Only a signed custom contract does. That rule does not remove legal rights or required consent choices. Want a contract without this? "
          }
          <TalkToTempl topic="privacy" label="Talk to us">
            {"Talk to us"}
          </TalkToTempl>
          {"."}
        </p>
        <p>
          {
            "We do not assume these copies meet California's statutory definition of deidentified data. A controller label cannot bypass service-provider restrictions. Copying must remain off where its use would breach those restrictions."
          }
        </p>
      </PolicySection>
      <PolicySection title="8. Which providers receive data" id="providers">
        <p>
          {
            "Providers receive data needed for their task. Optional providers receive data only when their feature runs."
          }
        </p>
        <p>
          {"The "}
          <Link href="/dpa#subprocessors">{"subprocessor register"}</Link>
          {
            " sets the permitted purposes. Provider contracts, locations and transfer safeguards must cover the affected processing."
          }
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Provider"}</th>
              <th scope="col">{"Purpose and data"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Cloudflare"}</td>
              <td>
                {
                  "Runs hosting, API compute, databases, private screenshot storage, logs and security. Routes enabled model requests through AI Gateway, processing permitted inputs, outputs and usage metadata. It receives stored service data and request metadata. Optional Turnstile checks receive visitor-check data."
                }
              </td>
            </tr>
            <tr>
              <td>{"Alchemy and dRPC"}</td>
              <td>
                {
                  "Read public blockchain data from Templ's servers. They receive queried wallets, transactions and network details. They do not need private case text."
                }
              </td>
            </tr>
            <tr>
              <td>{"Helius and configured Solana RPC providers"}</td>
              <td>
                {
                  "Read public Solana accounts and transactions for enabled checks or payments. They receive public addresses, signatures and network details. They do not need private case text."
                }
              </td>
            </tr>
            <tr>
              <td>{"Anthropic"}</td>
              <td>
                {
                  "Processes permitted model input and output when an existing workspace order specifies Anthropic and managed AI is on. It receives no improvement-store copies."
                }
              </td>
            </tr>
            <tr>
              <td>{"OpenAI"}</td>
              <td>
                {
                  "Runs Templ's own support AI. OpenAI also processes permitted input and output for the new prepaid Templ AI service when enabled and applicable. Existing workspace orders govern their service. It receives no improvement-store copies."
                }
              </td>
            </tr>
            <tr>
              <td>{"Telegram"}</td>
              <td>
                {
                  "Delivers enabled case notices and reply drafts to the linked group. It receives selected case text, replies, drafts and case links. Group members can keep copies. Customers control group membership."
                }
              </td>
            </tr>
            <tr>
              <td>{"Resend"}</td>
              <td>
                {
                  "Sends enabled verification emails, notices and requested reply emails. It receives recipient addresses, codes and confirmation, resume or stop links. It receives no private message text."
                }
              </td>
            </tr>
            <tr>
              <td>Plausible Analytics</td>
              <td>Counts visits to three areas on usetempl.com. It receives a generic page name and uses the IP address and browser details briefly to count visitors each day.</td>
            </tr>
          </tbody>
        </table>
        <p>
          {
            "Enabled contract checks can query Sourcify, Blockscout or Etherscan. Those services receive public contract addresses and chain identifiers."
          }
        </p>
        <p>
          {
            "Customers can connect agents, alerts and signed webhooks. Their settings and access checks limit what reaches those destinations. Channel alerts contain fixed events, counts or waiting time and an authenticated link. They exclude message text, notes, tags, names, emails, wallets, transactions and amounts. A signed webhook may include wallets and shared transactions only when the manager turns that on."
          }
        </p>
        <p>
          {
            "We may disclose necessary records to professional advisers under confidentiality duties. Verified authorities receive data only on a lawful basis. A business transfer must preserve privacy duties and applicable user choices."
          }
        </p>
      </PolicySection>
      <PolicySection title="9. What stays on your device" id="device-storage">
        <p>
          {
            "Cookies and browser storage keep sessions and drafts. Clearing them may remove your route back to a guest case. If you choose a language in the Crypto Help Desk, your browser remembers it. Templ also keeps that choice with your latest message so the AI can reply in that language."
          }
        </p>
        <p>
          {
            "The app uses a secure, HttpOnly session cookie. App sessions last at most 30 days. The server stores a digest of the random session credential."
          }
        </p>
        <p>
          {
            "A guest widget saves a random support credential and case identifier on the Customer website. Its server record lasts 90 days. The browser copy stays until cleared or replaced, but stops working after 90 days."
          }
        </p>
        <p>
          {
            "A widget wallet session lasts at most 1 hour. Its token stays in that tab's session storage until the tab closes. Enabled remembered sign-in can renew sessions for up to 30 days after the wallet proof. Origin, workspace, expiry and revocation checks still apply. The widget uses no third-party sign-in cookie."
          }
        </p>
        <p>
          {
            "A wallet the app reports remains unverified. A guest shares that claim only by choosing it before sending. A separate wallet proof binds a case to a wallet."
          }
        </p>
        <p>
          {
            "The app saves unsent replies, internal-note drafts, retries and inbox preferences on your device. They remain separate by account, workspace and case. Current access is checked before restoring case drafts. Sign-out, an account change or revoked access clears those saved drafts. The app keeps at most "
          }
          {DEVICE_FACTS.appDraftEntries}
          {
            " entries. Entries older than 7 days are discarded when storage is checked."
          }
        </p>
        <p>
          {
            "The widget can save drafts and unfinished sends on the Customer website. The Customer can disable draft storage. Closing the widget or signing out can leave drafts saved. A confirmed send, Discard or clearing the text box removes them. Drafts older than 7 days are discarded when restored. Other scripts on that website can read its local storage."
          }
        </p>
        <p>
          Each IP address can open {WORKER_FACTS.guestChatsPerNetworkPerDay}{" "}
          guest cases a day in a workspace. Templ counts them with a keyed
          one-way hash. Its key stays secret on Templ&apos;s servers. A hash
          counts for {Math.round(WORKER_FACTS.guestNetworkWindowMs / 3_600_000)}{" "}
          hours. The workspace&apos;s next guest case removes older hashes.
        </p>
        <p>
          A user can choose Talk to a person in their chat. Templ saves the
          time, reason code, user and case. The team&apos;s activity list shows
          the user&apos;s account and the time. The case keeps the time and
          reason code. Only the team sees its AI mode. The AI agent&apos;s
          latest check-in stays in server memory. A restart clears it. The
          widget uses it to show “AI agent is typing”.
        </p>
        {SUPPORT_NOTIFICATIONS_VERIFIED ? (
          <>
            <p>
              Guests and signed-in users can ask for reply emails on their case.
              Templ keeps the email address and confirmation status with the
              case. Resend receives the address and links to confirm, resume or
              stop reply emails. The team sees only whether reply emails are on.
              Exports and de-identified copies exclude the address.
            </p>
            <p>
              Templ stores confirmation and reply link tokens as hashes. Each
              reply link works once, for 24 hours, for that workspace and case.
              Confirming or stopping reply emails requires pressing a button on
              the link&apos;s page. The stop button removes the address from the
              case. Deleting the case also removes it.
            </p>
            <p>
              Signed-in wallet accounts can add an email address for support
              alerts. Templ checks that address with a one-time code. Resend
              receives the address and code. Templ keeps the verified address
              private, with keyed lookup identifiers and verification records.
              Templ never stores the code as plain text. An alert address never
              signs in or merges accounts.
            </p>
          </>
        ) : (
          <p>
            The widget does not offer reply emails yet. Users check replies by
            opening their case.
          </p>
        )}
        <p>
          Email sign-in checks a one-time code for a separate account. Resend
          receives the address and code. Templ keeps the verified address
          private, with keyed lookup identifiers and verification records. The
          code lasts 5 minutes and is never stored as plain text. An alert
          address never signs in or merges accounts. You get workspace access
          when you accept your manager&apos;s team invitation or sign in with
          its invited email address.
        </p>
        <p>
          {
            "Reply-check timing can stay in browser storage for 1 day, without message text. A stored “still need help” choice stays until cleared. Sent case history stays in page memory. Lines after a send and AI presence stay in memory rather than saved records."
          }
        </p>
      </PolicySection>
      <PolicySection title="10. How we count service use" id="measurement">
        <p>
          If you turn on site statistics, we count visits to the landing page, support chat and workspace dashboard on usetempl.com.
          Every chat has the same label in our statistics. Every workspace does too.
          We send only that label to Plausible. We leave out the page you came from,
          the actual chat link, wallet addresses, email addresses and anything you type.
          We do not measure your steps through sign-in, onboarding or checkout.
        </p>
        <p>
          Plausible uses your IP address and browser details to count a visitor once per day
          on this site and estimate location and device type. It discards the raw IP address
          and browser details. It keeps a record of each visit under a daily identifier that changes the next day.
          We use no analytics cookies. Statistics are off by default. You can turn them off here at any time.
          We also honor Do Not Track and Global Privacy Control. Read <a href="https://plausible.io/data-policy">how Plausible counts visits</a>.
        </p>
        <p><SiteStatisticsPreference /></p>
        <p>Templ previously linked onboarding steps with a random cookie.
          Existing journey records expire after {ONBOARDING_POLICY.retentionDays} days.</p>
        <p>
          {
            "General service counts use daily totals and fixed step or failure codes. They carry no accounts, wallets, workspaces, message text, emails, addresses or URLs. These daily counts stay for "
          }
          {FUNNEL_POLICY.retentionDays}
          {" days. Their Cloudflare log lines stay up to 7 days."}
        </p>
        <p>
          Private operating records link resource use to a workspace. They
          record providers, models, usage counters, outcomes and times. Templ
          operators use them to reconcile costs against invoices. These records
          contain no case text, case identifiers, wallets, emails or private
          URLs.
        </p>
        <p>
          {
            "The widget loads no browser analytics code on the Customer website. That website may run its own analytics under its own notice."
          }
        </p>
        <p>
          {
            "Our measurement controls check Do Not Track and Global Privacy Control. We use no advertising signals or personalized advertising. Templ does not sell personal data or share it for cross-context behavioral advertising."
          }
        </p>
      </PolicySection>
      <PolicySection title="11. How payments use data" id="payments">
        <p>
          {
            "Stablecoin transfers are public. We keep billing records but cannot erase blockchain history."
          }
        </p>
        <p>
          {
            "Payments use the stablecoins and networks shown in the app. Supported tokens include USDC and USDT where official on configured EVM networks and Solana. Payments are direct stablecoin transfers. Each method stays closed until its release checks and verification pass. The app lists the enabled network, recipient and payer."
          }
        </p>
        <p>
          {
            "We record payer wallets, tokens, amounts, transaction references, workspace and verification status. Verified matching transfers credit the balance once. A redirect or wallet signature never credits it. Custom deals use payment requests tied to signed order forms. The same scanners verify their transfers."
          }
        </p>
        <p>
          {
            "Blockchain addresses, amounts and transaction history are generally public. A case may link them to you. Deleting a Templ record cannot erase the underlying chain record."
          }
        </p>
        <p>
          {
            "Templ does not control your wallet or request its private key. Chat cannot sign or send transactions. Wallet sign-in uses a separate authentication message. Templ provides support software and agreed services. It gives no financial, investment or tax advice."
          }
        </p>
        {RELEASE.cardBillingVerified && (
          <>
            <p>
              Stripe processes monthly card invoices. You save or update your
              card on Stripe&apos;s hosted pages. Stripe receives your card
              details. Templ never handles card numbers.
            </p>
            <p>
              Templ receives Stripe customer, subscription, price and invoice
              IDs. It also receives card brand, last 4 digits and invoice
              status. Verified signed Stripe webhooks supply the card details
              and payment status. Templ uses these records to bill resolved
              cases and answer billing questions.
            </p>
          </>
        )}
      </PolicySection>
      <PolicySection title="12. How long data stays" id="retention">
        <p>
          {
            "Different records have different time limits. Ending service does not automatically erase every record."
          }
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Record"}</th>
              <th scope="col">{"Retention and cleanup"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Resolved, abandoned and spam cases"}</td>
              <td>
                {"Deleted "}
                {PRODUCT_LIMITS.supportHistoryDays}
                {
                  " days after the last message, including notes, activity and screenshots. A valid legal hold can pause deletion."
                }
              </td>
            </tr>
            <tr>
              <td>{"Open cases"}</td>
              <td>{"Kept while open."}</td>
            </tr>
            <tr>
              <td>{"Case times, counts and flags"}</td>
              <td>
                {"Deleted with the case, or "}
                {PRODUCT_LIMITS.supportHistoryDays}
                {
                  " days after resolution if sooner. These records contain no message text."
                }
              </td>
            </tr>
            <tr>
              <td>{"Edited or deleted message evidence"}</td>
              <td>
                {"Up to "}
                {WORKER_FACTS.messageRevisions}
                {" earlier versions per message. Removed after "}
                {days(WORKER_FACTS.messageHistoryMs)}
                {" days when the workspace next edits or deletes a message."}
              </td>
            </tr>
            <tr>
              <td>{"Workspace evaluation copies"}</td>
              <td>
                {
                  "Up to 730 days after saving. A linked privacy request or workspace deletion removes them sooner."
                }
              </td>
            </tr>
            <tr>
              <td>{"Workspace evaluation runs"}</td>
              <td>
                {"Up to "}
                {EVAL_LIMITS.runRetentionDays}
                {" days. At most the newest "}
                {EVAL_LIMITS.runsKept}
                {" runs remain."}
              </td>
            </tr>
            <tr>
              <td>{"Improvement copies"}</td>
              <td>
                {"Up to "}
                {CORPUS_LIMITS.retentionDays}
                {
                  " days after creation. Objection, privacy request or workspace deletion removes them sooner."
                }
              </td>
            </tr>
            <tr>
              <td>{"Improvement read logs"}</td>
              <td>
                {"Up to "}
                {CORPUS_LIMITS.readLogDays}
                {
                  " days. These hold the reader and purpose rather than raw case text."
                }
              </td>
            </tr>
            <tr>
              <td>{"Access-change logs"}</td>
              <td>
                {"Up to "}
                {ACCESS_AUDIT_RETENTION.count.toLocaleString("en-US")}
                {" entries from the last "}
                {days(ACCESS_AUDIT_RETENTION.ms)}
                {" days. New entries remove older entries."}
              </td>
            </tr>
            <tr>
              <td>{"Case-action logs"}</td>
              <td>
                {"Up to "}
                {AUDIT_RETENTION.count.toLocaleString("en-US")}
                {" entries from the last "}
                {days(AUDIT_RETENTION.ms)}
                {" days. New entries remove older entries."}
              </td>
            </tr>
            <tr>
              <td>{"Enabled staff-read logs"}</td>
              <td>
                {"Up to "}
                {READ_AUDIT_RETENTION.count.toLocaleString("en-US")}
                {" entries from the last "}
                {days(READ_AUDIT_RETENTION.ms)}
                {
                  " days. They hold access metadata rather than message or search text."
                }
              </td>
            </tr>
            <tr>
              <td>{"Resolved-case charge details"}</td>
              <td>
                {
                  "Normally 400 days after resolution. Longer while awaiting final status or disputed. Monthly totals stay with the billing ledger. They hold times, state, price and a keyed account hash, without message text or wallets."
                }
              </td>
            </tr>
            <tr>
              <td>{"Refused-request and unapproved-widget counts"}</td>
              <td>
                {SUPPORT_REFUSAL_POLICY.retentionDays}
                {" days. Later relevant activity removes older counts."}
              </td>
            </tr>
            <tr>
              <td>{"Turned-away retry identifiers"}</td>
              <td>
                {"7 days. Later relevant activity removes older identifiers."}
              </td>
            </tr>
            <tr>
              <td>{"App sessions"}</td>
              <td>{"At most 30 days."}</td>
            </tr>
            <tr>
              <td>{"Widget sessions"}</td>
              <td>{"At most 1 hour."}</td>
            </tr>
            <tr>
              <td>{"Remembered widget credentials"}</td>
              <td>{"Up to 30 days after wallet proof, when enabled."}</td>
            </tr>
            <tr>
              <td>{"Sign-in challenges and email codes"}</td>
              <td>{"5 minutes."}</td>
            </tr>
            <tr>
              <td>{"Guest support credentials"}</td>
              <td>
                {
                  "90 days on the server. Browser copies may remain until cleared or replaced."
                }
              </td>
            </tr>
            <tr>
              <td>{"Keyed guest IP hashes"}</td>
              <td>
                {
                  "Count for 24 hours. The next guest case in that workspace removes older hashes."
                }
              </td>
            </tr>
            <tr>
              <td>{"Email abuse counters"}</td>
              <td>{"15-minute or 24-hour windows, followed by cleanup."}</td>
            </tr>
            <tr>
              <td>{"Case reply emails"}</td>
              <td>
                {
                  "Removed when stopped or when the case is deleted. Exports and de-identified copies exclude the email address."
                }
              </td>
            </tr>
            <tr>
              <td>{"Case reply links"}</td>
              <td>
                {
                  "Single use, valid for 24 hours. Stored as hashes and bound to the workspace and case."
                }
              </td>
            </tr>
            <tr>
              <td>{"Verified account alert emails"}</td>
              <td>
                {
                  "Kept until removed or a valid deletion request applies. Alert emails never sign in or merge accounts."
                }
              </td>
            </tr>
            <tr>
              <td>{"Verified email sign-in accounts"}</td>
              <td>
                {
                  "No automatic expiry is implemented. Retention depends on service needs and valid deletion requests."
                }
              </td>
            </tr>
            <tr>
              <td>{"Device drafts and retries"}</td>
              <td>
                {
                  "Usually 7 days, with the activity-based cleanup in section 9."
                }
              </td>
            </tr>
            <tr>
              <td>{"Routine legal and safety reports"}</td>
              <td>
                {days(WORKER_FACTS.reportMs)}
                {
                  " days. Relevant evidence can stay during a documented hold or active enforcement case."
                }
              </td>
            </tr>
            <tr>
              <td>{"Stored contact requests"}</td>
              <td>
                {PRODUCT_LIMITS.supportHistoryDays}
                {
                  " days after receipt. They may include account identifiers, protocol details, volume, team size, contact and request text. No page or API shows them."
                }
              </td>
            </tr>
            <tr>
              <td>{"Daily first-party service counts"}</td>
              <td>
                {FUNNEL_POLICY.retentionDays}
                {" days. Corresponding Cloudflare log lines stay up to 7 days."}
              </td>
            </tr>
            <tr>
              <td>{"Private workspace operating costs"}</td>
              <td>
                Attempt records stay up to 62 days. Daily totals stay up to 400
                days. Necessary invoice and accounting history remains
                separately.
              </td>
            </tr>
            <tr>
              <td>{"Workspace deletion actor records"}</td>
              <td>
                {
                  "Identifying actor details stay up to 730 days where workspace deletion is enabled. Necessary billing and legal records remain separately."
                }
              </td>
            </tr>
            <tr>
              <td>{"Privacy deletion and recovery audit records"}</td>
              <td>
                {
                  "Up to 400 days. They record deletion instructions and recovery actions needed to prevent deleted data returning."
                }
              </td>
            </tr>
            <tr>
              <td>
                {
                  "Account links, roles, settings, payment receipts and billing ledgers"
                }
              </td>
              <td>
                {
                  "No automatic expiry is implemented. Retention depends on service needs, valid requests and applicable accounting or legal duties."
                }
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Refused-request counts hold no names, wallets, IP addresses or
          websites. Managers, billing staff and support leads can see them.
          Later relevant activity removes expired counts and retry identifiers.
        </p>
        <p>
          {
            "Archiving hides a case from the default inbox. It changes neither billing nor retention. Resolving a case does not immediately delete it. Deleted content cannot be recovered through an export."
          }
        </p>
        <p>
          {
            "Some cleanup runs on later activity or in batches. A record may remain beyond its nominal age until cleanup runs. These cycles do not remove lawful storage limits or deletion duties. Provider logs and backups have separate technical cycles. We must restrict retained copies and honor valid deletion instructions after restoration."
          }
        </p>
        <p>
          {
            "The Customer can choose return or deletion of processor data under the DPA. Enabled workspace deletion closes access first. The manager has 7 days to cancel before batched deletion starts. A valid hold can preserve covered data. Where deletion is unavailable in the app, "
          }
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {"."}
        </p>
      </PolicySection>
      <PolicySection title="13. How legal holds work" id="legal-holds">
        <p>
          {
            "A report alone grants no access. We check authority and limit any disclosure or hold."
          }
        </p>
        <p>
          <Link href="/safety">{"Safety"}</Link>
          {
            " explains legal notices, urgent reports and appeals. Legal records may include names, organizations, emails, jurisdiction, legal grounds and evidence references. Signed-in reports may include an account identifier. A reported message copy contains only content the reporter could access."
          }
        </p>
        <p>
          {
            "Authorized Templ operators review the central queue. Workspace managers cannot read it. We independently verify official contacts, authority, legal instruments and scope. An intake receipt proves only receipt."
          }
        </p>
        <p>
          {
            "We preserve or disclose relevant data only on a valid legal basis. We limit its scope and notify the Customer where permitted and required. We do not automatically forward every report or all case history."
          }
        </p>
        <p>
          {
            "A documented hold can pause deletion of its covered case or workspace. It preserves only data that remains. It cannot recreate deleted data. Normal retention resumes when the hold ends. If holds cannot be checked, case deletion pauses until they can."
          }
        </p>
        <p>
          {
            "A hold does not extend the 90-day message-evidence clock. It never keeps improvement or evaluation copies beyond their rules. Active enforcement cases have a 30-day operator review date. That date promises no final closure or deletion."
          }
        </p>
      </PolicySection>
      <PolicySection title="14. How access stays private" id="security">
        <p>
          {
            "We check identity and current access. Templ servers process Standard messages. In a customer-controlled encrypted workspace, only approved endpoints with its keys can decrypt messages. On Templ's own encrypted support page, Templ operates the receiving team and its recovery service. An authorized AI endpoint can share permitted content with its model provider. Earlier cases keep their original protection."
          }
        </p>
        <p>
          {"On Templ's encrypted support page, your device keeps its message keys and encrypted drafts. A verified return link restores your support session, but cannot recover message keys by itself. Opening old history on another device needs approval from a device that can already read it. If you lose every approved device, you can start a separate request. Removing access stops future key grants; it cannot recall content or keys someone already received."}
        </p>
        <p>
          {"Customer-controlled encrypted mode keeps message and recovery keys outside Templ. The Customer controls its encryption service, approved readers and backups. Before enabling it, the workspace owner must acknowledge that losing all approved keys and backups can make old messages permanently unreadable. Templ cannot restore them. Templ's own support workspace is separate: Templ is the receiving team and operates that workspace's key service."}
        </p>
        <p>
          {
            "We use scoped sessions, origin and workspace checks, rate limits and private file permissions. Authorized service operations and approved providers can process content. No system can promise perfect security."
          }
        </p>
        <p>
          {
            "Wallet sign-in binds domain, URI, chain, nonce and expiry. Widget proofs also bind the intended workspace. Replay and revocation checks apply. A connected or app-reported address alone proves no ownership."
          }
        </p>
        <p>
          {
            "Sign-in alone never grants staff authority. Email sign-in verifies the mailbox for a separate account. Your manager's team invitation grants its role when you accept it or sign in with its invited email address. Email sign-in never merges accounts. An alert address verifies only a notice destination."
          }
        </p>
        <p>
          {
            "Staff and agent replies are screened for signing, approval and transaction requests. Recognized private keys and recovery phrases are refused before storage. Ambiguous values can still appear in the user's case and staff inbox. They are hidden from models, bots, webhooks, exports and copies unless shared as a typed transaction. Filters do not make sharing secrets safe."
          }
        </p>
        <p>
          {
            "We investigate personal-data breaches and notify affected Customers under the DPA. We notify regulators and people where law requires it. We claim no security certification or breach-free service."
          }
        </p>
      </PolicySection>
      <PolicySection title="15. Where data is processed" id="transfers">
        <p>
          {
            "Providers and authorized operations may process data in several countries. Restricted transfers need lawful safeguards first."
          }
        </p>
        <p>
          {
            "Templ is a BVI company. Approved providers may process data outside your country and the BVI. A signed order form must state any agreed residency commitment."
          }
        </p>
        <p>
          {
            "Restricted EEA transfers need an applicable lawful mechanism. This may be the EU Standard Contractual Clauses under Decision (EU) 2021/914. Restricted UK transfers may use the UK Addendum or International Data Transfer Agreement. Required terms, annexes and risk assessments must be completed before the affected transfer."
          }
        </p>
        <p>
          {
            "BVI transfer rules apply separately. Accepting the Terms is not blanket transfer consent. A provider policy alone does not establish lawful safeguards."
          }
        </p>
        <p>
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {
            " to request relevant safeguards and applicable terms. We protect confidential information while providing what the law requires."
          }
        </p>
      </PolicySection>
      <PolicySection title="16. How to ask about data" id="rights">
        <p>
          {
            "Ask your Customer about its support data. Ask Templ about data it controls."
          }
        </p>
        <p>
          {
            "For a case, start with the Customer team in your chat. We help that team respond under the DPA. You can also "
          }
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {
            ". We route processor requests to the Customer unless law requires another response."
          }
        </p>
        <p>
          {
            "For Templ-controlled data, you may ask for access, correction or deletion. Applicable law may also give portability, restriction, objection and consent-withdrawal rights. Improvement objections are free and need no special reason."
          }
        </p>
        <p>
          {
            "We may ask for limited proof to protect other people's data. We never ask for private keys, recovery phrases, payment or transaction signatures. We do not require a new account for a privacy request."
          }
        </p>
        <p>
          {
            "We answer within applicable legal deadlines. GDPR and UK GDPR requests generally require a response within 1 month. BVI access requests generally require a decision within 30 days, subject to lawful extensions. We explain lawful extensions, refusals or exceptions."
          }
        </p>
        <p>
          {
            "Required legal or billing records may have deletion exceptions. We explain those limits. We cannot erase blockchain history or copies others independently hold."
          }
        </p>
        <p>
          {
            "You may complain to your relevant data protection authority without contacting us first. UK users can contact the "
          }
          <a href="https://ico.org.uk/make-a-complaint/">
            {"Information Commissioner's Office"}
          </a>
          {
            ". EEA users can contact their local supervisory authority. BVI rights follow its applicable regulator and complaint procedures."
          }
        </p>
        <p>
          {
            "The privacy request email is privacy@usetempl.com. Our registered address in section 1 also accepts written requests."
          }
        </p>
      </PolicySection>
      <PolicySection title="17. California privacy rights" id="california">
        <p>
          {
            "California rights apply where the CCPA covers the processing. Templ's service-provider duties can apply below business thresholds."
          }
        </p>
        <p>
          {
            "The CCPA, as amended by the CPRA, can give access, correction, deletion and information rights. You may use an authorized agent, subject to reasonable checks. We do not discriminate against people who exercise those rights."
          }
        </p>
        <p>
          {
            "We do not sell personal information or share it for cross-context behavioral advertising. We do not use sensitive information to infer personal characteristics. Private messages may still contain sensitive personal information."
          }
        </p>
        <p>
          {
            "Collected categories include identifiers, customer records, commercial information, internet activity and information users share in cases. Case content may include other statutory categories, including sensitive personal information. Section 3 lists sources and purposes. Section 8 lists recipients. Section 12 lists retention periods and criteria."
          }
        </p>
        <p>
          {
            "Customer support information follows the DPA's service-provider or contractor restrictions. Those terms prohibit unauthorized combining, sale, sharing and uses outside the direct Customer relationship. Improvement copying cannot override them."
          }
        </p>
        <p>
          {"Use "}
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {
            " or the privacy request email in section 16. Covered access, correction and deletion requests generally receive acknowledgment within 10 business days. A substantive response is generally due within 45 calendar days. We explain any lawful extension."
          }
        </p>
        <p>
          {
            "We honor applicable opt-out preference signals for covered sale or sharing. Where relevant activity occurs, applicable law also gives sale, sharing and sensitive-use choices."
          }
        </p>
      </PolicySection>
      <PolicySection title="18. Children and policy changes" id="changes">
        <p>
          {
            "Customers must meet their users' privacy rules. We give notice of material changes to our own practices."
          }
        </p>
        <p>
          {
            "Templ provides business support software. Customers must meet applicable age, notice and parental-consent rules. We do not seek children's data for advertising or profiling. "
          }
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {
            " if a child may have shared data unlawfully. We work with the Customer to investigate and take lawful action."
          }
        </p>
        <p>
          {
            "We publish changes here and update the date. We notify Customers of material changes through the service or an available verified contact. New purposes need required notices and lawful grounds before they start. Continued use alone does not provide separately required privacy consent."
          }
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
