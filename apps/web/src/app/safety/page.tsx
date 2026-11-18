import { SafetyReportForm } from "@/components/safety-report-form";
import Link from "next/link";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { TalkToTempl } from "@/components/talk-to-templ";
import { OPERATOR } from "@/lib/operator";
import { getRelease } from "@/lib/config";

export const metadata = {
  title: "Safety",
  description: "Legal requests, required notices, urgent reports and appeals.",
};

export default async function SafetyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const RELEASE = await getRelease();
  const query = await searchParams;
  const value = (key: string) =>
    typeof query[key] === "string" ? query[key] : undefined;
  return (
    <PolicyPage
      title="Safety"
      description="Keep your keys secret. Review data before sending. Your team controls case access. Templ checks legal authority before acting. Use the Safety form for legal requests, required notices, urgent reports and appeals."
      active="safety"
    >
      <SafetyReportForm
        key={[
          value("room"),
          value("channel"),
          value("message"),
          value("attachment"),
          value("reason"),
          value("report"),
        ].join(":")}
        target={{
          room: value("room"),
          channel: value("channel"),
          message: value("message"),
          attachment: value("attachment"),
        }}
        initialReason={value("reason")}
        initialReportId={value("report")}
      />
      <PolicySection title="1. Who runs Templ">
        <p>
          {OPERATOR.legalName} runs Templ. Customers run their support
          workspaces.
        </p>
        <p>
          {OPERATOR.legalName} is a {OPERATOR.companyType}, company number{" "}
          {OPERATOR.registration}. It registered on {OPERATOR.registeredOn}. Its
          registered and mailing address is {OPERATOR.address}.
        </p>
        <p>
          A Customer is the team that uses Templ for support. A user asks that
          team for help through Templ. Customers usually supply the people who
          answer. A signed order form may include done-for-you work by Templ
          staff. They act under Customer instructions after its manager grants
          explicit team access.
        </p>
        <p>
          Read the <Link href="/terms">Terms</Link>,{" "}
          <Link href="/privacy">Privacy Policy</Link> and{" "}
          <Link href="/dpa">DPA</Link> with these rules.
        </p>
      </PolicySection>
      <PolicySection title="2. Protect your wallet">
        <p>Keep keys secret. Use the sign-in card to prove wallet control.</p>
        <p>
          Never share a private key, recovery phrase or seed phrase. Templ and
          authorized staff must never ask for them. Keep them out of messages,
          screenshots, files and knowledge sources.
        </p>
        <p>
          Wallet sign-in uses an authentication message. Check the website,
          wallet and message before signing. Use the sign-in card. A sign-in
          proof authorizes no payment, token approval or transaction. It does
          not prove your name or company authority.
        </p>
        <p>
          Templ binds each challenge to its domain, URI, chain, nonce and
          expiry. Widget challenges also bind the workspace.{" "}
          {RELEASE.supportWidgetSolanaVerified &&
            "Sign In With Solana names Solana mainnet. "}
          Nonces are single-use. Templ checks replay, expiry and revocation.
        </p>
        <p>
          A connected wallet alone remains unverified. A wallet reported by the
          host app also remains unverified without proof. Email confirmation
          grants no wallet, team or app authority.
        </p>
        <p>
          Chat cannot start signing, token approvals or transfers. Staff may ask
          for a past public transaction hash or signature. That request does not
          ask you to sign anything new.
        </p>
      </PolicySection>
      <PolicySection title="3. Share case details">
        <p>Review what the team will receive before sending.</p>
        <p>
          Read the widget&#x27;s sharing notice. Remove unrelated personal
          details from text and screenshots. Share public transaction references
          only when they help your case.
        </p>
        <p>
          Templ screens messages for recognized private keys and recovery
          phrases before storage. Detection can miss secrets. Do not rely on it
          to protect data you send.
        </p>
        <p>
          Some hexadecimal values can be public references or secrets. Templ
          hides ambiguous values from AI, bots, webhooks and exports unless
          shared as typed transactions. The user and authorized team may still
          see them. A support lead can redact them.
        </p>
        <p>
          Wallet addresses and transaction references can reveal a person&#x27;s
          activity. Public blockchain records can be copied or linked to people.
          Templ cannot erase them or reverse a final transfer. Deleting a Templ
          case does not delete blockchain data.
        </p>
        <p>
          Privacy explains case retention, exports, legal holds and separate
          improvement copies. A de-identified copy may still be personal data.
        </p>
      </PolicySection>
      <PolicySection title="4. Case access">
        <p>Users read their own cases. Team members need current permission.</p>
        <p>
          A widget session belongs to one approved origin and workspace. It
          grants access only to that user&#x27;s thread. It grants no team
          access or general app session.
        </p>
        <p>
          A guest&#x27;s own session credential must redeem a wallet proof to
          link their thread. Someone else&#x27;s proof cannot take over that
          thread.
        </p>
        <p>
          Only the Customer manager grants team permissions. Templ&#x27;s
          done-for-you staff need that grant too. Payment, billing rights, token
          ownership and display names grant no case access. Ordinary assignment
          grants none.
        </p>
        <p>
          Specialists need a current qualifying follow-up or mention. Their
          access ends when that basis ends. They cannot reply to users or export
          cases.
        </p>
        <p>
          Templ checks current permission on private reads, writes, searches,
          files, exports and events. Newly authorized staff may read retained
          history within their role. Revoking access stops future access through
          Templ. It cannot retrieve copies someone already exported lawfully.
          User exports exclude internal notes.
        </p>
        <p>A legal report grants no team access and opens no Customer inbox.</p>
      </PolicySection>
      <PolicySection title="5. AI answers">
        <p>AI may be wrong. Ask the team when you need a person.</p>
        <p>
          AI can produce wrong, incomplete, biased or outdated answers. It may
          invent facts and sources. Check important instructions and relevant
          sources before acting.
        </p>
        <table>
          <caption>AI case modes</caption>
          <thead>
            <tr>
              <th scope="col">Case mode</th>
              <th scope="col">What the agent may do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>AI answers</td>
              <td>
                Send answers while the case&#x27;s reply and handoff rules allow
                it.
              </td>
            </tr>
            <tr>
              <td>AI drafts only</td>
              <td>
                Read the case and create internal drafts. It cannot send
                user-facing text.
              </td>
            </tr>
            <tr>
              <td>AI off</td>
              <td>
                It cannot read or act on the case through the agent interface.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          The Customer manages case modes. An agent cannot change its own mode.
          A person who sends a draft takes responsibility for that reply.
        </p>
        <p>
          You can ask for a person on your own thread. The request hands the
          case to the team. It adds no charge or permission. It promises no
          immediate reply or continuous staffing.
        </p>
        <p>
          Customers must supervise their agents and high-risk answers.
          Done-for-you staff follow agreed Customer instructions and scope.
        </p>
      </PolicySection>
      <PolicySection title="6. Checks and payments">
        <p>
          Transaction checks are read-only. Use payment instructions in the
          authenticated app.
        </p>
        <p>
          Checks explain available blockchain records. Providers or networks can
          delay them or return incomplete data. A check does not prove that a
          protocol, token, contract or wallet is safe.
        </p>
        <p>
          Templ holds no Customer or user private keys. It does not control
          their wallets or sign for them. It provides no custody, brokerage or
          exchange service. It provides no financial, investment, tax or legal
          advice.
        </p>
        <p>
          Stablecoin payments buy Templ services. Prepaid balance is service
          credit, not custody or an investment.
        </p>
        <p>
          Payments use the stablecoins and networks shown in the app. Supported
          tokens include USDC and USDT where official on configured EVM networks
          and Solana. Payments are direct stablecoin transfers. Each method
          stays closed until its release checks and verification pass. Pay to
          the address shown in the app. Chat cannot change that address or start
          a payment.
        </p>
        <p>
          Check the asset, network, address and amount before paying.
          Wrong-network or wrong-address transfers may be lost. A wallet
          signature or screenshot proves no receipt. The Terms explain verified
          credits, billing disputes and eligible refunds.
        </p>
      </PolicySection>
      <PolicySection title="7. Lawful use">
        <p>Do not use support access to harm people or bypass security.</p>
        <p>
          These rules apply to Customers, teams, agents, integrations and users.
          Do not:
        </p>
        <ul>
          <li>
            Ask for private keys, recovery phrases, seed phrases or stolen
            credentials.
          </li>
          <li>Use chat to start signing, token approvals or transactions.</li>
          <li>
            Impersonate a person, protocol, Templ employee or legal authority.
          </li>
          <li>
            Use phishing, fraud, malware, harassment, threats or child sexual
            exploitation material.
          </li>
          <li>
            Share another person&#x27;s private data without lawful authority.
          </li>
          <li>
            Read another user&#x27;s case or workspace without permission.
          </li>
          <li>
            Bypass grants, session limits, revocation, safety screens or a
            suspension.
          </li>
          <li>
            Use prompt injection to obtain secrets or unauthorized access.
          </li>
          <li>
            Disrupt the service, send spam or test systems without permission.
          </li>
          <li>Break applicable sanctions, export controls or other law.</li>
        </ul>
        <p>
          Customers must manage their team and agents. They need lawful rights
          to submitted content and user data. Customer instructions cannot
          override applicable law or Templ&#x27;s safety checks.
        </p>
      </PolicySection>
      <PolicySection title="8. Applicable sanctions">
        <p>
          Follow sanctions that apply to the people, location and service
          involved.
        </p>
        <p>
          Do not use Templ when an applicable sanction prohibits that service.
          Do not act for a prohibited person or evade applicable ownership,
          control or location restrictions. Tell Templ if a change makes your
          use unlawful.
        </p>
        <p>
          As a BVI company, {OPERATOR.legalName} follows sanctions in force in
          the British Virgin Islands. These include UK and UN measures extended
          there through applicable law. The{" "}
          <Link href="https://www.bvifsc.vg/international-sanctions/guidance-and-forms">
            BVI sanctions guidance
          </Link>{" "}
          explains that framework.
        </p>
        <p>
          US, UK and EU rules can apply through their own territorial and
          personal scope. Templ checks the law that applies and any valid
          exemption or licence. Crypto payments receive no exemption from
          applicable sanctions.
        </p>
        <p>
          Templ may request data needed to check a legal restriction. It may
          refuse prohibited service or payments. It may preserve or report data
          when law requires it. These rules promise no continuous screening or
          sanctions certification.
        </p>
      </PolicySection>
      <PolicySection title="9. Report routes">
        <p>
          Use the Safety form for its listed reports. Your team handles ordinary
          support.
        </p>
        <p>The form accepts:</p>
        <ul>
          <li>
            Requests from legal authorities. Identify the agency, official
            contact, instrument, jurisdiction and requested action.
          </li>
          <li>
            Notices required by law. Cite the law, provision, jurisdiction,
            content location and evidence. Include your name, contact email and
            good-faith statement.
          </li>
          <li>
            Child sexual exploitation or abuse reports. Give the exact location
            and facts. You may omit your name, email and legal citation.
          </li>
          <li>
            Immediate threats to life or serious injury. Give the exact location
            and facts. You may omit your name, email and legal citation.
          </li>
          <li>
            Appeals of platform decisions. Explain the error and include an
            earlier report ID if available.
          </li>
        </ul>
        <p>
          A mandatory notice needs no government authority unless its law
          requires one. Templ checks whether the claimed duty applies. The form
          accepts ordinary illegal-content claims only where an applicable law
          requires that intake. Customers handle protocol support, spam and
          ordinary case disputes in their own workspaces.
        </p>
        <p>
          Do not upload, copy or send illegal sexual material. Do not include
          keys, invitation secrets or unrelated personal data. A message report
          can capture only stored content the reporter may currently read.
        </p>
      </PolicySection>
      <PolicySection title="10. Verified review">
        <p>
          A receipt confirms intake. It grants no access and proves no claim.
        </p>
        <p>
          An operator checks claimed authority through independent official
          sources. The operator checks the contact, instrument, legal basis,
          jurisdiction and scope. An official-looking email or title proves no
          authority.
        </p>
        <p>
          A new legal hold or Safety suspension needs stored validation. It must
          establish competent authority, an applicable notice duty or an urgent
          legal duty. Ordinary reports and appeals cannot authorize a new
          restriction. Report volume alone decides nothing.
        </p>
        <p>
          No report automatically discloses private data, grants access or
          restricts anyone. Preservation and disclosure need separate authorized
          legal review. Applicable emergency and reporting duties remain.
        </p>
        <p>
          When acting as a processor, Templ follows the DPA&#x27;s notice and
          instruction rules. It tells the Customer about binding disclosure
          demands unless law prohibits notice. It limits disclosure to the valid
          duty&#x27;s scope.
        </p>
        <p>
          Templ may restrict a workspace, account or file where verified
          authority or applicable law requires it. Restrictions cannot rewrite
          blockchain records. Existing recipients may retain lawful copies.
        </p>
      </PolicySection>
      <PolicySection title="11. Retention and appeals">
        <p>
          Routine reports expire after 90 days. Documented legal duties may
          require longer retention.
        </p>
        <p>
          Routine reports stay for 90 days. Documented legal holds and active
          enforcement can require longer retention. Active enforcement carries a
          30-day review marker. It does not promise that a restriction ends
          after 30 days.
        </p>
        <p>
          A message report can preserve a restricted review copy after the
          original is deleted. Its legal basis and scope limit preservation.
          Legal holds never extend improvement or evaluation copy retention.
        </p>
        <p>
          Choose the appeal option to request review. Explain the error and
          provide relevant new facts. An operator reviews the original decision
          before restoring access. Do not create another account to bypass it.
        </p>
        <p>
          Payment does not excuse prohibited conduct or prevent lawful
          restrictions. A restriction creates no automatic refund right. The
          Terms and mandatory law control remedies.
        </p>
      </PolicySection>
      <PolicySection title="12. Emergencies and contact">
        <p>
          Contact local emergency services for immediate danger. Use
          Templ&#x27;s widget for other help.
        </p>
        <p>
          Do not wait for Templ when someone faces immediate danger. Contact
          local emergency services. Templ offers no emergency dispatch,
          continuous monitoring, response deadline or fund recovery.
        </p>
        <p>
          <TalkToTempl label="Legal notices" topic="legal">
            Legal notices
          </TalkToTempl>{" "}
          opens Templ&#x27;s widget for legal questions or an unavailable Safety
          form. Formal legal notices may also go to {OPERATOR.legalContact}. Use{" "}
          <TalkToTempl label="Privacy requests" topic="privacy">
            Privacy requests
          </TalkToTempl>{" "}
          for data requests. These requests may also go to{" "}
          {OPERATOR.privacyContact}. Use{" "}
          <TalkToTempl label="Security reports" topic="security">
            Security reports
          </TalkToTempl>{" "}
          for vulnerability reports. These reports may also go to{" "}
          {OPERATOR.securityContact}.
        </p>
        <p>
          Give enough facts to locate the issue. Do not test other people&#x27;s
          data or disrupt the service. This page grants no testing permission
          and promises no bounty. Ordinary protocol questions go to that
          protocol&#x27;s team.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
