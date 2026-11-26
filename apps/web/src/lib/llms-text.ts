import { formatStandardAiRate } from "@templ/chat/standard-usage";
import { BUILD_RELEASE, SITE } from "@/lib/config";
import {
  PRODUCT_LIMITS,
  PRODUCT_ANNUAL_PRICES as ANNUAL,
  PRODUCT_STANDARD_PRICES as PRICES,
  PRODUCT_STARTER_PRICES as STARTER,
} from "@templ/chat/plans";
import type { publicReleaseStatus } from "@/lib/public-release";
type Status = ReturnType<typeof publicReleaseStatus>;
type GuideFlags = Pick<
  typeof BUILD_RELEASE,
  | "supportWidgetSolanaVerified"
  | "supportDiagnosisVerified"
  | "aiDraftsProved"
  | "supportCorpusVerified"
>;
const state = (value: boolean) => (value ? "Available" : "In testing");
export function renderLlmsText(
  release: Status,
  flags: GuideFlags = BUILD_RELEASE,
): string {
  const payments = release.productOffer.paymentNetworks
    .flatMap(({ name, assets }) =>
      assets.map(
        ({ symbol, payable }) => `- ${symbol} on ${name}: ${state(payable)}.`,
      ),
    )
    .join("\n");
  const contact = `Use Talk to us on ${SITE.origin} to open Templ's support widget.`;
  return `# Templ

Share a private chat link and reply from Cases. Add a website or sitemap under AI → Website and docs for AI answers or drafts.
Create a workspace and test ${PRODUCT_LIMITS.freeSupportTickets} integration tickets free.
Your team answers free test tickets. When Workspace shows Try your AI, an Admin can test questions privately against the workspace’s docs.
Each test ticket allows ${PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies.
Retries, deleting replies and reopening do not reset this allowance.
After the free allowance, pay for workspace access to continue.
Do not create more workspaces to bypass the free limit.
Under Choose a hosted name, enter an available name and select Reserve name and choose a plan. Choose monthly or annual access and pay in USDC. Existing workspaces can also open Plan & usage. Access starts after payment is verified.
A pending transfer does not activate access. Ask Templ in chat if payment is unavailable.
[Read pricing.](${SITE.docs}/pricing)

## Start

Create a workspace at ${SITE.origin}/create. Copy the visitor link under Your support chat and try a reply in Cases. Self-hosted teams use their own domain. To add the embedded widget or enable a link in an existing workspace, open Settings → Chat. Under Guest support, select Host a support page on Templ and Save guest support, then use Copy support link. The page accepts guests. The public link grants no access to another visitor’s cases. Both entries reach the same workspace inbox.
For the widget, copy the install prompt from ${SITE.docs}/install into your AI coding tool.
${
  release.support.connectVerified
    ? "Open the link it gives you. Sign in with your wallet and confirm your app.\nCreate a workspace there or choose one you manage. The tool saves the workspace ID and adds support."
    : `Create a workspace at ${SITE.origin}/create.\nCopy its install prompt into your coding tool. Keep support off until the workspace is configured and the widget is verified.`
}
The widget works on public HTTPS websites without website approval.
You do not need a workspace ID to start. A configured ID also works.
Review the files the tool adds. Send a test question, then answer it in your inbox.
Open your workspaces at ${SITE.origin}/inbox.
Users can ask without a wallet by default. A manager can require a connected or verified wallet.
A connected wallet is not proof. Users verify a wallet by signing in.
Templ never asks for a private key or recovery phrase.

## Availability

- User cases: ${state(release.support.conversationsVerified)}.
- Team inbox: ${state(release.support.conversationsVerified && release.support.workflowVerified)}.
- Connect your app: ${state(release.support.connectVerified)}.
- Support widget on EVM networks: ${state(release.support.widgetVerified)}.
- Sign in with Solana in the widget: ${state(flags.supportWidgetSolanaVerified === true)}.
- Transaction checks: ${state(flags.supportDiagnosisVerified === true)}.
- AI drafts: ${state(flags.aiDraftsProved === true)}.
- Your own AI agent: ${state(release.agents.sdkVerified)}.
- Improvement copy: ${state(flags.supportCorpusVerified === true)}.

Read ${SITE.origin}/availability and ${SITE.origin}/api/status for the current release facts.
Early features apply to selected workspaces. They do not change public availability or grant access.

## Templ Hosted pricing

Templ Hosted Starter for new workspaces costs $${STARTER.workspaceMonthlyUsdCents / 100}/month for ${STARTER.includedAnsweredCasesPerMonth} answered cases. Each extra case costs $${(STARTER.additionalAnsweredCaseUsdCents / 100).toFixed(2)}. Starter uses prepaid Templ AI with a monthly limit. Plus costs $${PRICES.workspaceMonthlyUsdCents / 100}/month per workspace.
It includes ${PRICES.includedAnsweredCasesPerMonth} answered cases and $${PRICES.includedAiCreditUsdCents / 100} in retail AI credit each month.
Each additional answered case costs $${(PRICES.additionalAnsweredCaseUsdCents / 100).toFixed(2)}.
A case counts once after its first answer reaches the user.
Follow-ups about the same issue add no case.
Opens, greetings, handoff notices, spam, tests, duplicates, drafts, retries and failed sends do not count.
Extra answered cases use prepaid credit after the included allowance.
Normal safety, provider and operating limits still apply.
Both plans include all team seats. Annual access costs $${ANNUAL.starter / 100} for Starter or $${ANNUAL.standard / 100} for Plus. Included cases and AI credit reset monthly.
Templ’s own support chat uses GPT-6.1 Terra. New prepaid workspaces use GPT-6.1 Sol. Prepaid Templ AI usage costs ${formatStandardAiRate(PRICES)} times the published GPT-6.1 Sol Standard API rates.
The included retail credit covers AI use first. Further use draws from prepaid USDC.
Apply the published input, cached-input, cache-write and long-context tiers.
Count reasoning tokens as output once.
Legitimate AI answers, verification, Telegram team drafts and follow-ups use credit, including work on unresolved cases.
Templ absorbs its bugs, provider errors, loops and test traffic.
Missing usage stays unavailable. Do not guess charges.
There is no separate confirmed-resolution fee under this offer.
Your own AI uses your provider account. Its delivered answers count toward the same case allowance.
Ticketing and standard features are included, subject to current availability.
Normal product support and feedback are included.
Optional done-for-you setup costs $${PRICES.guidedOnboardingUsdCents / 100} once.
It includes discovery, one app integration, AI configured and tested against your docs and FAQs, routing tests and handover.
The ${PRICES.guidedOnboardingWorkdays}-business-day schedule starts after scope is agreed and the required access and materials are ready.
Work outside the agreed scope has a separate price. Agree on scope and estimated cost before work starts.
Read [service pricing](${SITE.docs}/pricing/custom-deals#optional-services) for details.
The statement records usage and verified payments. Existing debt and custom agreements keep their collection terms.
There is no automatic renewal or automatic payment.
Existing access grants, recorded periods, signed terms and receipts keep their original pricing.
Choose your term before paying. Publishing it creates no enrollment or retroactive charges.

## Stablecoin payments

Use only payment networks shown as available in your workspace.

Create a payment request in Plan. Pay by direct stablecoin transfer from a wallet you signed in with.
Templ verifies the transfer before activating access or adding credit. Each transfer credits once.
Payments need no contract or approval. Templ never asks for payment in chat.
Each network and token has its own release check.

${payments}

## AI agents

Connect your AI agent to the team inbox.
Your own AI agent has no extra Templ AI fee. You pay its model provider yourself.
Templ people answer only under an active signed order form. Your manager must add them to your team.
Removing their access ends it at once. Order forms grant no case access.
${contact}

## Permissions and privacy

Users can ask without signing in when the manager allows guests.
No email or name is needed. Users pick what to share.
Templ servers process Standard messages. Authorized staff can read them, and enabled, authorized AI can send permitted content to its model provider. In customer-controlled encrypted chat, approved endpoints use the workspace’s keys. The customer controls recovery. Templ operates its own encrypted support key service. With AI off, agents cannot read or work on a case.
Users read their own cases. Your team needs current access to read or answer a case.
Internal notes stay with the team. Templ checks access on every read, reply, export and search.
Chat cannot sign or send transactions. Wallet sign-in proves control of an address at that time.
It does not prove a person's identity or a refund claim.
When enabled, Templ keeps a de-identified copy of finished cases. The widget shows a notice before users share.
Read ${SITE.origin}/privacy#improvement for what the copy keeps and how to object.
Read ${SITE.origin}/privacy, ${SITE.origin}/terms, ${SITE.origin}/dpa and ${SITE.origin}/safety.

## Docs

- [Get started with Templ](${SITE.docs}/): Share a chat link and reply from your team inbox.
- Choose an embedded widget, a standalone chat link, or both. [Install the widget or use a chat link](${SITE.docs}/install).
- [Fix widget install problems](${SITE.docs}/install/troubleshooting): Check why the widget does not load or questions do not arrive.
- [Set up your Templ workspace](${SITE.docs}/setup): Try a conversation, claim a name and add AI sources.
- [Team roles and access](${SITE.docs}/team): See who can read, answer, export and bill.
- [Chat on your site](${SITE.docs}/widget): What users see and share.
- [Connected and verified wallets](${SITE.docs}/wallet-verification): What wallet sign-in proves.
- [Answer cases in the team inbox](${SITE.docs}/inbox): Review an AI draft, reply and clear spam.
- [Transaction checks on EVM networks and Solana](${SITE.docs}/transaction-checks): What the chain shows and what stays unknown.
- [AI answers and drafts](${SITE.docs}/ai): Choose who answers each case.
- [Get alerts for new cases](${SITE.docs}/alerts): Choose how your team receives case alerts.
- [Workspace pricing](${SITE.docs}/pricing): Workspace pricing, optional Templ AI and services.
- [How cases are counted](${SITE.docs}/pricing/resolved-cases): See answered-case counting and the rules for existing signed agreements.
- [USDC payments](${SITE.docs}/pricing/stablecoin-payments): Pay for access, follow a transfer and find your receipt.
- [Order forms and team access](${SITE.docs}/pricing/custom-deals): Read signed terms and the checks that control team access.
- [How Templ keeps users and teams safe](${SITE.docs}/security): Sign-in, access and chat protections.
- [Case data, retention and exports](${SITE.docs}/data): See who can export cases and how long data stays.
- [How Templ uses de-identified copies](${SITE.docs}/data/de-identified-copies): See the copy's contents, limits and custom contract option.
- [Ask for help in an app that uses Templ](${SITE.docs}/help/ask-for-help): Ask the app's team and choose what to share.
- [How to spot fake crypto support](${SITE.docs}/help/official-support): Check the site and keep keys and recovery phrases private.
- [Widget reference for developers](${SITE.docs}/developers/widget): Mount the widget and pass wallet and failure details.
- [Connect your own AI agent](${SITE.docs}/developers/support-agent): Connect an agent that answers or drafts replies.
- [Templ API overview](${SITE.docs}/developers/api): Find routes for cases, replies, transaction checks and exports.
- [Agent API reference](${SITE.docs}/developers/agent-api): Check fields, errors and handoff rules for AI agents.
- [Common questions about Templ](${SITE.docs}/faq): Answers about Templ, pricing, wallets and your data.
- [Templ glossary](${SITE.docs}/glossary): Read plain meanings of Templ's terms.
- [Templ changelog](${SITE.docs}/changelog): Read dated product and docs updates.
- [About Templ](${SITE.docs}/about): See who runs Templ and how we work.

Read every docs page at ${SITE.docs}/llms-full.txt.
`;
}
