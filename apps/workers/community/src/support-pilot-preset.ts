import { canManageWorkspace } from "@templ/chat/moderation-permissions";
/** The pilot preset, as one set of named defaults:
 * - new requests start in AI drafts only for the first week, then the
 *   workspace default goes back to AI answers unless the manager changed it
 *   meanwhile;
 * - a request where the member shares a transaction moves from AI answers
 *   to AI drafts only (on by default in every workspace, the manager may
 *   turn it off);
 * - quality sampling: 10% at random plus AI-answered transaction questions,
 *   replies labeled unsafe and "not solved", at most 25 a week, with a
 *   required category at resolve.
 *
 * The drafts-only start lifts at the first new request, AI agent reply or
 * read of the preset or Quality after the week ends (an audit entry records
 * it), or when the manager lifts it. Until then the stricter mode holds, so
 * a late lift never lets the AI answer earlier than planned. */
import {
  PILOT_PRESET,
  type PilotPresetView,
} from "@templ/chat/support-quality";
import { HttpError, json } from "./common";
import { requirePrivilegedHeaders, requireWorkspaceAdminHeaders } from "./privileged-auth";
import { restricted } from "./support-ai-mode";
import { readThreadCases } from "./support-case-data";
import {
  QUALITY_SETTINGS_KEY,
  qualitySettings,
  reconcileSampling,
  type QualityViewer,
} from "./support-quality";
import { applyAiControl, readAiState, supportSettings } from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
export const PILOT_PRESET_KEY = "support-pilot-preset-v1";
export const AI_TRANSACTIONS_KEY = "support-ai-transactions-v1";
const SETTINGS_KEY = "support-settings-v1";
const DAY = 86_400_000;
type StoredPreset = {
  schemaVersion: 1;
  appliedAt: number;
  liftAt: number;
  liftedAt: number | null;
  liftedBy: "schedule" | "manager" | null;
};
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function checkedPreset(raw: unknown): StoredPreset | null {
  const p = raw as StoredPreset | undefined;
  if (!p || p.schemaVersion !== 1 || !natural(p.appliedAt) || !natural(p.liftAt))
    return null;
  if (p.liftedAt !== null && !natural(p.liftedAt)) return null;
  if (p.liftedBy !== null && p.liftedBy !== "schedule" && p.liftedBy !== "manager")
    return null;
  return p;
}
/** Drafts only when the member shares a transaction. Absent means on. */
export async function aiDraftsForTransactions(storage: Pick<Storage, "get">) {
  const stored = await storage.get<{ enabled?: unknown }>(AI_TRANSACTIONS_KEY);
  return stored?.enabled !== false;
}
async function setAiDefault(storage: Storage, mode: "drafts" | "answers") {
  const stored = ((await storage.get<Record<string, unknown>>(SETTINGS_KEY)) ?? {}) as Record<
    string,
    unknown
  >;
  const base = stored && Object.keys(stored).length ? stored : await supportSettings(storage);
  await storage.put(SETTINGS_KEY, { ...base, aiDefault: mode });
}
async function readDefault(storage: Storage) {
  return ((await storage.get<{ aiDefault?: unknown }>(SETTINGS_KEY))?.aiDefault ?? "answers") as string;
}

/** Lifts the drafts-only start once its week has passed: one read when
 * nothing is due. The request that finds it due carries the audit entry
 * (`by: "schedule"`). */
export async function liftIfDue(
  storage: Storage,
  now: number,
  context?: Pick<ConversationContext, "pendingAudit" | "viewer">,
): Promise<StoredPreset | null> {
  const preset = checkedPreset(await storage.get(PILOT_PRESET_KEY));
  if (!preset || preset.liftedAt !== null || now < preset.liftAt) return preset;
  const changed = (await readDefault(storage)) === PILOT_PRESET.aiDefault;
  if (changed) await setAiDefault(storage, PILOT_PRESET.liftTo);
  const lifted: StoredPreset = { ...preset, liftedAt: now, liftedBy: "schedule" };
  await storage.put(PILOT_PRESET_KEY, lifted);
  const actor = context?.viewer.principalId;
  if (actor)
    context.pendingAudit.push({
      actor,
      action: "support.settings",
      target: "pilot-preset",
      after: { op: "lift", by: "schedule", aiDefault: changed ? PILOT_PRESET.liftTo : null },
    });
  return lifted;
}
async function view(storage: Storage, preset: StoredPreset | null, now: number): Promise<PilotPresetView> {
  return {
    appliedAt: preset ? new Date(preset.appliedAt).toISOString() : null,
    liftAt: preset ? new Date(preset.liftAt).toISOString() : null,
    liftedAt: preset?.liftedAt ? new Date(preset.liftedAt).toISOString() : null,
    liftedBy: preset?.liftedBy ?? null,
    active: Boolean(preset && preset.liftedAt === null && now < preset.liftAt),
    aiDraftsForTransactions: await aiDraftsForTransactions(storage),
  };
}

/** `GET/POST /conversations/pilot-preset`. Reading is for the team; apply,
 * lift and the transaction rule are the manager's, with a valid signed-in session. */
export async function pilotPresetRoute(
  storage: Storage,
  context: ConversationContext,
  viewer: QualityViewer,
): Promise<Response> {
  const now = context.now;
  if (context.method === "GET")
    return json(await view(storage, await liftIfDue(storage, now, context), now));
  if (!viewer.admin)
    throw new HttpError(
      403,
      "Only workspace admins can change the pilot preset.",
      undefined,
      "manager-only",
    );
  requireWorkspaceAdminHeaders(context.headers, viewer.manager, context.body.confirmed, now);
  const action = context.body.action;
  let preset = checkedPreset(await storage.get(PILOT_PRESET_KEY));
  if (action === "apply") {
    preset = {
      schemaVersion: 1,
      appliedAt: now,
      liftAt: now + PILOT_PRESET.draftsDays * DAY,
      liftedAt: null,
      liftedBy: null,
    };
    await storage.put(PILOT_PRESET_KEY, preset);
    await setAiDefault(storage, PILOT_PRESET.aiDefault);
    await storage.put(AI_TRANSACTIONS_KEY, { enabled: PILOT_PRESET.aiDraftsForTransactions });
    // Requests that closed under the old settings get their decision under
    // them first, so turning sampling on never reaches back.
    await reconcileSampling(storage, context);
    const current = await qualitySettings(storage);
    await storage.put(QUALITY_SETTINGS_KEY, {
      ...current,
      sampling: {
        ...current.sampling,
        randomPercent: PILOT_PRESET.quality.randomPercent,
        rules: [...PILOT_PRESET.quality.rules],
        weeklyCap: PILOT_PRESET.quality.weeklyCap,
      },
      requireCategory: PILOT_PRESET.quality.requireCategory,
    });
  } else if (action === "lift") {
    if (!preset || preset.liftedAt !== null)
      throw new HttpError(409, "The preset isn't running.", undefined, "preset-not-running");
    if ((await readDefault(storage)) === PILOT_PRESET.aiDefault)
      await setAiDefault(storage, PILOT_PRESET.liftTo);
    preset = { ...preset, liftedAt: now, liftedBy: "manager" };
    await storage.put(PILOT_PRESET_KEY, preset);
  } else if (action === "transactions") {
    if (typeof context.body.enabled !== "boolean")
      throw new HttpError(400, "Choose on or off.", undefined, "preset-transactions");
    await storage.put(AI_TRANSACTIONS_KEY, { enabled: context.body.enabled });
  } else throw new HttpError(400, "Choose apply, lift or transactions.", undefined, "preset-action");
  context.pendingAudit.push({
    actor: viewer.principal,
    action: "support.settings",
    target: "pilot-preset",
    after: { op: String(action) },
  });
  return json(await view(storage, preset, now));
}

/** A request where the member shared a transaction goes from AI
 * answers to AI drafts only. Runs before the member's context share and
 * before an AI agent's reply, so the agent is refused ("ai-drafts-only")
 * rather than answering first. People are never limited. */
export async function applyTransactionRule(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  shared: boolean,
): Promise<boolean> {
  if (!(await aiDraftsForTransactions(storage))) return false;
  if (!shared) {
    const [latest] = await readThreadCases(storage, record.id as `tc-${string}`, { limit: 1 });
    if (!latest || latest.case.resolvedAt !== null || !latest.case.context.transaction)
      return false;
  }
  const { data, aiDefault, effective } = await readAiState(storage, record);
  if (effective.mode !== "answers") return false;
  const next = restricted(effective, {
    cause: "transaction",
    by: "rule",
    actor: null,
    caseSeq: data.caseSeq ?? 0,
    now: context.now,
    aiDefault,
  });
  if (!next) return false;
  await applyAiControl(storage, context, record, data, next, {
    bump: true,
    previous: effective.mode,
  });
  return true;
}
