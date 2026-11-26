/** Current commercial offer. Every price, capacity and history allowance
 * shown anywhere derives from this file.
 * Constants only: the release source gate rejects functions, arrays, booleans
 * and imports here. PRODUCT_OFFER_VERSION identifies the runtime catalog. */

/** Common account pacing and message size. Linked identities share
 * message/search budgets across workspaces. Support workspace bounds come
 * from PRODUCT_LIMITS. */
export const OPERATIONAL_LIMITS = {
  messageIntervalSeconds: 5,
  messageMaxBytes: 4_000,
  /** Physical SQLite write headroom for one workspace object, not a history
   * allowance. A Free Workers account has a 1 GB/object ceiling; Paid has
   * 10 GB/object. */
  groupStorageWriteLimitBytes: 8_000_000_000,
  groupStorageWriteLimitBytesFree: 800_000_000,
  sessionLifetimeDays: 30,
} as const;

/** A per-room pace for new private invitation redemptions, not a member cap.
 * Existing members, manager transfers and ordinary reads do not use it. */
export const PRIVATE_INVITE_ADMISSION_LIMITS = {
  newMembersPerHour: 5_000,
  windowMinutes: 60,
} as const;

/** Team-conversation safeguards for rooms without paid Support state. Product
 * Support uses PRODUCT_LIMITS and separate message/history accounting below.
 * These constants do not prove hosted capacity. */
export const TEAM_CONVERSATION_LIMITS = {
  recordsPerMemberPerRoom: 1,
  openPerRoom: 100,
  retainedRecordsPerRoom: 500,
  memberOpensPerAccountPerDay: 5,
  staffOpensPerAccountPerDay: 10,
  opensPerRoomPerDay: 100,
  /** Guests on one network share this allowance per workspace and rolling day. */
  guestOpensPerIpPerDay: 60,
} as const;

/** The payment terms of the Support offer: the top-up bounds and bonus in
 * PRODUCT_TOP_UP. Payment requests and verified direct-transfer
 * receipts bind this version. Frozen on this date. */
export const PRODUCT_OFFER_VERSION = "2026-09-30";
/** The date the team and AI-only prices were published. A
 * charge records it with the table it went pending under. */
export const PRODUCT_PRICE_VERSION = "2026-10-03";
/** Founder-approved standard offer. Signed terms authorize billing separately;
 * these catalog values grant no access and post no charge on their own. */
export const PRODUCT_STANDARD_PRICES = {
  publishedOn: "2026-10-17",
  workspaceMonthlyUsdCents: 9_900,
  includedAnsweredCasesPerMonth: 500,
  additionalAnsweredCaseUsdCents: 19,
  includedAiCreditUsdCents: 2_000,
  aiRateBasisPoints: 13_000,
  guidedOnboardingUsdCents: 250_000,
  guidedOnboardingWorkdays: 5,
  customWorkHourlyUsdCents: 25_000,
} as const;
// The Starter version is captured on every new Starter payment and paid period.
export const PRODUCT_STARTER_PRICES = {
  publishedOn: "2026-11-19",
  workspaceMonthlyUsdCents: 2_900,
  includedAnsweredCasesPerMonth: 100,
  additionalAnsweredCaseUsdCents: 20,
  includedAiCreditUsdCents: 0,
  aiRateBasisPoints: 13_000,
  // Same token rates. Older workers refuse Starter AI because they cannot enforce its limit.
  aiRateCardVersion: "2026-11-19",
} as const;
/** November 24, 2026. One verified USDC payment covers twelve monthly allowances. */
export const PRODUCT_ANNUAL_PRICES = {
  publishedOn: "2026-11-24",
  months: 12,
  starter: 29_000,
  standard: 99_000,
} as const;

/** Captured offer used by existing accepted periods and pending payment intents. */
export const PRODUCT_STANDARD_RECORDED_PRICES = {
  publishedOn: "2026-10-16",
  workspaceMonthlyUsdCents: 9_900,
  includedAnsweredCasesPerMonth: 500,
  additionalAnsweredCaseUsdCents: 15,
  includedAiCreditUsdCents: 2_000,
  aiRateMultiplier: 2,
} as const;
/** GPT-6.1 Sol Standard API rates. Amounts use USD nanodollars per million tokens.
 * Output already includes reasoning. Aggregate usage before rounding to cents. */
export const PRODUCT_STANDARD_AI_RATES = {
  version: "2026-10-16",
  model: "gpt-6.1-sol",
  inputUsdNanosPerMillion: 2_000_000_000,
  cachedInputUsdNanosPerMillion: 100_000_000,
  cacheWriteInputUsdNanosPerMillion: 2_500_000_000,
  outputUsdNanosPerMillion: 10_000_000_000,
  longContextAboveInputTokens: 272_000,
  longInputMultiplier: 2,
  longOutputMultiplierNumerator: 3,
  longOutputMultiplierDenominator: 2,
  usdNanosPerCent: 10_000_000,
} as const;
/** The lifetime demo starts independently of later catalog publication dates. */
export const PRODUCT_STANDARD_ACCESS_STARTED_ON = "2026-10-14";
/** Captured prices for the approved, fixed noncash monthly qualification scope. */
export const PRODUCT_STANDARD_QUALIFICATION_PRICES = {
  workspaceMonthlyUsdCents: 30_000,
  includedAiResolutionsPerMonth: 100,
  additionalAiResolutionUsdCents: 100,
} as const;
/** Prices used by recorded software usage agreements. New public offers use
 * PRODUCT_STANDARD_PRICES. Existing agreements retain their signed tables. */
export const PRODUCT_PLANNED_USAGE_PRICES = {
  publishedOn: "2026-10-06",
  teamResolutionUsdCents: 0,
  walletVerificationUsdCents: 5,
  transactionCheckUsdCents: 10,
  aiDraftUsdCents: 10,
  featureChargesPerCase: 1,
  templAiResolutionUsdCents: 100,
} as const;
/** Retained imported UTF-8 chunk text. Collection requires separate storage
 * terms, customer opt-in and production evidence. Existing scopes keep their prices. */
export const PRODUCT_BRAIN_STORAGE_PRICE = {
  version: "2026-10-09",
  freeBytesPerWorkspace: 10_000_000,
  bytesPerGb: 1_000_000_000,
  usdCentsPerGbMonth: 100,
} as const;
/** Maximum receivable under a separately signed usage agreement. */
export const PRODUCT_USAGE_PAYMENT_RECIPIENT =
  "0xB1d693B77232D88a3C9467eD5619FfE79E80BCCc";
export const PRODUCT_USAGE_LIMITS = {
  debtLimitCents: 100_000,
} as const;
/** Price per team-handled case, graduated by UTC calendar month.
 * Only team-handled billable cases advance the monthly step.
 * The first `stepOneAfterCases` billable team-handled cases in
 * a month cost `usdCents` each and later cases cost `stepOneUsdCents`. Above
 * `customAboveCasesPerMonth` the Plan tab offers custom terms. A charge keeps
 * the table in force when it went pending. A table that makes any case cost
 * more applies to charges that go pending `priceNoticeDays` after
 * PRODUCT_PRICE_VERSION; a cheaper table applies at once. Teams pay only
 * for resolved cases with a transaction check, verified wallet or AI answer.
 * They use prepaid stablecoins or gated monthly card invoices.
 * There are no seat fees, platform fees or minimums. */
export const PRODUCT_RESOLUTION_PRICE = {
  usdCents: 800,
  stepOneAfterCases: 100,
  stepOneUsdCents: 400,
  customAboveCasesPerMonth: 3_000,
  priceNoticeDays: 30,
} as const;
/** Price for a contributed case resolved without a human staff reply.
 * Registered and managed AI agents use this rate from the first case.
 * AI-only cases use no free-start cases and never advance the team price step.
 * Managed AI still needs the member's Yes and its separate billing proof. */
export const PRODUCT_AI_ONLY_RESOLUTION_PRICE = {
  usdCents: 99,
} as const;
/** Maximum term for a signed order form. */
export const PRODUCT_ORDER_FORM_LIMITS = {
  maxMonths: 24,
} as const;
/** Signed pilots use calendar months in UTC and integer USD cents. */
export const PRODUCT_PILOT_DEFAULTS = {
  durationDays: 90,
  monthlyCapCents: 40_000,
  totalCapCents: 120_000,
  upfrontCents: 10_000,
  maxDurationDays: 365,
  maxCapCents: 25_000_000,
} as const;
/** The first eligible contributed team-handled cases are free, once per billing
 * owner and app domain. Excluded and duplicate cases use none. */
export const PRODUCT_FREE_START = {
  resolvedCases: 3,
} as const;
/** A reviewed founding grant: resolved cases at no charge for `days` after
 * it starts, one per billing owner and at most `maxGrants` ever. */
export const PRODUCT_FOUNDING_CREDIT = {
  cases: 100,
  days: 90,
  maxGrants: 20,
} as const;
/** When a resolved case bills and when it can be disputed. A team resolve
 * goes final `finalAfterDays` after it with no reopen; a member's "solved"
 * is held `memberFinalHours` so a spam mark can still exclude it. The widget
 * asks "Did this solve it?" when a team reply is `askAfterHours` old. One
 * canonical member bills once per `duplicateHours`. */
export const PRODUCT_RESOLUTION_RULES = {
  finalAfterDays: 7,
  memberFinalHours: 24,
  askAfterHours: 24,
  duplicateHours: 24,
  disputeDays: 30,
  autoCreditPercent: 5,
  autoCreditMinimum: 2,
  testAccountsMax: 10,
  testCasesPer30Days: 50,
  spamReviewPercent: 20,
  burstMultiple: 3,
  burstMinimum: 20,
} as const;
/** Prepaid stablecoin balance top-ups, in whole dollars. The part of a top-up left
 * after a negative balance clears earns bonus credit: `bonusTenPercent` from
 * `bonusTenFromUsdCents`, `bonusTwentyPercent` from
 * `bonusTwentyFromUsdCents`. Refunds cover paid amounts of top-ups younger
 * than `refundWindowDays`. The Plan tab suggests the minimum,
 * `suggestedUsdCents` and the first bonus step. */
export const PRODUCT_TOP_UP = {
  minUsdCents: 10_000,
  suggestedUsdCents: 50_000,
  maxUsdCents: 1_000_000,
  stepUsdCents: 100,
  bonusTenFromUsdCents: 200_000,
  bonusTenPercent: 10,
  bonusTwentyFromUsdCents: 1_000_000,
  bonusTwentyPercent: 20,
  refundWindowDays: 365,
} as const;
/** Billing managers hear when `usedPercent` of the balance available after
 * the latest credit is used, when it is all used, and when the balance goes
 * negative, then every `negativeReminderDays` while it stays negative. A
 * workspace that has never had a verified top-up or a reviewed grant also
 * hears when its balance reaches minus `pauseSoonCents`. */
export const PRODUCT_BALANCE_ALERTS = {
  usedPercent: 80,
  negativeReminderDays: 7,
  pauseSoonCents: 1_000,
} as const;
/** A workspace that has never had a verified top-up or a reviewed grant
 * pauses when its balance reaches minus this many cents: the widget refuses
 * new requests and team and AI replies stop, while managers can read,
 * export and top up. A verified top-up that brings the balance to zero or
 * more turns it back on. A workspace with a verified top-up or a grant keeps
 * working at any balance, and only an audited Templ operator can suspend
 * it. */
export const PRODUCT_FREE_NEGATIVE_LIMIT_CENTS = 2_000;
export const PRODUCT_LIMITS = {
  /** Lifetime member-opened cases for integration testing. */
  freeSupportTickets: 10,
  /** Private, owner-initiated AI practice questions per hosted trial workspace. */
  freeAiPracticeQuestions: 25,
  /** Accepted team replies per free integration-test ticket. */
  freeTeamRepliesPerTicket: 3,
  searchesPerMinutePerAccount: 20,
  /** Days of support history every workspace keeps, counted from each
   * request's last message. */
  supportHistoryDays: 365,
  /** Conversation records a funded workspace keeps. */
  supportRetainedRecords: 40_000,
  /** Support messages per UTC calendar month. */
  supportMessagesPerPeriod: 250_000,
  supportMessageMaxBytes: 4_000,
  /** A workspace that has never had a verified top-up or a reviewed grant
   * uses the freeSupport* bounds; after its first one it keeps the full
   * bounds at any balance. */
  freeSupportMessages: 2_500,
  supportOpenRecords: 1_000,
  freeSupportOpenRecords: 25,
  freeSupportRetainedRecords: 100,
  fundedSupportOpensPerRoomPerDay: 500,
  freeSupportOpensPerRoomPerDay: 100,
  staffSupportOpensPerAccountPerDay: 100,
  memberSupportOpensPerAccountPerDay: 10,
} as const;
/** The de-identified improvement copy of finished requests
 * (support-corpus.ts): how long a row stays, how many a workspace keeps,
 * when a request counts as finished, and how much Templ's corpus readers
 * may read. */
export const CORPUS_LIMITS = {
  retentionDays: 730,
  rowsPerWorkspace: 20_000,
  rowBytes: 32_768,
  turns: 24,
  /** An open request with no message for this long is finished. */
  idleDays: 30,
  /** Rows one alarm run builds, and cases it reads to find them. */
  buildsPerRun: 25,
  casesReadPerRun: 200,
  /** More turns than this dropped for a leftover identifier withholds all
   * the text of the request. */
  droppedTurnsMax: 2,
  readers: 3,
  readerRowsPerDay: 500,
  rowsPerRead: 100,
  readLogDays: 730,
  leakSampleRows: 50,
  /** Rows per 100 sampled that may hold a direct identifier before builds
   * pause for every workspace. */
  leakRowsPerHundred: 1,
} as const;
