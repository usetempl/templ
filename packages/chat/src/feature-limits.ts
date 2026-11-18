/**
 * Operating limits for features that ship behind release flags. They live
 * apart from PRODUCT_LIMITS so the public agent client and /api/status do not
 * list the terms of a feature that is not live. /api/status publishes a limit
 * only while the release flag named in FEATURE_LIMIT_FLAGS is true; a limit
 * mapped to null is internal and never published.
 */
export const FEATURE_LIMITS = {
  guestEmailConfirmationsPerDay: 3,
  guestResumeLinksPerDay: 10,
  /** Transaction checks per workspace per UTC day, people and AI agents
   * together; a workspace never funded gets fewer. */
  diagnosisRunsPerRoomPerDay: 60,
  freeDiagnosisRunsPerRoomPerDay: 15,
  diagnosisRunsPerThreadPerDay: 15,
  /** Checks started without a person: a member's shared transaction or an
   * Ask AI request. */
  diagnosisAutoRunsPerThreadPerDay: 3,
  diagnosisStoredPerThread: 3,
  /** Runs that only refuse a pasted key, before any chain read. */
  keyGuardRunsPerRoomPerDay: 100,
  /** Upstream RPC calls one check may make. */
  rpcCallsPerRun: 96,
  /** A check starts only while this share of the workspace's monthly RPC
   * budget is still unused. */
  diagnosisBudgetHeadroomPercent: 50,
  /** Reviewed grants: Templ's own operator grant runs at most
   * `operatorMaxDays`; every other kind holds resolved cases for at most
   * `grantMaxDays`, at most `grantMaxCases` per kind and workspace plus one
   * extension. The founding credit's cases and days come from plans.ts. */
  operatorMaxDays: 365,
  grantMaxDays: 90,
  grantMaxCases: 1_000,
  grantExtendsPerKind: 1,
  /** Entries the reviewed grant list may hold, and the days after approval
   * within which a listed grant may still credit. */
  grantListMaxEntries: 20,
  grantCreditWithinDays: 30,
  /** Follow-ups that close on chain state, per workspace. */
  supportWatchesPerWorkspace: 200,
  /** Team alerts per workspace: destinations of every kind, queued events,
   * and deliveries per UTC day. */
  alertDestinationsPerWorkspace: 8,
  alertPendingEvents: 1_000,
  alertDeliveriesPerDay: 5_000,
  /** Managed AI spend per workspace per month. At zero the runner makes no
   * outbound call. */
  managedAgentMonthlySpendUsdCents: 5_000,
  /** Whole-workspace export. */
  workspaceExportStartsPerDay: 3,
  workspaceExportThreadsPerPage: 25,
  workspaceExportMessagesPerPage: 100,
  workspaceExportNotesPerPage: 50,
  workspaceExportCursorHours: 24,
  /** Metrics CSV: the longest window and requests per workspace per hour. */
  metricsExportMaxDays: 92,
  metricsExportsPerHour: 6,
  knowledgeImportRowsPerFile: 200,
  savedReplyImportRowsPerFile: 200,
  installCheckTokenMinutes: 15,
  installCheckActionMinutes: 2,
  installCheckPollMs: 2_000,
  installCheckRunMinutes: 15,
  /** How long the outage step keeps noting errors after a failed open. */
  installCheckOutageSeconds: 5,
  /** Install-check preview cases left unbilled per workspace in a rolling
   * 30 days; later previews bill like any case. */
  installPreviewsPer30Days: 10,
  /** Screenshots a member attaches from the widget. */
  memberScreenshotMaxBytes: 2_000_000,
  memberScreenshotsPerRequest: 5,
} as const;

export type FeatureLimit = keyof typeof FEATURE_LIMITS;

/** The release flag that publishes each limit. Null keeps a limit out of
 * /api/status: it is internal, or its feature has no flag of its own yet. */
export const FEATURE_LIMIT_FLAGS = {
  guestEmailConfirmationsPerDay: "notificationDeliveryProved",
  guestResumeLinksPerDay: "notificationDeliveryProved",
  diagnosisRunsPerRoomPerDay: "supportDiagnosisVerified",
  freeDiagnosisRunsPerRoomPerDay: "supportDiagnosisVerified",
  diagnosisRunsPerThreadPerDay: "supportDiagnosisVerified",
  diagnosisAutoRunsPerThreadPerDay: "supportDiagnosisVerified",
  diagnosisStoredPerThread: "supportDiagnosisVerified",
  keyGuardRunsPerRoomPerDay: null,
  rpcCallsPerRun: null,
  diagnosisBudgetHeadroomPercent: null,
  operatorMaxDays: null,
  grantMaxDays: "productGrantsVerified",
  grantMaxCases: "productGrantsVerified",
  grantExtendsPerKind: "productGrantsVerified",
  grantListMaxEntries: null,
  grantCreditWithinDays: null,
  supportWatchesPerWorkspace: "supportFollowUpsVerified",
  alertDestinationsPerWorkspace: "supportAlertsVerified",
  alertPendingEvents: null,
  alertDeliveriesPerDay: "supportAlertsVerified",
  managedAgentMonthlySpendUsdCents: null,
  workspaceExportStartsPerDay: "workspaceExportVerified",
  workspaceExportThreadsPerPage: "workspaceExportVerified",
  workspaceExportMessagesPerPage: "workspaceExportVerified",
  workspaceExportNotesPerPage: "workspaceExportVerified",
  workspaceExportCursorHours: "workspaceExportVerified",
  metricsExportMaxDays: "workspaceExportVerified",
  metricsExportsPerHour: "workspaceExportVerified",
  knowledgeImportRowsPerFile: null,
  savedReplyImportRowsPerFile: null,
  installCheckTokenMinutes: "installCheckVerified",
  installCheckActionMinutes: "installCheckVerified",
  installCheckPollMs: "installCheckVerified",
  installCheckRunMinutes: "installCheckVerified",
  installCheckOutageSeconds: "installCheckVerified",
  installPreviewsPer30Days: "installCheckVerified",
  memberScreenshotMaxBytes: null,
  memberScreenshotsPerRequest: null,
} as const satisfies Record<FeatureLimit, string | null>;

/** The feature limits whose release flag is true in `release`. */
export function liveFeatureLimits(
  release: Readonly<Record<string, unknown>>,
): Partial<Record<FeatureLimit, number>> {
  const live: Partial<Record<FeatureLimit, number>> = {};
  for (const name of Object.keys(FEATURE_LIMITS) as FeatureLimit[]) {
    const flag = FEATURE_LIMIT_FLAGS[name];
    if (flag !== null && release[flag] === true)
      live[name] = FEATURE_LIMITS[name];
  }
  return live;
}
