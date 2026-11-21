import type { SupportIdentity } from "./support-identity";
import type { SupportDiagnosisStatus } from "./support-diagnosis";
import type {
  SupportAppContext,
  SupportAppContextInput,
  SupportFailure,
  SupportSdk,
} from "./support-app-context";
import type { ChatPrincipalId } from "./principal";
import type { WidgetWallet } from "./widget-wallet";
import type { SupportLead } from "./support-lead";

export type SupportState = "open" | "waiting" | "resolved" | "abandoned" | "spam";
/** How the widget member reached the team on their latest message. Only
 * "signed" is proof: "connected" names a wallet the member's app reported,
 * which anyone can claim, and "anonymous" names nothing. */
export type SupportAccessLevel = "anonymous" | "connected" | "signed";
export const SUPPORT_ACCESS_LEVELS: readonly SupportAccessLevel[] = [
  "anonymous",
  "connected",
  "signed",
];
/** The lowest level a workspace accepts for a new widget request. */
export type SupportMinimumLevel = "anyone" | "connected" | "signed";
export const SUPPORT_MINIMUM_LEVELS: readonly SupportMinimumLevel[] = [
  "anyone",
  "connected",
  "signed",
];
export function meetsMinimumLevel(
  level: SupportAccessLevel,
  minimum: SupportMinimumLevel,
): boolean {
  return (
    minimum === "anyone" ||
    level === "signed" ||
    (minimum === "connected" && level === "connected")
  );
}
export type SupportFilter =
  | "unassigned"
  | "mine"
  | "open"
  | "waiting"
  | "resolved"
  | "spam"
  | "all"
  | "abandoned"
  | "archived"
  /** Waiting for a reply now, oldest wait first (case ledger). */
  | "needs-reply"
  /** Open or waiting requests handed to a person. */
  | "needs-person"
  /** Waiting for a reply that a person must write, oldest wait first. */
  | "needs-you"
  /** Waiting for a reply the AI agent is expected to write now, oldest
   * wait first. */
  | "ai-handling"
  /** The team or the AI agent replied last and the member hasn't answered. */
  | "waiting-on-member";
/** Who asked for a person: the AI agent, a person on the team, or the member
 * from the chat. */
export type SupportHandoffBy = "agent" | "person" | "member";
/** Who an open request waits for. Team views only. Worked out when read,
 * never stored; it grants and blocks nothing. */
export type SupportTurn = "person" | "ai" | "member";
/** Why a person must write next. Append-only codes; the turn helper chooses
 * the reason that applies to the request. */
export const SUPPORT_TURN_REASONS = [
  /** A handoff with the reason "person" is open: the member asked from the
   * chat, or the AI agent handed off because they asked. */
  "asked",
  /** Any other open handoff. */
  "handoff",
  /** AI drafts only, and the AI agent added a note after the wait started. */
  "ai-draft",
  "ai-drafts",
  "ai-off",
  /** AI answers, and the AI agent that checked in earlier has been quiet
   * for SUPPORT_LIMITS.agentActiveMs. */
  "agent-offline",
  /** AI answers with an active agent, and the wait is older than
   * SUPPORT_LIMITS.aiReplyGraceMs. */
  "ai-late",
  /** AI answers, and no AI agent is registered or has checked in since
   * Templ last restarted. */
  "no-agent",
  /** The member said the team's answer did not solve their case. */
  "not-solved",
] as const;
export type SupportTurnReason = (typeof SUPPORT_TURN_REASONS)[number];
/** Why a teammate or the AI agent handed a request to a person. A fixed
 * code only: details go in an ordinary internal note. Append-only: stored
 * cases and handoffs keep their codes, so a code is never renamed or
 * removed. */
export const SUPPORT_HANDOFF_REASONS = [
  "quote",
  "privacy",
  "account",
  "billing",
  "legal",
  "safety",
  "transaction",
  "bug",
  "person",
  "unsure",
  "other",
  /** A manual strategy or position action. */
  "strategy",
  /** An access or permission change. */
  "access",
  /** Fund or account recovery. */
  "recovery",
  /** Needs a team decision. */
  "decision",
  /** Needs information only the team holds. */
  "internal",
] as const;
export type SupportHandoffReason = (typeof SUPPORT_HANDOFF_REASONS)[number];
/** Who may write to the member in one request: "answers" lets the
 * workspace's registered AI agent reply; "drafts" keeps it to internal notes,
 * tags and handoffs; "off" keeps it from writing anything there. People on
 * the team are never limited by it and members never see it. */
export const SUPPORT_AI_MODES = ["answers", "drafts", "off"] as const;
export type SupportAiMode = (typeof SUPPORT_AI_MODES)[number];
/** Why a request's AI mode last changed. Codes only. */
export const SUPPORT_AI_MODE_CAUSES = [
  /** A person picked the mode in the chat header. */
  "person-set",
  /** "Take over from AI". */
  "take-over",
  "person-reply",
  "person-claim",
  "person-assign",
  "person-typing",
  /** A new request on a thread a person owns or answered last. */
  "person-thread",
  /** Reserved for the shared-transaction rule; never written yet. */
  "transaction",
] as const;
export type SupportAiModeCause = (typeof SUPPORT_AI_MODE_CAUSES)[number];
/** Team views only. Members never get this object. */
export type SupportAiView = {
  /** The mode for the current request. */
  mode: SupportAiMode;
  /** False while the request follows the workspace default. */
  set: boolean;
  default: SupportAiMode;
  cause?: SupportAiModeCause;
  by?: "person" | "rule";
  changedAt?: string;
  /** Present when a person changed it. */
  changedBy?: ChatPrincipalId;
  /** The workspace registers at least one AI agent. */
  agentRegistered: boolean;
  generateAvailable?: boolean;
  generation?: "queued" | "dispatched" | "answered" | "handed-off" | "cancelled" | "failed";
};
/** The AI mode as the case ledger mirrors it for one request: codes, counts
 * and times only. The enforced value lives on the conversation record. */
export type SupportCaseAi = {
  /** Mode after the latest change in this case. */
  mode: SupportAiMode;
  changes: number;
  /** When AI answers were first disabled in this case, and why. */
  restrictedAt: number | null;
  restrictedCause: SupportAiModeCause | null;
  /** Reserved for AI drafts; always 0 for now. */
  draftRequests: number;
  drafts: number;
  draftsUsed: number;
  draftsEdited: number;
};
/** Optional self-reported handling time, chosen at resolve. */
export const SUPPORT_TIME_SPENT = [
  "under-5",
  "5-15",
  "15-30",
  "30-60",
  "over-60",
] as const;
export type SupportTimeSpent = (typeof SUPPORT_TIME_SPENT)[number];
/** Why a member request was turned away. Counts only; no person, text or IP. */
export const SUPPORT_REFUSAL_REASONS = [
  /** Never funded and the balance reached the free negative limit. */
  "paused",
  /** A Templ operator suspended the workspace. */
  "suspended",
  /** The signed usage agreement's credit limit has been reached. */
  "credit-limit",
  "demo-limit",
  /** Open-request cap (PRODUCT_LIMITS.supportOpenRecords, or the free one). */
  "open-limit",
  /** Retained-record cap. */
  "record-limit",
  /** New requests per workspace per rolling day. */
  "daily-limit",
  /** One account's opens per rolling day. */
  "member-limit",
  /** New guest threads per client network per day. */
  "guest-limit",
  /** The support message ledger for the period. */
  "message-limit",
  /** The support storage journal is full (reason support-storage-busy). */
  "storage-busy",
  /** The widget opened on a website the workspace did not approve. */
  "origin-not-approved",
] as const;
export type SupportRefusalReason = (typeof SUPPORT_REFUSAL_REASONS)[number];
/** Operating bounds of the refusal counts, not an offer term. */
export const SUPPORT_REFUSAL_POLICY = {
  retentionDays: 35,
  /** Dedupe markers kept, one per refused clientId, for the retry window. */
  clientMarkers: 20_000,
  maxCount: 1_000_000,
} as const;
export type SupportRefusalDay = {
  /** YYYY-MM-DD, UTC. */
  day: string;
  counts: Partial<Record<SupportRefusalReason, number>>;
  firstAt: Partial<Record<SupportRefusalReason, string>>;
  lastAt: Partial<Record<SupportRefusalReason, string>>;
  /** Some retries may be counted twice: the dedupe marker store was full. */
  approximate: boolean;
};
export type SupportRefusals = {
  days: SupportRefusalDay[];
  totals: Partial<Record<SupportRefusalReason, number>>;
  approximate: boolean;
  retentionDays: number;
};
/** Events the R2 alert outbox will deliver. No message text, name or wallet. */
export type SupportAlertEvent =
  | {
      type: "handoff";
      conversation: string;
      reason: SupportHandoffReason;
      by: SupportHandoffBy;
      at: number;
    }
  | { type: "refusal"; reason: SupportRefusalReason; day: string; at: number };
/** CAIP-2 style: "eip155:<chain id>" or "solana" (mainnet). */
export type SupportNetwork = `eip155:${number}` | "solana";
/** A member-shared transaction. `network` is absent when an EVM hash came
 * without a chain. */
export type SupportTransaction = { hash: string; network?: SupportNetwork };
/** Maximum failure snapshots held or shared in one thread. */
export const SUPPORT_FAILURE_SNAPSHOT_LIMIT = 3;
/** App-reported wallet and time saved when an action fails. This grants no access. */
export type SupportFailureCapture = {
  capturedAt: string;
  wallet: WidgetWallet | null;
};
/** One failure the app captured at the moment it happened, frozen with the
 * wallet level, network and app details of that moment. */
export type SupportFailureSnapshot = {
  transactions?: SupportTransaction[];
  id: string;
  capturedAt: string;
  wallet: { level: "guest" | "attached" | "verified"; address?: string };
  network?: SupportNetwork;
  app?: SupportAppContext;
  failure?: SupportFailure;
  sdk?: SupportSdk;
};
/** What staff and the member read. `chainId` is derived from `network` and
 * present only for EVM networks. */
export type SupportContext = {
  snapshots?: SupportFailureSnapshot[];
  description?: string;
  network?: SupportNetwork;
  chainId?: number;
  /** Newest first, at most 5, no duplicate hash. */
  transactions?: SupportTransaction[];
  /** Values shared before Templ checked them that are not a known network or
   * a valid hash. Display only: diagnosis, webhooks and agents ignore it. */
  legacy?: { network?: string; transactionHash?: string };
  /** Typed details from the protocol's app. */
  app?: SupportAppContext;
};
/** What a host, the widget, the app or the SDK may send. The fields
 * channelId, ruleId and checkResult are accepted and ignored. */
export type SupportContextInput = {
  snapshots?: SupportFailureSnapshot[];
  description?: string;
  /** "eip155:8453", "solana", or a known name such as "Base" or "Ethereum". */
  network?: string;
  chainId?: number;
  /** One hash or explorer link (the field used before structured context). */
  transactionHash?: string;
  transactions?: { hash: string; network?: string; chainId?: number }[];
  /** Typed details from the protocol's app, each a row the member ticks. */
  app?: SupportAppContextInput;
};
/** The free-text context shape stored before structured context. Read only:
 * `readStoredSupportContext` maps it and nothing writes it. */
export type SupportContextLegacy = {
  description?: string;
  network?: string;
  transactionHash?: string;
  channelId?: string;
  ruleId?: string;
  checkResult?: "eligible" | "ineligible" | "unavailable" | "capacity";
};
export type SupportSummary = {
  identity?: SupportIdentity;
  identityLabel?: string;
  walletUnavailable?: true;
  /** Team-only facts for choosing the next action. */
  journey?: {
    sharedTransaction: boolean;
    uncheckedTransaction: boolean;
    diagnosisStatus?: SupportDiagnosisStatus;
    followUpDue: boolean;
  };
  state: SupportState;
  archivedAt?: string;
  tags: string[];
  category: string | null;
  lastMemberMessageAt: string | null;
  lastStaffReplyAt: string | null;
  unread: boolean;
  reopened: number;
  /** Absent for threads opened from the Templ app rather than a widget. */
  access?: SupportAccessLevel;
  /** Team views only: when the current wait for a reply started. */
  waitingSince?: string;
  /** Team views only: the request was handed to a person and no person has
   * answered it yet. */
  handedOff?: true;
  /** Team views only: the thread belongs to Templ's hourly check ("canary")
   * or to a listed test account ("account"). */
  test?: "canary" | "account";
  /** Team views only: who the open request waits for. Absent when it is
   * resolved or spam. */
  turn?: SupportTurn;
  /** Team views only, with turn "person": the first reason that applies. */
  turnReason?: SupportTurnReason;
  /** Team views only: who wrote the latest message, and when. */
  lastBy?: "member" | "person" | "agent";
  lastAt?: string;
};
export type SupportNote = {
  id: string;
  author: ChatPrincipalId;
  text: string;
  mentions: ChatPrincipalId[];
  at: string;
  /** Team views only: the author is the workspace's registered AI agent
   * now. Worked out when read, never stored. */
  byAgent?: true;
};
export type SupportActivity = {
  id: string;
  actor: ChatPrincipalId;
  action:
    | "status"
    | "assignment"
    | "tags"
    | "note"
    | "context"
    | "attachment"
    | "verification-requested"
    | "wallet-verified"
    | "handoff"
    | "confirmed"
    | "time-spent"
    | "ai-mode";
  at: string;
  /** For handoff the reason code, for confirmed "solved" or "not-solved",
   * for time-spent the bucket, for ai-mode "<mode>:<cause>" such as
   * "drafts:person-reply". */
  detail?: string;
};
export type SupportPresence = {
  principalId: ChatPrincipalId;
  composing: boolean;
  expiresAt: number;
};
export type SupportSavedReply = {
  shortcut?: string;
  id: string;
  title: string;
  text: string;
  updatedAt: string;
};
export type SupportContactRole = "founder" | "assistant";
export type SupportContactProfile = {
  name: string | null;
  image: string | null;
};
export type WorkspaceSupportProfiles = {
  revision: number;
  founder: SupportContactProfile;
  assistant: SupportContactProfile;
  assistantEnabled: boolean;
};
export type VisitorSupportProfiles = {
  founder: SupportContactProfile;
  assistant: SupportContactProfile | null;
};
export type SupportSettings = {
  timezone: string;
  businessHours: string;
  acknowledgment: string;
  categories: string[];
  testAccounts: ChatPrincipalId[];
  /** The AI mode a new request starts in. Absent means "answers". A save
   * that leaves it out keeps the stored value. */
  aiDefault?: SupportAiMode;
};
export type SupportAttachment = {
  id: string;
  /** A team uploader's identity is omitted from member views. */
  author?: ChatPrincipalId;
  at: string;
  bytes: number;
  contentType: "image/png";
};
export type SupportWorkflow = {
  /** Templ's own inbox: human team readers with current case access. */
  lead?: SupportLead;
  entry?: "hosted";
  emailNotices?: boolean;
  summary: SupportSummary;
  context: SupportContext | null;
  /** Server-proven wallet: from the member's latest signed widget message, or
   * from a sign-in made in the same widget session after staff asked. An EVM
   * wallet names the chain it signed on; a Solana wallet has no chain id. */
  wallet?: WidgetWallet & {
    authenticatedAt: string;
    origin: string;
  };
  /** The level of the member's latest widget message. A claimed wallet is
   * what their app reported without proof; it never grants anything. */
  access?: {
    level: SupportAccessLevel;
    walletUnavailable?: true;
    claimedWallet?: WidgetWallet;
    at: string;
  };
  /** Team only: the Solana wallet the member signed in to the Templ app with
   * when they last wrote there. Proven to Templ with Sign In With Solana,
   * not to this team's website; absent once they write another way. */
  appWallet?: {
    network: "solana";
    address: string;
    authenticatedAt: string;
  };
  /** Staff asked this member to prove their wallet and they have not yet. */
  verificationRequested?: boolean;
  attachments: SupportAttachment[];
  settings: Pick<
    SupportSettings,
    "timezone" | "businessHours" | "acknowledgment"
  > & { categories?: string[] };
  notes?: SupportNote[];
  notesNextCursor?: string | null;
  activity?: SupportActivity[];
  presence?: SupportPresence[];
  savedReplies?: SupportSavedReply[];
  staff?: ChatPrincipalId[];
  canManage?: boolean;
  /** Team only: the handling time recorded at the latest resolve. */
  timeSpent?: SupportTimeSpent | null;
  /** Team only: the AI mode of the current request. */
  ai?: SupportAiView;
};
/** "app" means written from the Templ app rather than a widget. */
export type SupportCaseAccess = "app" | SupportAccessLevel;
export type SupportCaseExclusion =
  | "test-account"
  | "staff-preview"
  | "install-preview"
  | "spam"
  | "canary";
export type SupportCaseBillingExclusion = Exclude<SupportCaseExclusion, "spam">;
export type SupportCaseReopenReason =
  | "member-message"
  | "member-reopen"
  | "team-reopen"
  | "member-not-solved";
export type SupportCaseCloser = "member" | "person" | "bot";

/** First worker-recorded step of each kind in this case. */
export type SupportCaseContributions = {
  transactionCheckAt?: number;
  walletVerifiedAt?: number;
  aiAnswerAt?: number;
};
/** One member request: metadata only, never message text, note text, tag
 * text, a wallet address or a transaction hash. It never grants access. Its
 * billing fields decide whether a resolution bills; the charge itself lives
 * in the room's charge ledger. */
export type SupportCase = {
  entry?: "hosted";
  schemaVersion: 1;
  /** tc- id, room-local. */
  thread: string;
  /** 1-based per thread. */
  seq: number;
  source: "live" | "backfill" | "repaired";
  openedAt: number;
  /** Worker records definite checks, member wallet proofs and visible AI answers before resolution. */
  contributions?: SupportCaseContributions;
  /** Level of the message that opened the case. */
  access: SupportCaseAccess;
  /** Highest widget level seen (anonymous < connected < signed); "app" stays "app". */
  verification: SupportCaseAccess;
  verificationRequestedAt: number | null;
  verifiedAt: number | null;
  context: { sharedAt: number | null; network: boolean; transaction: boolean };
  firstReplyAt: number | null;
  firstHumanReplyAt: number | null;
  firstBotReplyAt: number | null;
  lastMemberAt: number;
  lastReplyAt: number | null;
  lastHumanReplyAt: number | null;
  awaitingSince: number | null;
  handoffAt: number | null;
  handoffReason: SupportHandoffReason | null;
  handoffBy: SupportHandoffBy | null;
  /** True from a handoff until a person replies or the case closes. */
  handoffOpen: boolean;
  handoffClearedAt: number | null;
  waitingOnMemberMs: number;
  waitingOnMemberSince: number | null;
  resolvedAt: number | null;
  resolvedBy: SupportCaseCloser | null;
  resolvedByPrincipal?: ChatPrincipalId | null;
  abandonedAt?: number | null;
  lastMessageBy?: "member" | "team";
  /** Case-local pilot signals: times and counts only. */
  metrics?: {
    firstUsefulAt?: number;
    clarifyTurns?: number;
    contextReadyAt?: number;
    lastContextAt?: number;
    handlingMs?: number;
    diagnosisRatedWrong?: number;
    actionCompleted?: boolean;
    outcomeConsent?: boolean;
  };
  firstResolvedAt: number | null;
  reopens: number;
  lastReopenAt: number | null;
  lastReopenReason: SupportCaseReopenReason | null;
  stoppedAt: number | null;
  /** The member's answer to "Did this solve it?" for this case. */
  confirmation: "solved" | "not-solved" | null;
  confirmedAt: number | null;
  timeSpent: SupportTimeSpent | null;
  counts: {
    memberMessages: number;
    humanReplies: number;
    botReplies: number;
    notes: number;
    assignments: number;
  };
  /** Sorted, unique. */
  excluded: SupportCaseExclusion[];
  /** Why this case never bills, written once when a member message opens
   * it and never refreshed: Templ's check, a staff preview or a listed test
   * account (within the test cap). Null when it can bill. A case without
   * this field never bills. */
  billingExclusion?: SupportCaseBillingExclusion | null;
  /** A person's reply or a registered AI agent's accepted answer.
   * Handoff events and automatic acknowledgments are not replies. */
  billingReplies?: number;
  /** The worker recorded an accepted answer from Templ's managed AI. */
  billingManagedReplyAt?: number;
  /** Reserved for R2 pilot incident windows. */
  incident: null;
  /** Present from the first AI mode change in this case. */
  ai?: SupportCaseAi;
};
/** The team's live queue: counts and times only, no thread or person.
 * `needsReplyMore` covers the split counts too: `needsYou` plus
 * `aiHandling` always equals `needsReply`. */
export type SupportPulse = {
  schemaVersion: 1;
  needsReply: number;
  needsReplyMore: boolean;
  oldestWaitingSince: string | null;
  newestWaitingSince: string | null;
  handedOff: number;
  /** Waiting requests a person must answer (turn "person"). */
  needsYou: number;
  /** The oldest and newest waits a person must answer, from the requests
   * read (the counted ones plus the newest wait); null when none of those
   * needs a person. */
  needsYouOldestSince: string | null;
  needsYouNewestSince: string | null;
  /** Waiting requests the AI agent is expected to answer now (turn "ai"). */
  aiHandling: number;
  /** The workspace registers an AI agent that is on the team. */
  agentRegistered: boolean;
  /** That agent listed its queue or used a thread within
   * SUPPORT_LIMITS.agentActiveMs. */
  agentActive: boolean;
  /** Its latest such request, or null when it has made none since Templ
   * last restarted. */
  agentSeenAt: string | null;
  open: number;
  complete: boolean;
  at: string;
};
/** Pulse schema 2 adds counts of requests waiting on the member or team,
 * and overdue follow-ups. */
export type SupportPulseV2 = Omit<SupportPulse, "schemaVersion"> & {
  schemaVersion: 2;
  /** Open threads whose next turn belongs to the member. */
  waitingOnMember: number;
  waitingOnMemberMore: boolean;
  /** Threads with an open follow-up now. */
  waitingOnTeam: number;
  waitingOnTeamMore: boolean;
  followUpsOverdue: number;
  followUpsOverdueMore: boolean;
};
export type SupportReportWindow = "7d" | "30d" | "90d" | "all";
export const SUPPORT_REPORT_WINDOWS: readonly SupportReportWindow[] = [
  "7d",
  "30d",
  "90d",
  "all",
];
export type SupportReport = {
  schemaVersion: 2;
  window: SupportReportWindow;
  /** Null for "all". */
  from: string | null;
  to: string;
  /** Cases opened in the window, excluded cases left out. */
  requests: number;
  /** Waiting for a reply now, excluded cases left out. Not windowed. */
  unanswered: number;
  /** Cases opened in the window that are closed as resolved now. */
  resolved: number;
  /** Cases opened in the window reopened at least once. */
  reopened: number;
  /** First reply by a person. */
  medianFirstResponseMs: number | null;
  /** First reply of any kind, AI agent included. */
  medianFirstReplyMs: number | null;
  /** Spam, test accounts, staff previews and canary cases in the window. */
  excluded: number;
  /** More than SUPPORT_LIMITS.reportCaseScan cases in the window. */
  truncated: boolean;
  /** The case ledger is ready. */
  complete: boolean;
  includesArchivedHistory: false;
};
export const SUPPORT_LIMITS = {
  hostedDomainCandidates: 20,
  guestReturnPathChars: 512,
  guestLinkMs: 86_400_000,
  screenshotBytes: 2_097_152,
  screenshotPixels: 4_194_304,
  screenshotDimension: 4096,
  screenshotsPerConversation: 20,
  freeScreenshotStorageBytes: 20_971_520,
  fundedScreenshotStorageBytes: 1_073_741_824,
  notesPerConversation: 1000,
  savedReplies: 100,
  tagsPerConversation: 10,
  categories: 30,
  staffAccounts: 100,
  /** A member message this soon after a resolution reopens that case. */
  caseReopenDays: 7,
  caseAbandonDays: 14,
  composeIntervalMaxMinutes: 30,
  composeIdleMs: 30_000,
  reportCaseScan: 5_000,
  ledgerBackfillBatch: 20,
  casePruneBatch: 100,
  /** AI mode changes in one request; the next one is refused. */
  aiModeChangesPerCase: 50,
  /** A request in AI answers moves to Needs you when no reply came this
   * long after its wait started. */
  aiReplyGraceMs: 180_000,
  /** An AI agent counts as active this long after it last listed its queue
   * or used a thread. The same window lets a member see "AI agent is
   * typing" right after their message. */
  agentActiveMs: 60_000,
  /** The longest a member sees "AI agent is typing" after their message
   * before the agent marks typing itself. */
  agentPickupMs: 90_000,
} as const;
