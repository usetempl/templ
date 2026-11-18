import type { BrainStorageLedger, BrainStorageView } from "@templ/chat/knowledge";
import type { LearnedFaqCorrectionSource, LearnedFaqCorrectionView } from "@templ/chat/support-learning";
/** The app's calls for answer quality, eval cases, the protocol profile,
 * support knowledge and the pilot preset. Each route checks the viewer's
 * current access in the workspace; the app only shows what it gets back. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRoomId } from "@templ/chat/index";
import type {
  PilotPresetView,
  ReplyLabel,
  Rubric,
  ReviewSkipReason,
  SupportCaseQualityView,
  SupportKnowledgeGaps,
  SupportQualityOverview,
  SupportQualitySettings,
  SupportReviewItem,
  SupportTrends,
  TrendWindow,
} from "@templ/chat/support-quality";
import type {
  EvalCaseSummary,
  EvalDraft,
  EvalRunView,
} from "@templ/chat/support-eval";
import type {
  KnowledgeEraTag,
  KnowledgeOverview,
  KnowledgeSourceView,
  ProfileContract,
  ProfileContractInput,
  ProfileMetric,
  ProfileSettingsView,
  ProfileVisibility,
  RegistryResult,
} from "@templ/chat/protocol-profile";
import type { WorkspaceAiGuidance } from "@templ/chat/knowledge";
import { chatMutation } from "./chat-api";
import { communityFetch, roomPath } from "./community-client";

type Room = ChatRoomId;
type Account = ChatPrincipalId | undefined;
const path = (room: Room, suffix: string) => roomPath(room, `conversations/${suffix}`);

/* Quality ---------------------------------------------------------------- */

export const readQuality = (room: Room, signal?: AbortSignal) =>
  communityFetch<SupportQualityOverview>(path(room, "quality"), undefined, signal);
export const saveQuality = (
  room: Room,
  account: Account,
  settings: Partial<Omit<SupportQualitySettings, "schemaVersion" | "sampling">> & {
    sampling?: Partial<SupportQualitySettings["sampling"]>;
  },
  confirmed = false,
) =>
  chatMutation<SupportQualityOverview>(account, path(room, "quality"), {
    ...settings,
    ...(confirmed ? { confirmed } : {}),
  });
export const readReviews = (
  room: Room,
  view: "mine" | "open" | "done",
  signal?: AbortSignal,
) =>
  communityFetch<{ items: SupportReviewItem[]; next: string | null }>(
    path(room, `reviews?view=${view}`),
    undefined,
    signal,
  );
export const readCaseQuality = (room: Room, thread: string, seq?: number, signal?: AbortSignal) =>
  communityFetch<{ cases: SupportCaseQualityView[]; learningReviewAvailable?: boolean }>(
    path(room, `${thread}/review${seq ? `?seq=${seq}` : ""}`),
    undefined,
    signal,
  );
export const labelReply = (
  room: Room,
  account: Account,
  thread: string,
  message: number,
  labels: ReplyLabel[],
) =>
  chatMutation<{ quality: SupportCaseQualityView }>(account, path(room, `${thread}/review`), {
    action: "label",
    message,
    labels,
  });
export const reviewLearnedSources = (room: Room, account: Account, thread: string, message: number) =>
  chatMutation<LearnedFaqCorrectionView>(account, path(room, `${thread}/review`), {
    action: "review-learned-sources", message,
  });
export const pauseLearnedSource = (room: Room, account: Account, thread: string, message: number, source: LearnedFaqCorrectionSource) =>
  chatMutation<LearnedFaqCorrectionView>(account, path(room, `${thread}/review`), {
    action: "pause-learned-source", message, sourceId: source.id,
    ifUpdatedAt: source.updatedAt, ifGeneration: source.generation, confirmed: true,
  });
export type ReviewActionInput =
  | { action: "take"; seq: number }
  | { action: "sample"; seq: number }
  | { action: "assign-review"; seq: number; reviewer: ChatPrincipalId }
  | { action: "score"; seq: number; rubric: Rubric; note?: string }
  | { action: "skip"; seq: number; reason: ReviewSkipReason };
export const reviewAction = (
  room: Room,
  account: Account,
  thread: string,
  input: ReviewActionInput,
) =>
  chatMutation<{ quality: SupportCaseQualityView }>(account, path(room, `${thread}/review`), input);
export const readTrends = (room: Room, window: TrendWindow, signal?: AbortSignal) =>
  communityFetch<SupportTrends>(path(room, `trends?window=${window}`), undefined, signal);
export const readGaps = (room: Room, month?: string, signal?: AbortSignal) =>
  communityFetch<SupportKnowledgeGaps>(
    path(room, `gaps${month ? `?month=${month}` : ""}`),
    undefined,
    signal,
  );
export const markGap = (
  room: Room,
  account: Account,
  month: string,
  id: string,
  action: "docs-updated" | "not-a-gap" | "reopen",
) => chatMutation<SupportKnowledgeGaps>(account, path(room, "gaps"), { month, id, action });

/* Eval cases ------------------------------------------------------------- */

export const previewEval = (
  room: Room,
  account: Account,
  thread: string,
  message: number,
  options: { keep?: string[]; remove?: string[] } = {},
) =>
  chatMutation<{ draft: EvalDraft }>(account, path(room, `${thread}/evals`), {
    action: "preview",
    message,
    ...options,
  });
export const saveEval = (
  room: Room,
  account: Account,
  thread: string,
  message: number,
  draft: EvalDraft,
) =>
  chatMutation<{ eval: { id: string; state: string } }>(account, path(room, `${thread}/evals`), {
    action: "save",
    message,
    draft,
    confirm: true,
  });
export const readEvals = (
  room: Room,
  query: { state?: string; after?: string } = {},
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return communityFetch<{
    cases: EvalCaseSummary[];
    next: string | null;
    counts: { candidate: number; golden: number; retired: number; total: number };
  }>(path(room, `evals${params.size ? `?${params}` : ""}`), undefined, signal);
};
export const evalAction = (
  room: Room,
  account: Account,
  id: string,
  action: "promote" | "retire" | "restore" | "delete",
) => chatMutation<{ id: string; state: string }>(account, path(room, `evals/${id}`), { action });
export const readEvalRuns = (room: Room, signal?: AbortSignal) =>
  communityFetch<{ runs: EvalRunView[]; next: string | null }>(path(room, "evals/runs"), undefined, signal);
/** Every page of the golden set as JSONL text, for a download. */
export async function exportGoldenSet(room: Room, set: "golden" | "all" = "golden") {
  const lines: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: string = `evals/export?format=json&set=${set}${after ? `&after=${after}` : ""}`;
    const result: { lines: string[]; next: string | null } = await communityFetch(path(room, query));
    lines.push(...result.lines);
    if (!result.next) break;
    after = result.next;
    // Export pages are paced: one per second for each person.
    await new Promise((done) => setTimeout(done, 1_100));
  }
  return `${lines.join("\n")}\n`;
}

/* Protocol profile ------------------------------------------------------- */

export type ProfileView = ProfileSettingsView & { log: RegistryResult[] };
export const readProfile = (room: Room, signal?: AbortSignal) =>
  communityFetch<ProfileView>(path(room, "profile"), undefined, signal);
export const readProfileContracts = (
  room: Room,
  filters: Record<string, string | undefined> = {},
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams(
    Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return communityFetch<{ contracts: ProfileContract[]; next: string | null; invalidRows: number }>(
    path(room, `profile/contracts${params.size ? `?${params}` : ""}`),
    undefined,
    signal,
  );
};
export const saveProfileSettings = (
  room: Room,
  account: Account,
  settings: { expectedNetworks?: string[]; officialUrls?: string[] },
) => chatMutation<ProfileSettingsView>(account, path(room, "profile/settings"), settings);
export type ImportPreview = {
  importId: string;
  mode: "merge" | "replace";
  diff: { added: number; changed: number; removed: number; unchanged: number; errors: number; metrics: number };
  lists: { errors: { row: number; reason: string }[] };
};
/** Uploads a parsed file in parts (a room request carries at most 24 KB)
 * and returns the server's preview. */
export async function uploadProfileImport(
  room: Room,
  account: Account,
  rows: ProfileContractInput[],
  metrics: ProfileMetric[],
  mode: "merge" | "replace",
) {
  const { importId } = await chatMutation<{ importId: string }>(account, path(room, "profile/imports"), {});
  const parts = Math.max(1, Math.ceil(rows.length / 40));
  for (let part = 0; part < parts; part++)
    await chatMutation(account, path(room, `profile/imports/${importId}`), {
      action: "rows",
      rows: rows.slice(part * 40, part * 40 + 40),
      ...(part === 0 ? { metrics } : {}),
    });
  return chatMutation<ImportPreview>(account, path(room, `profile/imports/${importId}`), {
    action: "preview",
    mode,
  });
}
export const applyProfileImport = (
  room: Room,
  account: Account,
  importId: string,
  mode: "merge" | "replace",
) =>
  chatMutation<{ applied: number; removed: number; errors: { row: number; reason: string }[] }>(
    account,
    path(room, `profile/imports/${importId}`),
    { action: "apply", mode, confirmed: true },
  );
export const saveRegistry = (
  room: Room,
  account: Account,
  url: string | null,
  schedule: "daily" | "manual",
) => chatMutation<{ registry: ProfileSettingsView["registry"] }>(account, path(room, "profile/registry"), { url, schedule, confirmed: true });
export const syncRegistry = (room: Room, account: Account) =>
  chatMutation<{ result: RegistryResult }>(account, path(room, "profile/registry/sync"), {});
export const applyRegistry = (room: Room, account: Account) =>
  chatMutation<{ result: RegistryResult }>(account, path(room, "profile/registry/apply"), { confirmed: true });

/* Knowledge -------------------------------------------------------------- */

export const readBrainStorage = (room: Room, signal?: AbortSignal) =>
  communityFetch<BrainStorageView>(path(room, "knowledge/storage"), undefined, signal);
export const readBrainStorageLedger = (room: Room, after?: string, signal?: AbortSignal) =>
  communityFetch<BrainStorageLedger>(path(room, `knowledge/storage-ledger${after ? `?after=${encodeURIComponent(after)}` : ""}`), undefined, signal);

export const confirmBrainStorageAgreement = (
  room: Room, account: Account,
  input: { action: "accept-agreement" | "withdraw-agreement"; requestId: string; agreementId: string; revision: number; documentSha256: string; termsSha256: string },
  assertCurrent?: () => void, signal?: AbortSignal,
) => chatMutation<BrainStorageView>(account, path(room, "knowledge/storage"), { ...input, confirmed: true }, assertCurrent, signal);

export const readAiGuidance = (room: Room, signal?: AbortSignal) =>
  communityFetch<WorkspaceAiGuidance>(path(room, "knowledge/guidance"), undefined, signal);
export const saveAiGuidance = (room: Room, account: Account, text: string) =>
  chatMutation<WorkspaceAiGuidance>(account, path(room, "knowledge/guidance"), { text, confirmed: true });
export type KnowledgeFilters = { q?: string; kind?: string; status?: string };
export const readKnowledge = (
  room: Room,
  signal?: AbortSignal,
  after?: string,
  filters: KnowledgeFilters = {},
) => {
  const query = new URLSearchParams();
  if (after) query.set("after", after);
  for (const [key, value] of Object.entries(filters))
    if (value) query.set(key, value);
  const encoded = query.toString();
  return communityFetch<KnowledgeOverview>(
    path(room, `knowledge${encoded ? `?${encoded}` : ""}`),
    undefined,
    signal,
  );
};
export const readKnowledgeFaq = (room: Room, id: string, signal?: AbortSignal) =>
  communityFetch<KnowledgeSourceView & { text: string }>(path(room, `knowledge/${id}`), undefined, signal);
export type KnowledgeTags = {
  era?: KnowledgeEraTag;
  visibility?: ProfileVisibility;
  addresses?: string[];
};
export const addKnowledge = (
  room: Room,
  account: Account,
  input:
    | ({ action: "add-doc"; url: string; title?: string } & KnowledgeTags)
    | ({ action: "add-sitemap"; url: string } & KnowledgeTags)
    | ({ action: "add-faq"; title: string; text: string } & KnowledgeTags)
    | ({ action: "add-saved-reply"; id: string } & KnowledgeTags),
) => chatMutation<KnowledgeSourceView | { found: number; added: number }>(account, path(room, "knowledge"), input);
export const knowledgeAction = <Input extends { action: "refresh" | "remove" } | ({ action: "update"; title?: string; text?: string; ifUpdatedAt?: string } & KnowledgeTags)>(
  room: Room,
  account: Account,
  id: string,
  input: Input,
  options?: { assertCurrent: () => void; signal: AbortSignal },
) => options
  ? chatMutation<Input extends { action: "remove" } ? { removed: true } : KnowledgeSourceView>(account, path(room, `knowledge/${id}`), input, options.assertCurrent, options.signal)
  : chatMutation<Input extends { action: "remove" } ? { removed: true } : KnowledgeSourceView>(account, path(room, `knowledge/${id}`), input);

/* Pilot preset ----------------------------------------------------------- */

export const readPilotPreset = (room: Room, signal?: AbortSignal) =>
  communityFetch<PilotPresetView>(path(room, "pilot-preset"), undefined, signal);
export const pilotPresetAction = (
  room: Room,
  account: Account,
  input: { action: "apply" | "lift" } | { action: "transactions"; enabled: boolean },
) => chatMutation<PilotPresetView>(account, path(room, "pilot-preset"), { ...input, confirmed: true });
