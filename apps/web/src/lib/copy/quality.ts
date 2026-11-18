/** Words for answer quality (the Quality tab and the thread panel), eval
 * cases, the protocol profile, support knowledge and the pilot preset. Checked against the
 * no-ai-slop eval: plain actions, no puffery, stacked points for
 * multi-part notes. */
import type {
  KnowledgeEraTag,
  ProfileStatus,
  ProfileVisibility,
} from "@templ/chat/protocol-profile";
import {
  REPLY_LABEL_TEXT,
  RUBRIC_TEXT,
  sampleReasonText,
  type GapState,
  type ReplyLabel,
  type ReviewState,
  type RubricItem,
  type SampleReason,
  type TrendDimension,
} from "@templ/chat/support-quality";
import type { RuleId } from "@templ/chat/diagnosis/types";
import type {
  DeidCheck,
  EvalState,
  PlaceholderKind,
} from "@templ/chat/support-eval";
import { messages } from "./messages";

export const QUALITY_COPY = {
  error: "That didn't work. Try again.",
  saved: "Saved.",
  retry: "Try again",
  // Pilot preset.
  presetTitle: "Pilot preset",
  presetPoints: [
    "New cases start with AI drafts only for the first week. Then the AI agent answers again.",
    "When a user shares a transaction, the AI agent writes drafts only on that case.",
    "Templ samples 10% of resolved cases for review.",
    "It also samples AI transaction answers, replies labeled unsafe and cases users said were not solved.",
    "It samples at most 25 cases a week.",
    "Your team picks a category before resolving.",
  ],
  presetApply: "Use the pilot preset",
  presetActive: (date: string) => `AI drafts only until ${date}.`,
  presetLift: "Let the AI agent answer now",
  presetLifted: "The AI agent answers new cases again.",
  presetTransactions: "Drafts only when the user shares a transaction",
  presetConfirm: "Changing the preset asks for a valid wallet session.",
  // Quality settings.
  qualityTitle: "Answer reviews",
  qualityDescription:
    "Sample resolved cases so a person on your team checks the answer.",
  randomPercent: "Sample this share of resolved cases at random",
  weeklyCap: "At most this many a week",
  requireCategory: "Ask for a category before resolving",
  evalAgentAccess: "Let AI agents download eval cases and post results",
  evalAgentHint:
    "Your agent signs in with its own wallet. Keep its key in your own secret store.",
  saveQuality: "Save review settings",
  percentInvalid: "Enter a whole number from 0 to 100.",
  capInvalid: (max: number) => `Enter a whole number from 1 to ${max}.`,
  categoryInSettings:
    "Settings controls whether a case needs a category before it's resolved.",
  openCaseSettings: "Open case handling",
  // Transaction cases.
  transactionsTitle: "Transaction cases",
  transactionsDescription:
    "Start cases with a shared transaction in AI drafts only.",
  transactionsToggle: "Draft transaction replies",
  saveTransactions: "Save setting",
  // The Quality tab.
  // The thread panel.
  panelTitle: "Answer quality",
  panelNote: "Only your team sees labels and reviews.",
  panelEmpty: "No team replies to label in this case yet.",
  panelReview: "Review this case",
  replyBy: (who: string) => `Reply from ${who}`,
  aiAgent: "the AI agent",
  label: "Label",
  labelsGroup: "Labels for this reply",
  saveLabel: "Save label",
  labelSaved: "Label saved.",
  labelCleared: "Label cleared.",
  labeledBy: (who: string) => `Labeled by ${who}`,
  // Reviews.
  reviewsTitle: "Reviews",
  reviewsEmpty:
    "Nothing to review. Sampled cases show up here after they're resolved.",
  reviewViews: { mine: "Assigned to me", open: "Open", done: "Done" },
  openRequest: "Open case",
  reviewThis: "Review this case",
  pass: "Pass",
  fail: "Fail",
  na: "Doesn't apply",
  note: "Note (only your team sees it)",
  saveReview: "Save review",
  skip: "Skip",
  take: "Take this review",
  overdue: "Over a week old",
  // Trends and gaps.
  trendsTitle: "Recurring problems",
  trendsSince: (date: string) =>
    `Categories and tags count from ${date}, when quality tracking started.`,
  trendsEmpty: "No cases in this period yet.",
  trendsPeriod: "Period",
  trendsColumns: {
    name: "Name",
    weeks: "Weekly cases",
    total: "Total",
    change: "Change",
  },
  trendsPoints: [
    "Bars show cases per week, oldest first. Weeks start on Monday, UTC.",
    "Each row's bars scale to that row's busiest week. The first and last weeks can be partial.",
    "Total is the row's cases in the selected period.",
  ],
  trendsChange: (last: string, previous: string) =>
    `Change is the week of ${last} minus the week of ${previous}.`,
  trendsChangeLater: "Change shows after two complete weeks.",
  trendsWeek: (week: string, n: number) =>
    `Week of ${week}: ${n} ${n === 1 ? "case" : "cases"}`,
  checkResult: (text: string) => `Check result: ${text}`,
  gapsTitle: "Knowledge gaps",
  gapsPoints: [
    "Closed cases with wrong or unsupported replies, missing evidence, or an unsure AI handoff.",
    "Grouped by category and product. Counts and case links only.",
  ],
  gapsEmpty: "No gaps this month.",
  gapCases: (n: number) => (n === 1 ? "1 case" : `${n} cases`),
  uncategorized: "Uncategorized",
  samples: "Sample cases",
  sample: (n: number) => `Case ${n}`,
  openSample: (n: number, total: number, group: string) =>
    `Open sample case ${n} of ${total} for ${group}`,
  docsUpdated: "Docs updated",
  notAGap: "Not a gap",
  reopen: "Reopen",
  // Eval cases.
  evalsTitle: "Eval cases",
  evalsCount: (golden: number, candidates: number) =>
    `${golden} in the golden set, ${candidates} candidates`,
  evalsEmpty:
    "No eval cases yet. Open a case, label a reply, then save it as an eval case.",
  addGolden: "Add to golden set",
  retire: "Retire",
  restore: "Restore",
  remove: "Delete",
  download: "Download golden set (JSONL)",
  runsTitle: "Runs",
  runsEmpty:
    "No runs yet. Download the golden set, run your agent on it and post the results.",
  runLine: (passed: number, total: number) => `${passed} of ${total} passed`,
  regressions: (n: number) => `${n} newly failing`,
  // Eval dialog.
  saveEvalTitle: "Save an eval case",
  saveEvalPoints: [
    "Templ swapped wallets, transaction hashes, emails, ENS names, handles, dates and block numbers for placeholders.",
    "Amounts are rounded. Percentages stay.",
    "Check the flagged parts and the user's name before you save.",
  ],
  replacedLine: (parts: string[]) => `Replaced: ${parts.join(", ")}.`,
  replacedKind: ([one, many]: readonly [string, string], n: number) =>
    `${n} ${n === 1 ? one : many}`,
  checkTitle: "Flagged for you to check",
  removeName: "Remove a name",
  removeNameHint:
    "A name Templ missed. It becomes <MEMBER> everywhere in this copy.",
  removeNameButton: "Remove",
  evalConfirm:
    "I checked this copy. It names no person, wallet or transaction.",
  saveEval: "Save eval case",
  evalSaved:
    "Saved as a candidate. A support lead can add it to the golden set.",
  saveAsEval: "Save as eval case",
  clearLabel: "Clear label",
  conversation: "Case",
  labeledReply: "The reply you labeled",
  approvedAnswer: "Approved answer",
  expectedAction: "What a good answer does",
  actions: {
    answer: "Answers it",
    clarify: "Asks one question first",
    handoff: "Hands it to a person",
  },
  roles: { member: "User", agent: "AI agent", person: "Team" },
  contractsTitle: "Contracts",
  contractsFilter: "Status",
  contractsAll: "All",
  contractsEmpty: "No contracts with this status.",
  // Protocol profile.
  profileTitle: "Protocol",
  profileIntro:
    "Contracts, products and metrics your team and AI agent can look up by address.",
  profileCounts: (contracts: number, metrics: number, abis: number) =>
    `${contracts} contracts, ${metrics} metrics, ${abis} ABIs`,
  importTitle: "Import contracts",
  importHint: "Upload a JSON or CSV file with up to 10,000 contracts.",
  importDiff: (a: number, c: number, u: number, e: number) =>
    `${a} new, ${c} changed, ${u} unchanged, ${e} rows with problems`,
  importApply: "Apply import",
  importMerge: "Merge",
  importReplace: "Replace imported contracts",
  importRow: (row: number, field: string) => `Row ${row}: check the ${field}.`,
  registryTitle: "Sync from your registry",
  registryHint:
    "Templ reads this HTTPS address once a day and when you press Sync now.",
  registryUrl: "Registry address",
  registrySave: "Save address",
  registrySync: "Sync now",
  registryPaused: (n: number) =>
    `Sync paused. ${n} contracts would change. Check the list, then apply.`,
  registryApply: "Apply this sync",
  officialSites: "Official sites",
  officialSitesHint:
    "Migration guides must link to one of these. One per line.",
  saveSites: "Save sites",
  // Knowledge.
  aiGuidance: "AI guidance",
  aiGuidanceHint:
    "Set tone and when to ask a person. AI still needs clear sources and follows Templ’s safety rules.",
  saveAiGuidance: "Save guidance",
  knowledgeTitle: "AI knowledge",
  knowledgeDescription:
    "AI uses this workspace’s sources and checked transaction facts. It passes unclear questions to a person.",
  knowledgeWarning:
    "Treat AI instructions and sources as public. AI replies can include them. Never add keys, recovery phrases, passwords or private documents.",
  addSource: "Add source",
  sourceType: "Source type",
  knowledgePoints: [
    "Pages refresh once a day. A page that disappears keeps its last copy.",
    "Older-product sources answer only for a case that names one of their addresses.",
  ],
  knowledgeEmpty: "No sources yet.",
  addPage: "Add docs page",
  addSitemap: "Add a sitemap",
  addFaq: "Add FAQ entry",
  pageUrl: "Page address",
  question: "Question",
  answer: "Answer",
  addresses: "Contract addresses for older products",
  addressesHint:
    "One per line. Needed when the source is about an older product.",
  refresh: "Refresh",
  sitemapAdded: (added: number) =>
    `${added} pages added. Templ reads them over the next hours.`,
  cancel: "Cancel",
  sourcePending: "Waiting to read",
  sourceArchived: "Archived copy",
  sourceGone: "The page is gone",
  sourceFailed: "Couldn't read it",
  nothingChanged: "Nothing changed.",
  contractsSaved: (n: number) => `${n} contracts saved.`,
  syncApplied: (added: number, changed: number) =>
    `${added} new, ${changed} changed.`,
} as const;

export const REVIEW_STATE_TEXT: Record<ReviewState, string> = {
  queued: "Waiting",
  "in-review": "In review",
  scored: "Reviewed",
  skipped: "Skipped",
};
export const GAP_STATE_TEXT: Record<GapState, string> = {
  open: "Open",
  "docs-updated": "Docs updated",
  "not-a-gap": "Not a gap",
};
export const ERA_TEXT: Record<KnowledgeEraTag, string> = {
  current: "Current",
  legacy: "Older product",
};
export const VISIBILITY_TEXT: Record<ProfileVisibility, string> = {
  "member-safe": "Users can see it",
  "staff-only": "Team only",
};
export const STATUS_TEXT: Record<ProfileStatus, string> = {
  live: "Live",
  deprecated: "Deprecated",
  "withdraw-only": "Withdraw only",
  migrated: "Migrated",
};
export const EVAL_STATE_TEXT: Record<EvalState, string> = {
  candidate: "Candidate",
  golden: "In golden set",
  retired: "Retired",
};
/** What the de-identifier swapped: one, many. */
export const PLACEHOLDER_TEXT: Record<PlaceholderKind, [string, string]> = {
  address: ["address", "addresses"],
  transaction: ["transaction", "transactions"],
  email: ["email", "emails"],
  ens: ["ENS name", "ENS names"],
  handle: ["handle", "handles"],
  url: ["link", "links"],
  phone: ["phone number", "phone numbers"],
  ip: ["IP address", "IP addresses"],
  member: ["user name", "user names"],
  team: ["team name", "team names"],
  time: ["time", "times"],
  date: ["date", "dates"],
  block: ["block number", "block numbers"],
};
/** Why the de-identifier flagged an excerpt. */
export const CHECK_TEXT: Record<DeidCheck["kind"], string> = {
  number: "Long number",
  block: "Block number",
  date: "Date",
  url: "Link",
  base58: "Account or signature",
};
const RESOLVED_BY_TEXT: Record<string, string> = {
  member: "The user",
  person: "Your team",
  bot: "The AI agent",
};
const CONFIRMATION_TEXT: Record<string, string> = {
  solved: "Solved",
  "not-solved": "Not solved",
};
/** Transaction check rules in words, following the staff text in
 * `@templ/chat/diagnosis/templates`. */
const CHECK_RESULT_TEXT: Record<RuleId, string> = {
  "dx.unavailable": "Couldn't check the transaction",
  "dx.disagree": "Providers disagree",
  "dx.input-invalid": "Chain data failed Templ's checks",
  "dx.hint-mismatch": "Picked network doesn't match",
  "dx.wallet-signed-match": "Sent from the signed wallet",
  "dx.wallet-claimed-match": "Sent from the app-reported wallet",
  "dx.wallet-signed-mismatch": "Not sent from the signed wallet",
  "dx.wallet-claimed-mismatch": "Not sent from the app-reported wallet",
  "evm.not-found": "Transaction not found",
  "evm.probe-unavailable": "A network couldn't be checked",
  "evm.vanished": "Dropped from the mempool",
  "evm.other-network": "Found on another network",
  "evm.unexpected-network": "Found outside the profile's networks",
  "evm.found-on-several": "Same hash on several networks",
  "evm.pending": "Waiting to go into a block",
  "evm.nonce-gap": "Waiting behind earlier transactions",
  "evm.underpriced": "Max fee below the base fee",
  "evm.replaced": "Replaced or cancelled",
  "evm.revert.error-string": "Reverted with the contract's message",
  "evm.revert.panic": "Reverted with a Solidity panic",
  "evm.revert.custom-known": "Reverted with a known error",
  "evm.revert.custom-verified": "Reverted with a verified-source error",
  "evm.revert.unknown-selector": "Reverted with an unnamed error",
  "evm.revert.no-data": "Reverted without a reason",
  "evm.revert.not-reproduced": "Failed, but the replay succeeded",
  "evm.revert.no-replay": "Failed, reason couldn't be read",
  "evm.out-of-gas": "Ran out of gas",
  "evm.succeeded": "Succeeded on EVM",
  "evm.not-finalized": "Not final yet",
  "evm.token-movement": "Token movements",
  "evm.approval-only": "Only an approval went through",
  "evm.unlimited-approval": "Unlimited approval",
  "evm.vault-deposit": "Vault deposit",
  "evm.vault-withdraw": "Vault withdrawal",
  "evm.swap": "EVM swap",
  "evm.no-movement": "Succeeded, no token moved",
  "evm.call-to-empty-address": "Called an address with no contract",
  "evm.recipient-code-elsewhere": "Contract only on another network",
  "evm.sent-to-token-contract": "Sent to the token contract",
  "evm.sent-to-protocol-contract": "Plain transfer to a protocol contract",
  "evm.bridge-source": "EVM bridge step went through",
  "evm.contract-creation": "Created a contract",
  "evm.relayed-userop": "Sent by an ERC-4337 bundler",
  "evm.userop-failed": "Smart account operation failed",
  "evm.logs-truncated": "EVM logs cut short",
  "sol.not-found": "Signature not found",
  "sol.expired": "Expired before it ran",
  "sol.processed": "Not confirmed yet",
  "sol.succeeded": "Succeeded on Solana",
  "sol.not-finalized": "Confirmed, not finalized yet",
  "sol.token-movement": "Token balance changes",
  "sol.sol-movement": "SOL sent or received",
  "sol.swap": "Solana swap",
  "sol.approval-only": "Only a token delegate was set",
  "sol.unlimited-approval": "Unlimited token delegate",
  "sol.program-error.anchor": "Program error with a message",
  "sol.program-error.known": "Known program error",
  "sol.program-error.custom": "Unnamed program error",
  "sol.instruction-error": "Instruction failed",
  "sol.insufficient-funds": "Not enough funds in an account",
  "sol.compute-exceeded": "Used up its compute limit",
  "sol.insufficient-fee": "Fee payer couldn't cover the fee",
  "sol.insufficient-rent": "Below Solana's minimum balance",
  "sol.tx-error": "Transaction error",
  "sol.fee": "Fee paid",
  "sol.bridge-source": "Solana bridge step went through",
  "sol.no-movement": "Succeeded, no balance changed",
  "sol.logs-truncated": "Solana logs cut short",
};
/** A known check rule in words, or null for a rule this page can't name. */
export function checkResultText(rule: string): string | null {
  return Object.hasOwn(CHECK_RESULT_TEXT, rule)
    ? CHECK_RESULT_TEXT[rule as RuleId]
    : null;
}
/** A trend row's key in words. Categories, tags and action types are the
 * workspace's own words and show as they are. An unknown check rule keeps
 * its code. */
export function trendKeyText(dimension: TrendDimension, key: string): string {
  if (key === "other") return "Other";
  switch (dimension) {
    case "label":
      return REPLY_LABEL_TEXT[key as ReplyLabel] ?? key;
    case "rubric":
      return RUBRIC_TEXT[key as RubricItem]?.label ?? key;
    case "handoff":
      return (
        (messages as Record<string, string>)[`room.handoff.reason.${key}`] ??
        key
      );
    case "diagnosis-rule":
      return checkResultText(key) ?? key;
    case "resolved-by":
      return RESOLVED_BY_TEXT[key] ?? key;
    case "confirmation":
      return CONFIRMATION_TEXT[key] ?? key;
    default:
      return key;
  }
}
/** Why a case was sampled, with check rules and handoff reasons in words. */
export function reviewReasonText(reason: SampleReason): string {
  return reason.kind === "diagnosis-rule"
    ? QUALITY_COPY.checkResult(trendKeyText("diagnosis-rule", reason.rule))
    : sampleReasonText(reason, {
        handoff: (key) => trendKeyText("handoff", key),
      });
}
