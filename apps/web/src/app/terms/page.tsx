import {
  CORPUS_LIMITS,
  PRODUCT_AI_ONLY_RESOLUTION_PRICE,
  PRODUCT_FOUNDING_CREDIT,
  PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
  PRODUCT_FREE_START,
  PRODUCT_LIMITS,
  PRODUCT_STARTER_PRICES,
  PRODUCT_STANDARD_PRICES,
  PRODUCT_RESOLUTION_PRICE,
  PRODUCT_RESOLUTION_RULES,
  PRODUCT_TOP_UP,
} from "@templ/chat/plans";
import {
  CUSTOM_PRICING_LINE,
  formatUsdCents,
  priceSteps,
} from "@templ/chat/resolution-copy";
import Link from "next/link";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { TalkToTempl } from "@/components/talk-to-templ";
import { OPERATOR } from "@/lib/operator";
import { SITE } from "@/lib/release-public";
import { getRelease } from "@/lib/config";

export const metadata = {
  title: "Terms",
  description: "Rules for using Templ support software.",
};

export default async function TermsPage() {
  const RELEASE = await getRelease();
  return (
    <PolicyPage
      title="Terms"
      description="Templ helps teams answer support cases. Customers pay agreed software fees. Users ask their team for help. Your manager controls team access. You control your wallet. These terms cover payments, data, service limits and disputes."
      active="terms"
      updated="27 November 2026"
    >
      <PolicySection title="Report brand impersonation" id="impersonation">
        <p>
          Is a hosted Templ line passing itself off as your brand?{" "}
          <a href={SITE.origin + "/#support"}>Message Templ Support</a> or{" "}
          <a href={`mailto:${OPERATOR.legalContact}?subject=Brand%20impersonation`}>email the team</a>{" "}
          with your official domain and the Templ link or name. Our team will give
          you a one-time code to publish on your website or in a DNS TXT record.
          A person checks your proof of domain control and reviews the reported line.
        </p>
        <p>
          If we confirm intentional impersonation, we take down the hosted line
          and end the offending workspace’s access. Its fees and unused paid
          credit are nonrefundable, except where a signed agreement or mandatory
          law requires a refund. You can <Link href="/safety">appeal through Safety</Link>.
          For existing customers, the notice rules in section 18 apply.
        </p>
      </PolicySection>
      <PolicySection title="1. Who agrees">
        <p>Customers buy the service. Users ask their team for help.</p>
        <p>
          {OPERATOR.legalName} runs Templ. It is a {OPERATOR.companyType},
          company number {OPERATOR.registration}. It registered on{" "}
          {OPERATOR.registeredOn}. Its registered and mailing address is{" "}
          {OPERATOR.address}.
        </p>
        <p>
          “Templ”, “we” and “us” mean {OPERATOR.legalName}. “Customer” means the
          organization that runs a support workspace. Its manager, team and
          registered AI agents act for it. “User” means someone who asks that
          team for help through Templ.
        </p>
        <p>
          These terms apply when you use Templ or sign an order form. You must
          be legally able to agree. A Customer representative must have
          authority to bind that Customer. Customers must supervise their
          authorized users. Customers must not design support for children
          without an agreed scope and required safeguards.
        </p>
        <p>
          Customers owe the service fees. Users owe Templ no resolved-case fee
          for asking for support. A user&#x27;s purchases from a protocol follow
          that protocol&#x27;s separate terms. A privacy notice does not create
          consent to optional data use.
        </p>
      </PolicySection>
      <PolicySection title="Templ Hosted plans">
        <p>
          This section applies to standard plans approved from October 16, 2026.
          It replaces conflicting commercial rules below. Existing approved
          access periods and signed agreements keep their prices, limits and
          billing rules.
        </p>
        <p>
          Create a workspace and test {PRODUCT_LIMITS.freeSupportTickets}{" "}
          tickets free. The free demo includes no Templ AI answers or drafts.
          After that, new tickets stop. Your team can finish existing tickets.
          Do not create more workspaces or accounts to bypass the free limit.
        </p>
        <p>
          Starter for new workspaces costs{" "}
          {formatUsdCents(PRODUCT_STARTER_PRICES.workspaceMonthlyUsdCents)}
          /month per workspace and includes all team members and{" "}
          {PRODUCT_STARTER_PRICES.includedAnsweredCasesPerMonth} answered cases.
          Each extra answered case costs{" "}
          {formatUsdCents(PRODUCT_STARTER_PRICES.additionalAnsweredCaseUsdCents)}.
          New orders include {formatUsdCents(PRODUCT_STARTER_PRICES.includedAiCreditUsdCents)} in Templ AI credit each month. Your workspace sets a monthly limit for extra AI use from its prepaid balance.
        </p>
        <p>
          Plus costs{" "}
          {formatUsdCents(PRODUCT_STANDARD_PRICES.workspaceMonthlyUsdCents)}
          /month per workspace, including{" "}
          {PRODUCT_STANDARD_PRICES.includedAnsweredCasesPerMonth} answered cases
          and {formatUsdCents(PRODUCT_STANDARD_PRICES.includedAiCreditUsdCents)}{" "}
          of AI credit each month. Each additional answered case costs{" "}
          {formatUsdCents(
            PRODUCT_STANDARD_PRICES.additionalAnsweredCaseUsdCents,
          )}
          . All standard features and team members are included. Feature
          availability follows workspace settings and release checks.
        </p>
        <p>
          A case counts once when its first answer reaches the user. Follow-ups
          about the same issue add no case fee. Opens, greetings, handoff
          notices, spam, tests and duplicates do not count. Drafts, retries and
          failed sends do not count as answered cases. An answer can come from
          your team or an AI.
        </p>
        <p>
          New prepaid orders meter Templ AI separately at GPT-6.1 Terra&apos;s
          Standard API rates plus {PRODUCT_STANDARD_PRICES.aiRateBasisPoints / 100 - 100}
          %. Each paid period keeps the model rates and markup in its payment terms.
          Monthly AI credit covers this usage first. Rates
          distinguish input, cached input, cache writes, output and long-context
          requests. Reasoning tokens count within output, once. Legitimate
          answers, checks, follow-ups and Telegram team drafts use AI credit.
          Usage can count even when the AI does not resolve the case. Your own
          AI creates no Templ AI usage charge. Templ absorbs its bugs, provider
          errors, accidental loops and internal tests.
        </p>
        <p>
          Normal product support and feedback conversations are included.
          Optional setup costs{" "}
          {formatUsdCents(PRODUCT_STANDARD_PRICES.guidedOnboardingUsdCents)}{" "}
          once for one app integration. It includes discovery, integration, AI
          setup against your docs and FAQs, testing, and a team handover. The
          project takes {PRODUCT_STANDARD_PRICES.guidedOnboardingWorkdays}{" "}
          business days. The schedule starts after we agree on scope and receive
          required access and materials. Existing setup agreements and fee
          waivers remain valid. Additional implementation and custom development
          cost{" "}
          {formatUsdCents(PRODUCT_STANDARD_PRICES.customWorkHourlyUsdCents)}
          /hour. We agree on scope and estimated cost before starting.
        </p>
        <p>
          New self-serve customers pay upfront. The Plan page shows available
          payment networks and the exact amount before payment. Qualified
          checkout accepts direct USDC transfers on Ethereum, Base and Solana. A
          verified payment starts one calendar month of access. Access starts
          after server verification, rather than a wallet or checkout redirect.
          There is no automatic renewal. Stripe payments remain unavailable.
          Templ can record a custom billing arrangement or approved first month.
          An approved free month never records a payment received.
        </p>
        <p>
          We review answered-case totals and provider usage before issuing a
          monthly statement for customers with an agreed debt arrangement.
          Prepaid customers use their included allowances, then prepaid credit.
          New paid work pauses when credit cannot cover it. Your team can
          continue follow-ups on cases already counted. Each AI attempt first
          reserves a maximum amount. Valid provider usage sets the final charge,
          and unused reserves are released. Missing usage and provider errors
          create no customer charge. Monthly allowances do not roll over. Cash
          credit stays available after a month ends. Ask through Templ&apos;s
          widget to request a refund of unused cash credit. Refunds require
          manual review and are subject to the{" "}
          <Link href="#impersonation">brand impersonation rule</Link>.
          Unsupported transfers receive no automatic credit or
          recovery promise. Existing grants, access periods and signed
          agreements keep their recorded terms. Safety restrictions and
          operational and provider limits still apply.
        </p>
      </PolicySection>
      <PolicySection title="2. The service">
        <p>
          Templ provides support software. Extra work needs an agreed scope.
        </p>
        <p>
          Templ provides a wallet-connected support widget, a private team inbox
          and AI tools. Features depend on the workspace&#x27;s settings and
          enabled release gates. A workspace flag can enable a feature for that
          workspace. It never grants extra data access or removes a safety
          check. A disabled feature is not a promised service.
        </p>
        <p>
          A signed order form can set custom prices, service scope and service
          levels. The <Link href="/safety">Safety rules</Link> form part of
          these terms. The <Link href="/dpa">DPA</Link> governs Customer
          Personal Data processing. The{" "}
          <Link href="/privacy">Privacy Policy</Link> explains other data uses.
        </p>
        <p>
          Mandatory transfer clauses control any conflict within their scope.
          The DPA controls conflicts about Customer Personal Data. A signed
          order form controls its stated commercial changes. These terms control
          other matters. Summaries explain the clauses. The full clauses
          control.
        </p>
      </PolicySection>
      <PolicySection title="3. Your duties">
        <p>
          Customers run their support service. Users must share data lawfully.
        </p>
        <p>
          Customers choose their notices, team, instructions, sources and
          integrations. They need the rights and lawful basis to provide that
          material. They must show clear privacy information before collecting
          user data. They remain responsible for their protocol, products and
          promises.
        </p>
        <p>
          Customers must check answers where errors could cause harm. Wallet
          sign-in proves wallet control at that time. It does not prove a
          person&#x27;s name or company authority.
        </p>
        <p>
          Users must share only data they may lawfully share. Do not send
          another person&#x27;s private data without authority. Never send a
          private key, recovery phrase, password or other secret. Use your own
          case. Do not seek access to another user&#x27;s case.
        </p>
        <p>
          Keep your wallet, device and session secure. Tell your manager or
          Templ about suspected misuse. A shared device can expose data you may
          read. Templ cannot restore your private key.
        </p>
      </PolicySection>
      <PolicySection title="4. Team access">
        <p>Managers grant team access. An order form alone grants none.</p>
        <p>
          Users read their own cases. Team access follows current roles and
          permissions. Newly authorized team members may read retained history
          within their permission. User exports exclude internal notes.
        </p>
        <p>
          Payment, billing rights, token ownership and display names grant no
          case access. Ordinary case assignment grants no access either.
          Specialists have limited access through qualifying follow-ups or
          mentions. Templ checks current access for private reads, writes,
          searches, exports, files and events.
        </p>
        <p>
          Done-for-you support requires a signed order form. It states the
          tasks, coverage, escalation rules, price and any service levels. Templ
          staff act as the Customer&#x27;s processor under its instructions.
          They enter its inbox only after its manager grants them explicit team
          access. Their role limits what they may do. The manager can revoke
          that access.
        </p>
        <p>
          An order form, payment or operator role never opens a Customer inbox.
          Templ staff must follow lawful Customer instructions and the agreed
          scope. They cannot approve financial actions for the Customer or its
          users.
        </p>
        <p>
          Self-serve software does not include free human services. Setup,
          installation, operating work and custom AI development have separate
          quoted fees. Templ quotes service fees separately before work starts.
          These services are not free or included with a top-up. Self-serve
          install with one prompt is the product. Custom AI work builds an agent
          on your docs and rules. The quote sets the work, hosting and update
          schedule. A service fee adds nothing to the prepaid case balance.
        </p>
      </PolicySection>
      <PolicySection title="5. AI answers">
        <p>AI can answer or draft. People must check important answers.</p>
        <p>
          A workspace can allow AI answers, AI drafts only or AI off for a case.
          An agent cannot send user-facing answers in drafts-only mode. It
          cannot read or act on an AI-off case through the agent interface. An
          agent cannot change its own case mode. A person who sends a draft
          takes responsibility for that reply.
        </p>
        <p>
          AI can produce wrong, incomplete, biased or outdated answers. It can
          invent facts and sources. Templ does not guarantee accuracy, unique
          output or rights the law does not recognize. Customers must check
          their sources, drafts and permitted AI actions.
        </p>
        <p>
          A user may ask for a person on their own case. The request hands the
          case to the team. It adds no charge or permission. It does not promise
          an immediate reply.
        </p>
        <p>
          Support provides information, not financial, investment, legal or tax
          advice. Check important instructions with the team before acting.
          Enabled managed AI may send relevant case material to its model
          provider under the DPA.
        </p>
      </PolicySection>
      <PolicySection title="6. Legacy prices">
        <p>
          Team-handled cases cost{" "}
          {formatUsdCents(PRODUCT_RESOLUTION_PRICE.usdCents)} each. They cost{" "}
          {formatUsdCents(PRODUCT_RESOLUTION_PRICE.stepOneUsdCents)} after{" "}
          {PRODUCT_RESOLUTION_PRICE.stepOneAfterCases} billed team-handled cases
          in a UTC month.
        </p>
        <p>
          An AI-only case costs{" "}
          {formatUsdCents(PRODUCT_AI_ONLY_RESOLUTION_PRICE.usdCents)}. AI-only
          means the case resolved without a human staff reply. This rate applies
          to registered team agents and Templ&apos;s managed AI. A human staff
          reply makes the case team-handled, even if AI also replied.
        </p>
        <p>
          The first {PRODUCT_FREE_START.resolvedCases} eligible final
          team-handled cases are free. AI-only cases bill from the first case.
          They use no free case and never advance the team-handled price step.
          The free start applies once per billing owner and once per app domain.
          It does not renew each month. Accounts under the same owner&#x27;s
          control share this rule.
        </p>
        <table>
          <caption>Prices by UTC calendar month</caption>
          <thead>
            <tr>
              <th scope="col">Billed team-handled cases</th>
              <th scope="col">Price per case</th>
            </tr>
          </thead>
          <tbody>
            {priceSteps().map(({ cases, price }) => (
              <tr key={cases}>
                <td>{cases}</td>
                <td>{price}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Each billed team-handled case takes its monthly price step when its
          charge becomes final. The cheaper step does not change earlier
          charges. Free and grant cases use no paid price step.
        </p>
        <p>
          The public software offer has no seat, subscription, platform or
          minimum fee. The fee for a case your team resolves is a software fee.
          Separate services and applicable taxes may cost extra.
        </p>
        <p>
          A signed order form may set custom prices for that workspace. It
          states its prices, scope and term. The public offer invites custom
          terms above{" "}
          {PRODUCT_RESOLUTION_PRICE.customAboveCasesPerMonth.toLocaleString(
            "en-US",
          )}{" "}
          billable cases each month.
        </p>
        <p>
          {CUSTOM_PRICING_LINE.replace(" Talk to us.", "")}{" "}
          <TalkToTempl label="Talk to us">Talk to us</TalkToTempl>.
        </p>
      </PolicySection>
      <PolicySection title="7. Billable cases">
        <p>
          A case bills only after a person replied or a registered AI agent
          answered. It also needs a qualifying Templ step and final resolution
          under the{" "}
          <a href={`${SITE.docs}/pricing#when-a-case-is-billed`}>
            pricing rule
          </a>
          .
        </p>
        <p>
          A user message opens a case. A message within{" "}
          {PRODUCT_RESOLUTION_RULES.finalAfterDays} days of resolution reopens
          that case. A later message opens a new case. Only a user message opens
          a case.
        </p>
        <p>
          The team can mark a case resolved. The user can confirm “Yes” or
          “Solved”. A person&apos;s reply or registered AI answer must come
          first. Automatic greetings and replies that only hand off to a person
          do not count.
        </p>
        <p>
          A team resolution becomes final after{" "}
          {PRODUCT_RESOLUTION_RULES.finalAfterDays} days without a reopen. A
          user&#x27;s new message or “not solved” answer cancels it before then.
          A user&#x27;s “solved” answer becomes final after{" "}
          {PRODUCT_RESOLUTION_RULES.memberFinalHours} hours. Their new message
          or “not solved” answer cancels it during that time. A spam mark before
          finality excludes the charge.
        </p>
        <p>
          Each case can have only 1 charge. Resolving a cancelled case again
          uses that same charge. A final charge keeps its case class and price
          after reopening. A cancelled charge uses current case facts and prices
          at its next billable resolution. Templ&apos;s managed AI needs the
          user&apos;s Yes before finalization. Managed AI billing stays closed
          until its own required checks pass. One canonical user bills once
          within the {PRODUCT_RESOLUTION_RULES.duplicateHours}-hour duplicate
          window. A guest who links their wallet remains the same user.
        </p>
        <p>
          Spam, qualifying duplicates, Templ checks, team previews and permitted
          install previews do not bill. Up to{" "}
          {PRODUCT_RESOLUTION_RULES.testAccountsMax} listed test accounts may
          create {PRODUCT_RESOLUTION_RULES.testCasesPer30Days} excluded test
          cases in 30 days. Excluded cases use no free case. Abandoned cases do
          not bill because time passes. Improvement copies never create or
          change a charge.
        </p>
      </PolicySection>
      <PolicySection title="8. Stablecoin payments">
        <p>
          You pay for resolved cases by prepaid stablecoin balance
          {RELEASE.cardBillingVerified ? " or monthly card invoice." : "."} Pay
          only through the instructions shown in your authenticated app.
        </p>
        <p>
          Payments use the stablecoins and networks shown in the app. Supported
          tokens include USDC and USDT where official on configured EVM networks
          and Solana. Payments are direct stablecoin transfers. The app shows
          the enabled network, amount, recipient and payment request.
        </p>
        <p>
          Pay to the address shown in the app. Create the request in your
          authenticated Plan view. Use the proven paying wallet named there.
          Check the token, network, address and amount before sending. Gas and
          wallet fees are separate. Chat cannot change payment instructions or
          start a payment or signature.
        </p>
        <p>
          Templ credits only a verified transfer matched to its payment request.
          It checks the asset, network, payer, recipient, amount and finality. A
          receipt credits once. A payment memo is not required for credit. A
          wallet signature, screenshot or return page adds no balance. A payment
          method stays closed until its required checks and configuration pass.
        </p>
        <p>
          An unmatched transfer needs operator review before credit.{" "}
          <TalkToTempl label="Talk to us">Talk to us</TalkToTempl> with its
          public transaction reference and payment request. Do not send
          credentials. Wrong-network, wrong-token and wrong-address transfers
          may be lost. Templ cannot promise recovery or automatic credit.
        </p>
        <p>
          Custom-deal invoices use payment requests tied to signed order forms.
          The same scanners verify their transfers. These requests earn no bonus
          credit.
        </p>
        <p>
          Blockchain transfers are generally final and irreversible. A refund
          needs a separate payment. It cannot erase the original transfer.
          Stablecoins can lose value or become restricted by their issuer. Templ
          does not guarantee their market price or redemption.
        </p>
        <p>
          The app records paid service credit in USD for the verified amount
          received. Standard top-ups are{" "}
          {formatUsdCents(PRODUCT_TOP_UP.minUsdCents)} to{" "}
          {formatUsdCents(PRODUCT_TOP_UP.maxUsdCents)}, in whole dollars. The
          eligible amount left after clearing debt earns{" "}
          {PRODUCT_TOP_UP.bonusTenPercent}% bonus credit from{" "}
          {formatUsdCents(PRODUCT_TOP_UP.bonusTenFromUsdCents)}. It earns{" "}
          {PRODUCT_TOP_UP.bonusTwentyPercent}% at{" "}
          {formatUsdCents(PRODUCT_TOP_UP.bonusTwentyFromUsdCents)}. The bonus
          percentages do not add together.
        </p>
        <p>
          Eligible team-handled cases use free cases first. Reviewed grants and
          prepaid balance follow for both case classes. Grants follow their case
          count and end date. Bonus and grant credit cannot be withdrawn,
          transferred or refunded. Top-ups never renew automatically.
        </p>
        <p>
          Reviewed founding credit covers {PRODUCT_FOUNDING_CREDIT.cases}{" "}
          resolved cases. It ends when used or {PRODUCT_FOUNDING_CREDIT.days}{" "}
          days after it starts. Each billing owner can receive it once. Templ
          may approve reviewed pilot credit with an end date. Each pilot grant
          states its case limit and ends when used or on that date. List prices
          apply from day one. Credits never change the public price.
        </p>
        {RELEASE.cardBillingVerified && (
          <>
            <p>
              Monthly card billing is available. Billing managers save cards and
              manage invoices on Stripe&apos;s hosted pages. Templ never handles
              card numbers. Only verified signed Stripe webhooks establish
              setup, coverage and payment status. Returning from Stripe grants
              no payment coverage.
            </p>
            <p>
              Stripe bills final resolved cases each month. Stablecoin-paid and
              card-paid cases share the month&apos;s price steps. Stripe adjusts
              the invoice so each case keeps its recorded price. Eligible
              team-handled cases use free cases first. Grants, a positive
              stablecoin balance and card billing follow for both case classes.
              A positive balance pays the whole next case, even if it becomes
              negative. Each billing owner can use card billing for 1 workspace.
              Card billing starts only after its setup webhook. Earlier final
              charges stay on the stablecoin balance.
            </p>
            <p>
              Switching to stablecoins ends card billing after the current
              period. Earlier finals stay on the invoice. Stripe&apos;s
              cancellation webhook restores stablecoin billing for future
              finals. An accepted dispute cancels usage while the invoice is
              open and Stripe permits cancellation. After that window or invoice
              close, Stripe credits the next invoice. Other cases keep their
              recorded prices.
            </p>
            <p>
              An unpaid invoice never stops service or holds cases. Templ
              contacts billing managers and sends reminders. Only an audited
              Templ operator can suspend the workspace.
            </p>
          </>
        )}
        <p>
          Payments buy Templ services. Templ receives them as its own funds.
          Your balance is service credit. It is not custody, a bank deposit or
          an investment. Templ does not hold your private keys or control your
          wallet.
        </p>
        <p>
          A positive balance pays the whole next case, even if it becomes
          negative. A workspace with a verified top-up or a reviewed grant keeps
          working below zero. Templ contacts its managers. Only an audited
          operator can suspend it. Billing suspension refuses new cases. Open
          cases stay readable and answerable unless another lawful restriction
          applies. Their charges continue.
        </p>
        <p>
          A workspace that never added balance and never held a grant pauses at
          -{formatUsdCents(PRODUCT_FREE_NEGATIVE_LIMIT_CENTS)}. The pause stops
          new cases and team or AI replies. Managers can still read, export and
          add balance. A verified top-up must restore a non-negative balance to
          restart support. An audited operator can also restart it. Balance
          alerts never cap spending or stop service.
        </p>
      </PolicySection>
      <PolicySection title="9. Billing disputes">
        <p>
          Dispute an error within {PRODUCT_RESOLUTION_RULES.disputeDays} days.
          Refunds cover eligible unused paid balance.
        </p>
        <p>
          A billing manager may dispute a final charge within{" "}
          {PRODUCT_RESOLUTION_RULES.disputeDays} days. Reasons include spam,
          tests, duplicates and an unresolved case. Use the charge reference and
          a short reason. Do not send the user&#x27;s private case as billing
          evidence.
        </p>
        <p>
          Automatic dispute credits have a limit each UTC month. The limit uses
          final charges from the last 30 days. It is the larger of{" "}
          {PRODUCT_RESOLUTION_RULES.autoCreditMinimum} charges or{" "}
          {PRODUCT_RESOLUTION_RULES.autoCreditPercent}% of those charges. Each
          case class has the same limit, using only that class&apos;s final
          charges. Automatic credits must fit both the total limit and their
          class limit. Earlier automatic credits without a recorded class count
          against both class limits. Further disputes need operator review.
          Billing access grants no raw case access. Review uses charge metadata
          and any lawfully available de-identified copy.
        </p>
        <p>
          On account closure, you may request a refund of eligible unused paid
          balance. Refunds cover paid top-ups younger than{" "}
          {PRODUCT_TOP_UP.refundWindowDays} days. Templ subtracts valid charges
          waiting to become final. Refunds return to the paying address on the
          same network. The <Link href="#impersonation">brand impersonation rule</Link>{" "}
          also applies. Bonus and grant credit are never refunded.
        </p>
        <p>
          Final service fees are not refundable unless a billing correction,
          signed agreement or mandatory law requires a remedy. An order form can
          state other remedies. Legal checks may delay or prohibit a return.
          Templ cannot return assets it never received.
        </p>
        <p>
          A price increase takes effect only after{" "}
          {PRODUCT_RESOLUTION_PRICE.priceNoticeDays} days&#x27; notice. A lower
          price applies at once. A charge keeps the price table in force when it
          became provisional. A fixed order-form price follows that form. These
          rules do not remove mandatory rights.
        </p>
      </PolicySection>
      <PolicySection title="10. Content rights">
        <p>
          You keep your content. Templ uses it for agreed and lawful purposes.
        </p>
        <p>
          Customers and users keep their rights in submitted content. They grant
          Templ the rights needed to host, process and deliver it. These rights
          cover the service, lawful security review and required legal duties.
          Separate data uses follow the Privacy Policy and DPA. This contract
          alone does not create a lawful basis for optional use.
        </p>
        <p>
          Templ owns its software, design and documentation. Customers may use
          the service during their agreement. Users may use the support features
          their Customer enables.
        </p>
        <p>
          Each party must protect the other&#x27;s confidential business
          information with reasonable care. Use it only to perform this
          agreement. Share it only with people who need it and owe
          confidentiality duties. This excludes independently developed material
          and information lawfully received or already public without breach.
        </p>
        <p>
          A party may disclose information when law requires it. Give notice
          where lawful. Limit disclosure to the required scope. Customer
          Personal Data also follows the DPA. Confidentiality duties continue
          while the information remains confidential.
        </p>
      </PolicySection>
      <PolicySection title="11. Data use">
        <p>
          Customers control support data. Templ&#x27;s separate uses need their
          own lawful basis.
        </p>
        <p>
          The Customer is the controller of user support data. Templ is its
          processor for support, including agreed done-for-you work. Templ is a
          controller for its account, billing, security, legal-intake and
          site statistics. Our <Link href="/privacy#measurement">Privacy notice</Link> explains what we count if you opt in and how to turn it off.
        </p>
        <p>
          The improvement-copy feature has separate rules in{" "}
          <Link href="/privacy#improvement">Privacy</Link> and the{" "}
          <Link href="/dpa">DPA</Link>. It stays gated. The rules remove
          detected wallet addresses, transaction hashes, emails, handles and
          names. A de-identified copy may still be personal data. Templ needs
          lawful grounds, notices and transfer safeguards before using it.
          Account acceptance cannot replace required consent.
        </p>
        <p>
          Improvement copies never create or change a charge. Billing counts
          your team&apos;s resolves and your users&apos; “solved” answers. Templ
          gives {PRODUCT_RESOLUTION_PRICE.priceNoticeDays} days&apos; notice
          before copies could ever affect billing. You must tell your users
          about these copies. The{" "}
          <Link href="/dpa#customer-notice">DPA notice</Link> gives text you can
          use.
        </p>
        <p>
          Eligible copies help improve answers, check resolution rules and
          review disputed charges. They last at most{" "}
          {CORPUS_LIMITS.retentionDays} days. They may outlive normal case
          deletion. A user&#x27;s privacy request or objection removes them
          sooner. Workspace deletion removes them too. Legal holds never extend
          their retention. Templ sends no improvement rows to model providers
          and trains no model on them.
        </p>
        <p>
          No product setting excludes a workspace from the enabled copy rule. A
          signed custom contract can do so. Want a contract without this?{" "}
          <TalkToTempl label="Talk to us">Talk to us</TalkToTempl>. The copy
          store grants no access to raw private cases.
        </p>
        <p>
          Resolved, abandoned and spam cases normally expire{" "}
          {PRODUCT_LIMITS.supportHistoryDays} days after their last message.
          Cleanup runs through service activity and scheduled work. Expired data
          can remain until cleanup runs. Open cases remain until closed or
          validly deleted. Archive does not change retention. A documented legal
          hold can preserve raw service data.
        </p>
        <p>
          At service end, return or deletion follows the DPA. Export important
          records before access ends. User exports exclude internal notes. A
          domain change or deployment shutdown does not delete stored data.
        </p>
        <p>
          Private cases are access-controlled. They are not end-to-end
          encrypted. Templ applies the DPA&#x27;s security measures and responds
          to incidents. The Privacy Policy explains account records, provider
          logs and deletion limits.
        </p>
      </PolicySection>
      <PolicySection title="12. Lawful use">
        <p>
          Use Templ for lawful support. Do not harm people or bypass security.
        </p>
        <p>
          Do not use Templ for fraud, phishing, harassment, exploitation,
          malware or unlawful content. Do not unlawfully disclose personal data.
          Never ask for private keys, recovery phrases or other secrets. Do not
          use chat to start wallet signing, approvals or transactions. Questions
          about past public transactions remain allowed.
        </p>
        <p>
          Do not bypass user isolation, permissions, revocation, rate limits or
          feature gates. Do not impersonate a person, organization or authority.
          Do not use stolen credentials. Do not manipulate free cases,
          duplicates, grants or resolved-case billing.
        </p>
        <p>
          Follow sanctions and export laws that apply to you or Templ. Do not
          act for a prohibited person when law bars that service. The Safety
          rules explain the applicable scope.
        </p>
        <p>
          Templ may protect against attacks and unauthorized access. It may
          restrict service for verified breaches, unpaid fees or applicable
          legal duties. Content enforcement and disclosures follow the Safety
          review process. A report alone grants no access and causes no
          automatic restriction.
        </p>
        <p>
          Where lawful and practical, Templ explains the reason and allows time
          to fix a breach. Urgent security or legal duties may require immediate
          action. You may appeal a platform decision through Safety.
        </p>
      </PolicySection>
      <PolicySection title="13. Service limits">
        <p>
          Keep your own important records. Either party can end service under
          these rules.
        </p>
        <p>
          The service has message, storage, request, search, file and provider
          limits. It is not a permanent archive. Standard limits promise no
          measured throughput or unlimited use. Only an order form can set a
          service-level agreement.
        </p>
        <p>
          Templ may maintain or change the service with reasonable notice where
          practical. It will not remove a fixed order-form commitment without
          agreement or a lawful remedy. External wallets, blockchains and
          providers can interrupt their services.
        </p>
        <p>
          A Customer may request closure at any time. An order form controls its
          term, renewal and early exit. Templ may end self-serve service with 30
          days&#x27; notice. It may end it sooner for an uncorrected material
          breach, active security threat or legal requirement.
        </p>
        <p>
          Ending access does not cancel valid fees, agreed remedies,
          confidentiality or data duties. Templ follows the DPA for return,
          deletion and lawful preservation. Ending access does not erase public
          blockchain records.
        </p>
      </PolicySection>
      <PolicySection title="14. Warranties">
        <p>
          Templ provides support information. It does not guarantee protocol or
          blockchain outcomes.
        </p>
        <p>
          Templ will use reasonable care and skill to provide the agreed
          service. Subject to mandatory law, other warranties are excluded.
          Templ promises no uninterrupted service, error-free AI or particular
          support result.
        </p>
        <p>
          Read-only transaction checks may be incomplete or wrong. They are not
          audits, endorsements or proof that funds are safe. Templ provides no
          custody, exchange, brokerage or transaction-signing service. It
          provides no financial, investment, legal or tax advice.
        </p>
        <p>
          Wallet sign-in uses an authentication message. That signature proves
          wallet control for its stated session. It authorizes no transfer or
          token approval. Chat never starts signing or submits transactions.
        </p>
        <p>
          Public blockchain data can reveal addresses, amounts and transaction
          history. Others may copy it or link it to people. Templ cannot change
          or delete that history. Protocols and wallets have their own terms.
        </p>
      </PolicySection>
      <PolicySection title="15. Liability limits">
        <p>Contract claims have limits. Mandatory rights remain available.</p>
        <p>
          To the extent lawful, neither party owes the other damages for
          indirect or consequential loss. This includes lost profits, revenue,
          business opportunities and expected savings. This exclusion does not
          remove direct data-restoration costs caused by a DPA breach.
        </p>
        <p>
          For Customer claims, each party&#x27;s ordinary aggregate liability
          has a cap. It is the greater of US$1,000 or the affected
          service&#x27;s fees over the preceding 12 months. Those fees include
          amounts paid or payable. The period ends at the first event giving
          rise to the claim.
        </p>
        <p>
          Confidentiality breaches, data-protection breaches and section 16
          indemnities have a higher combined cap. It is the greater of US$10,000
          or twice those fees. This includes ordinary claims. The caps do not
          add together.
        </p>
        <p>
          A user&#x27;s direct claim against Templ has an aggregate cap of
          US$1,000 where lawful. Users owe no Customer fees or business
          indemnities.
        </p>
        <p>
          No exclusion or cap covers fraud, fraudulent misrepresentation,
          willful misconduct or gross negligence. None limits death or personal
          injury from negligence where law forbids it. None limits liability
          that applicable law prohibits limiting. Customer fee obligations
          remain payable.
        </p>
        <p>
          These terms preserve data subjects&#x27; statutory compensation and
          mandatory transfer-clause rights. They preserve regulator remedies and
          mandatory consumer rights. Caps apply only between the contracting
          parties where lawful.
        </p>
      </PolicySection>
      <PolicySection title="16. Business indemnities">
        <p>
          Each business covers defined claims caused by its own
          responsibilities.
        </p>
        <p>
          The Customer must defend Templ against third-party claims caused by
          unlawful Customer content or instructions. This includes infringement
          by Customer-supplied material. The Customer pays resulting court
          awards and approved settlements. This excludes loss caused by
          Templ&#x27;s breach or misconduct.
        </p>
        <p>
          Templ must defend the Customer against third-party claims that
          authorized use of Templ software infringes intellectual property
          rights. Templ pays resulting court awards and approved settlements.
          This excludes Customer material, AI output, unauthorized changes and
          combinations that caused the claim. It excludes continued use after a
          lawful notice to stop infringement.
        </p>
        <p>
          Templ may obtain rights, replace the affected feature or change it to
          avoid infringement. Otherwise, it may end that feature. Any refund or
          other remedy follows mandatory law and the applicable signed
          agreement.
        </p>
        <p>
          The protected party must give prompt notice and reasonable help. The
          defending party controls the defense. It cannot admit the other&#x27;s
          fault or impose non-monetary duties without consent. Consent must not
          be unreasonably withheld. Section 15 applies where lawful. Users give
          no business indemnity.
        </p>
      </PolicySection>
      <PolicySection title="17. Governing law">
        <p>
          BVI law governs. Mandatory court and complaint rights remain
          available.
        </p>
        <p>
          British Virgin Islands law governs this agreement, excluding its
          conflict-of-laws rules. Competent British Virgin Islands courts have
          exclusive jurisdiction for Customer contract disputes. Venue is Road
          Town, subject to the court&#x27;s rules.
        </p>
        <p>
          First send a written dispute notice with the facts and requested
          remedy. The parties will try to resolve it for 30 days. This does not
          delay urgent court relief or statutory deadlines.
        </p>
        <p>
          Mandatory consumer law, regulator jurisdiction and data-subject rights
          remain available. Transfer clauses keep their required governing law,
          courts and complaint rights. Users retain any mandatory right to sue
          in their home courts.
        </p>
      </PolicySection>
      <PolicySection title="18. Changes and contact">
        <p>Templ dates changes. Use its widget first when you need help.</p>
        <p>
          Templ publishes dated terms and gives Customers 30 days&#x27; notice
          of material changes. Immediate changes may address mandatory law or
          urgent security issues. Templ explains them as soon as lawful and
          practical. Price changes follow section 9.
        </p>
        <p>
          Changes apply to future use. They do not rewrite fixed order forms or
          expand processing instructions without required agreement. You may
          stop using an affected service before a rejected material change takes
          effect. Closure rules still apply.
        </p>
        <p>
          Neither party may transfer this agreement without reasonable consent.
          A business transfer may occur if its successor assumes all duties. It
          must preserve data rights and required notices. A transfer grants no
          new use of personal data.
        </p>
        <p>
          If a clause is unenforceable, the rest remains effective. A failure to
          enforce a right is not a waiver. These terms and applicable order
          forms form the service agreement. Mandatory data-subject beneficiaries
          keep their rights.
        </p>
        <p>
          <TalkToTempl label="Talk to us">Talk to us</TalkToTempl> for Templ
          support and billing help. Use{" "}
          <TalkToTempl label="Legal notices" topic="legal">
            Legal notices
          </TalkToTempl>{" "}
          for legal-page questions and formal notices. Formal legal and contract
          notices may also go to {OPERATOR.legalContact}. Use{" "}
          <TalkToTempl label="Privacy requests" topic="privacy">
            Privacy requests
          </TalkToTempl>{" "}
          for data requests. These requests may also go to{" "}
          {OPERATOR.privacyContact}. Written notices may use our mailing address
          above. Use <Link href="/safety">Safety</Link> for its legal reports,
          urgent reports and appeals.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
