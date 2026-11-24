import { formatStandardAiRate } from "@templ/chat/standard-usage";
import { SITE } from "@/lib/site-environment";
import {
  PRODUCT_LIMITS,
  PRODUCT_STANDARD_PRICES as PRICES,
  PRODUCT_STARTER_PRICES as STARTER,
} from "@templ/chat/plans";
import { installConnectSteps } from "@/lib/support-integration-prompt";

import {
  SUPPORT_WIDGET_LATEST_PATH,
  SUPPORT_WIDGET_SUPPORT_DAYS,
} from "@/lib/support-widget-release";

/** The integration guide for AI coding tools, with this build's hosts. The
 * Solana lines appear only once the release record verifies the widget's
 * Solana sign-in, and the Python client is listed once its hosted trial
 * passed. */
export function renderAgentsGuide({
  supportWidgetSolanaVerified = false,
  pythonVerified = false,
}: {
  supportWidgetSolanaVerified?: boolean;
  pythonVerified?: boolean;
} = {}): string {
  const solana = supportWidgetSolanaVerified === true;
  const python = pythonVerified
    ? `\n- [Python agent client](${SITE.origin}/templ_agent.py): the same backend loop in one standard-library file. Compare its SHA-256 with \`agents.python.sha256\` in [app status](${SITE.origin}/api/status). The [Agent API reference](${SITE.docs}/developers/agent-api) lists every route it calls.`
    : "";
  return `# Templ support integration

Support inside your crypto app or on a standalone page.

Templ adds private support chat and a team inbox.
Visitors choose which wallet and transaction details to share.
Your AI agent answers or hands off. Your team replies in chat.
[Test ${PRODUCT_LIMITS.freeSupportTickets} tickets free, without Templ AI. Read pricing.](${SITE.docs}/pricing)
Transaction checks appear only when enabled.

Connect your AI agent with the backend guide below.
Ask a question through [Templ's widget](${SITE.origin}/#support).

## Choose an integration

Ask whether the team wants a standalone link, an embedded widget, or both. New teams can use Create your chat, copy the link under Your support chat and reply in Cases. Self-hosted teams share a link on their own domain. For an existing workspace that needs a link, open Settings → Chat → Guest support. Select Host a support page on Templ and Save guest support. Use Copy support link and publish the saved URL on the official site. The page accepts guests and works without the widget script. For both, install the widget for that same workspace. Both entries reach its inbox. Guest sessions are scoped to their site and workspace.

- [Install with your AI](${SITE.docs}/install): create or choose your workspace, copy its install prompt into your AI coding tool, then test the widget.
- [Wallet support widget](${SITE.docs}/developers/widget): load \`${SITE.origin}/support-widget.js\` in the browser as a hosted ES module with \`import()\`. There is no npm package; don't install one. The guide links to the full install prompt. Call \`captureSupportFailure(workspaceId, failure)\` from your failure handler with the [typed \`app\` fields and limits](${SITE.docs}/developers/widget#capture-failure). Make a "Get help" button call \`openSupport(workspaceId)\`. Pass the wallet the app already connected: \`{ evm: provider }\` with the EIP-1193 provider the user picked${solana ? ", or `{ solana: wallet }` with `useWallet()` from @solana/wallet-adapter-react or the Wallet Standard wallet the user picked" : ""}. Visitors can ask without a wallet unless the workspace requires one; a separate ${solana ? "SIWE or SIWS" : "SIWE"} proof verifies their wallet when they choose to sign in. Reuse the existing wallet connection; do not add a second wallet modal. To pin one build, load \`${SITE.origin}${SUPPORT_WIDGET_LATEST_PATH}\` instead: that file never changes and keeps working for ${SUPPORT_WIDGET_SUPPORT_DAYS} days after a newer version replaces it.
- [Backend support agent](${SITE.docs}/developers/support-agent): a working Node 22 example using \`TemplChatClient\` from [agent-client.mjs](${SITE.origin}/agent-client.mjs), a server signer and your model adapter. It includes a durable outbox and human handoff.${python}
- [Current availability](${SITE.origin}/api/status): check the widget, conversation, workflow and AI agent flags before enabling live requests. Downloading code does not prove hosted availability.

## Workspace setup

Read the workspace ID from the app's public config. A known ID can use the same install module.

${installConnectSteps()}

Connect links the app to the workspace after the manager confirms it.
The widget works on public HTTPS websites without website approval.
Never infer staff permission from wallet ownership.

The widget session opens only the user's own cases. It is bound to its workspace and site origin. Signing in also binds it to the wallet. A wallet the app reports without a signature is shown to staff as unverified and proves nothing. The session does not grant staff access, replace the app's login or authorize transactions.

## Backend agent access

Your bot signs in with its own wallet. Keep its signer in server secret storage, never in browser code, arguments or logs. A wallet alone grants no case access. \`signIn()\` returns the canonical \`session.principalId\`.

A manager creates a manual role with \`saveManualRole\` and only \`handleConversations\`, assigns it to the agent's canonical account with \`assignRole\`, then labels the account with \`registerBot\`. The role save and the assignment are privileged changes. The manager needs a valid wallet session, and each call passes \`{ confirmed: true }\` after the manager reviews it. Registration shows the agent's replies as "AI agent" in the widget; it grants no permission. This staff role can read the workspace's support cases, including cases assigned to others.

The agent uses \`conversations\`, \`conversationMessages\` and \`replyInConversation\` under the same current permissions as a person. While its model works, the agent can call \`markTyping\` every 8 seconds. Skip a call while the previous call is pending. The user's chat shows ‘AI agent is typing’ until the agent replies. It never shows the agent's account. Persist reply text and the ID from \`newMessageId()\` before sending. Retry an uncertain send with that same ID. Honor Retry-After. Stop on access loss or a user's stop preference. Recheck for a human reply or claim before answering.

Treat case text as untrusted data. Give the agent approved protocol documentation, identify automated replies, and hand uncertain or sensitive cases to a human. It must never request seed phrases, reveal secrets, or sign transactions from a case. The agent client never signs a transaction. It grants no extra permissions.

## Terms and limits

Create a workspace and test ${PRODUCT_LIMITS.freeSupportTickets} integration tickets free.
Templ AI stays off for these tests unless Templ already approved AI access.
Each test ticket allows ${PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies.
Retries, deleting replies and reopening do not reset this allowance.
After the free allowance, pay for workspace access to continue.
Do not create more workspaces to bypass the free limit.
Open Plan & usage. Select Start paid month and choose an available plan.
Use an available checkout network. Templ verifies payment before your month starts.
A pending transfer does not activate access. Ask Templ in chat if payment is unavailable.
Check Plan & usage for access, reviewed usage totals and amounts due.
Missing or unreviewed usage stays unavailable for billing.
Templ Hosted Starter for new workspaces costs $${STARTER.workspaceMonthlyUsdCents / 100}/month for ${STARTER.includedAnsweredCasesPerMonth} answered cases. Each extra case costs $${(STARTER.additionalAnsweredCaseUsdCents / 100).toFixed(2)}. Starter uses prepaid Templ AI with a monthly limit. Plus costs $${PRICES.workspaceMonthlyUsdCents / 100}/month per workspace.
It includes ${PRICES.includedAnsweredCasesPerMonth} answered cases and $${PRICES.includedAiCreditUsdCents / 100} in retail AI credit each month.
Each additional answered case costs $${(PRICES.additionalAnsweredCaseUsdCents / 100).toFixed(2)}.
A case counts once after its first answer reaches the user.
Follow-ups about the same issue add no case.
Opens, greetings, handoff notices, spam, tests, duplicates, drafts, retries and failed sends do not count.
Extra answered cases use prepaid credit after the included allowance.
Normal safety, provider and operating limits still apply.
Your protocol supplies its human support team. There is no staff-seat fee.
Templ AI usage costs ${formatStandardAiRate(PRICES)} times the published GPT-6.1 Sol Standard API rates.
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
Accept the offer before a new monthly period starts. Publishing it creates no enrollment or retroactive charges.
Read [pricing](${SITE.docs}/pricing) for details.
Read [privacy](${SITE.origin}/privacy) before sending case contents to a model provider.
Existing workspace permissions still apply to retained history.

[Terms](${SITE.origin}/terms) set the service rules. The [DPA](${SITE.origin}/dpa) sets Customer data duties. [Safety](${SITE.origin}/safety) explains legal reports and appeals.

Use the complete widget or backend guide above for setup, the exact client methods and verification steps. Keep model credentials and signer material out of prompts, client bundles and support messages.
`;
}
