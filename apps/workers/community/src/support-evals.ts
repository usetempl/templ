/** "Save as eval case" and the eval routes: the de-identified draft, save,
 * states, import, the golden-set export and posted runs.
 *
 * A draft reads the request's turns up to the labeled reply (never notes),
 * refuses recognized secrets, and replaces identifiers with placeholders
 * that stay consistent across the case. A person confirms the copy; the
 * server checks it again and refuses a copy that still holds a wallet,
 * transaction, email, handle, phone, IP, date or block number it can
 * detect. Profile addresses stay only when the request names no member
 * amount, block or date for them, or when the reviewer keeps them. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  EVAL_LIMITS,
  RESIDUAL_TEXT,
  caseCleaner,
  checkedEvalBody,
  deidentifyCaseParts,
  evalExportHeader,
  evalExportLine,
  evalTexts,
  residualInBody,
  type DeidOptions,
  type EvalCase,
  type EvalCaseBody,
  type EvalCaseSummary,
  type EvalDraft,
  type EvalProfileRef,
  type EvalTurn,
  type ResidualKind,
} from "@templ/chat/support-eval";
import type { SupportEvidence } from "@templ/chat/support-evidence";
import type { CaseActivityAction } from "./support-drafts";
import type { ProfileMatch } from "@templ/chat/protocol-profile";
import { readBots } from "./bots";
import { HttpError, json } from "./common";
import { admitExport } from "./export";
import { messageKey, type StoredMessage } from "./message-store";
import { readProductSupport } from "./product-entitlements";
import { detectStoredSecret, refusePhrase } from "./secret-guard";
import { readThreadCases } from "./support-case-data";
import { readCaseEvidence, readCaseFrame } from "./support-evidence-store";
import {
  knowledgeActor,
  knowledgeCall,
  type KnowledgeEnv,
} from "./support-knowledge-client";
import {
  caseForMessage,
  leadOnly,
  peopleOnly,
  qualitySettings,
  readQuality,
  type QualityViewer,
} from "./support-quality";
import { recordSupportActivity, supportRecord } from "./support-workflow";
import {
  readConversation,
  type ConversationContext,
  type TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
export const EVAL_RATE_PREFIX = "support-eval-rate-v1:";
export const EVALS_ROUTE =
  /^\/conversations\/evals(?:\/(export|import|runs|ev-[0-9a-f]{16})(?:\/(run-[0-9a-f]{16}))?)?$/;
const HOUR = 3_600_000;
const isoDay = (value: number) => new Date(value).toISOString().slice(0, 10);

/** 30 previews, saves and imports per person per hour. */
async function paceEvals(storage: Storage, principal: string, now: number) {
  const key = `${EVAL_RATE_PREFIX}${principal}`;
  const hour = Math.floor(now / HOUR);
  const current = await storage.get<{ hour: number; count: number }>(key);
  const count = current?.hour === hour ? current.count : 0;
  if (count >= EVAL_LIMITS.perPersonPerHour)
    throw new HttpError(
      429,
      "You've saved a lot of eval cases this hour. Try again later.",
      Math.ceil(((hour + 1) * HOUR - now) / 1000),
      "eval-rate",
    );
  await storage.put(key, { hour, count: count + 1 });
}
/** Eval capacity follows whether the workspace has a top-up or reviewed grant. */
async function evalCap(storage: Storage, now: number) {
  try {
    return (await readProductSupport(storage, now)).funded
      ? EVAL_LIMITS.casesFunded
      : EVAL_LIMITS.casesFree;
  } catch {
    return EVAL_LIMITS.casesFree;
  }
}
const notDeidentified = (kinds: ResidualKind[]) =>
  json(
    {
      error: `This copy still contains ${kinds.map((kind) => RESIDUAL_TEXT[kind]).join(", ")}. Replace it before you save.`,
      reason: "eval-not-deidentified",
      kinds,
    },
    422,
  );


/* The draft                                                               */

type Turn = { role: EvalTurn["role"]; text: string; id: number; at: number; author: string };
async function caseTurns(
  storage: Storage,
  record: TeamConversationRecord,
  openedAt: number,
  message: number,
  nextOpenedAt: number | null,
  bots: readonly string[],
): Promise<{ turns: Turn[]; evaluated: Turn; candidate: Turn | null }> {
  const role = (author: string): EvalTurn["role"] =>
    author === record.member || record.formerMembers?.includes(author as ChatPrincipalId)
      ? "member"
      : bots.includes(author)
        ? "agent"
        : "person";
  const earlier = await storage.list<StoredMessage>({
    prefix: `channel-message:${record.id}:`,
    end: messageKey(record.id, message + 1),
    reverse: true,
    limit: 200,
  });
  const rows: Turn[] = [];
  for (const row of earlier.values()) {
    const at = Date.parse(row.createdAt);
    if (at < openedAt) break;
    rows.push({ role: role(row.author), text: row.text, id: Number(row.id), at, author: row.author });
  }
  rows.reverse();
  const evaluated = rows.pop();
  if (!evaluated || evaluated.id !== message)
    throw new HttpError(404, "Reply not found.", undefined, "reply-not-found");
  const later = await storage.list<StoredMessage>({
    prefix: `channel-message:${record.id}:`,
    start: messageKey(record.id, message + 1),
    limit: 50,
  });
  let candidate: Turn | null = null;
  for (const row of later.values()) {
    const at = Date.parse(row.createdAt);
    if (nextOpenedAt !== null && at >= nextOpenedAt) break;
    if (role(row.author) === "person") {
      candidate = { role: "person", text: row.text, id: Number(row.id), at, author: row.author };
      break;
    }
  }
  return { turns: rows.slice(-EVAL_LIMITS.turns), evaluated, candidate };
}

const EVM = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const AMOUNT_OR_BLOCK =
  /(?:\$\s?\d|\d[\d,.]*\s?(?:[A-Z]{2,6}|shares|tokens|USD|dollars)\b|\bblock\s*#?\s*\d{3,}|\b\d{4}-\d{2}-\d{2}\b)/i;

export async function buildEvalDraft(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  record: TeamConversationRecord,
  input: { message: unknown; keep?: unknown; remove?: unknown },
): Promise<EvalDraft> {
  const message = Number(input.message);
  if (!Number.isSafeInteger(message) || message < 1)
    throw new HttpError(400, "Choose a reply.", undefined, "invalid-message");
  const { read } = await caseForMessage(storage, record, message).catch((error) => {
    if (error instanceof HttpError && error.reason === "label-no-case")
      throw new HttpError(409, "This reply can't become an eval case.", undefined, "eval-no-case");
    throw error;
  });
  const c = read.case;
  if (c.excluded.length)
    throw new HttpError(409, "This reply can't become an eval case.", undefined, "eval-no-case");
  const bots = await readBots(storage);
  const botIds = bots.bots.map((bot) => bot.principalId as string);
  const cases = await readThreadCases(
    storage,
    record.id as `tc-${string}`,
    { limit: 100 },
  );
  const next = cases
    .filter((entry) => entry.seq > read.seq)
    .map((entry) => entry.case.openedAt)
    .sort((a, b) => a - b)[0] ?? null;
  const { turns, evaluated, candidate } = await caseTurns(
    storage,
    record,
    c.openedAt,
    message,
    next,
    botIds,
  );
  const frame = await readCaseFrame(storage, read.thread, read.seq).catch(() => null);
  const evidence = (await readCaseEvidence(storage, read.thread, read.seq).catch(() => ({ rows: [] as SupportEvidence[] }))).rows.filter(
    (row) => !row.withdrawn && row.supersededBy === undefined,
  );
  for (const text of [
    ...turns.map((t) => t.text),
    evaluated.text,
    candidate?.text ?? "",
    ...evidence.map((row) => `${row.value.text} ${row.note ?? ""}`),
  ])
    await refusePhrase(text, "saved");
  // Profile entries named in the request, and whether the request ties a
  // member amount, block or date to them.
  const addressText = [
    ...turns.map((t) => t.text),
    evaluated.text,
    candidate?.text ?? "",
    frame?.product?.address ?? "",
    ...evidence.map((row) => `${row.product.address ?? ""} ${row.value.text}`),
  ].join("\n");
  const addresses = [...new Set((addressText.match(EVM) ?? []).map((a) => a.toLowerCase()))].slice(0, 20);
  let matches: ProfileMatch[] = [];
  let officialHosts: string[] = [];
  let symbols: string[] = [];
  if (addresses.length) {
    const lookup = await knowledgeCall<{ matches: ProfileMatch[] }>(
      env,
      context.room,
      "profile.lookup",
      knowledgeActor(viewer),
      { refs: addresses.map((address) => ({ network: frame?.product?.network ?? "eip155:1", address })) },
    ).catch(() => ({ matches: [] as ProfileMatch[] }));
    matches = lookup.matches;
    symbols = matches.map((m) => m.symbol).filter((s): s is string => Boolean(s));
  }
  const profile = await knowledgeCall<{ officialUrls: string[] }>(
    env,
    context.room,
    "profile.get",
    knowledgeActor(viewer),
  ).catch(() => ({ officialUrls: [] as string[] }));
  officialHosts = profile.officialUrls.map((origin) => new URL(origin).hostname.toLowerCase());
  const tied = AMOUNT_OR_BLOCK.test(
    [...turns.filter((t) => t.role === "member").map((t) => t.text)].join("\n"),
  );
  const explicit = new Set(
    Array.isArray(input.keep)
      ? input.keep.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase())
      : [],
  );
  const keepAddresses = new Set(
    matches
      .map((m) => m.address.toLowerCase())
      .filter((address) => !tied || explicit.has(address)),
  );
  const options: DeidOptions = {
    keepAddresses,
    keepHosts: new Set(officialHosts),
    amountUnits: new Set(symbols),
    names: {
      member: Array.isArray(input.remove)
        ? input.remove.filter((n): n is string => typeof n === "string" && n.length <= 60).slice(0, 10)
        : [],
      team: bots.bots.map((bot) => bot.displayName).filter(Boolean),
    },
    baseDate: isoDay(c.openedAt),
  };
  const cleaner = caseCleaner(options);
  const { clean, replaced, checks } = cleaner;
  const { frame: evalFrame, evidence: evalEvidence } = deidentifyCaseParts(
    { frame, evidence },
    cleaner,
  );
  const profileRefs: EvalProfileRef[] = matches
    .filter((m) => keepAddresses.has(m.address.toLowerCase()))
    .slice(0, EVAL_LIMITS.profileRefs)
    .map((m) => ({
      network: m.network,
      address: m.address,
      label: clean(m.label),
      kind: clean(m.kind),
      status: clean(m.status),
      generation: m.generation ? clean(m.generation) : null,
      visibility: m.visibility,
    }));
  const data = await supportRecord(storage, record);
  const quality = await readQuality(storage, read.thread, read.seq);
  const labels =
    quality?.labels.find((label) => label.message === message)?.labels ?? [];
  for (const text of evalTexts({
    category: data.category,
    tags: data.tags,
    diagnosisRules: quality?.facets.diagnosisRules ?? [],
    input: { frame, evidence, profile: matches },
  } as unknown as EvalCaseBody)) await refusePhrase(text, "saved");
  const evaluatedText = clean(evaluated.text).slice(0, EVAL_LIMITS.answerChars);
  const candidateText = candidate ? clean(candidate.text).slice(0, EVAL_LIMITS.answerChars) : null;
  return {
    thread: read.thread,
    seq: read.seq,
    message,
    category: data.category ? clean(data.category) : null,
    tags: data.tags.slice(0, EVAL_LIMITS.tags).map(clean),
    handoffReason: c.handoffReason,
    diagnosisRules: (quality?.facets.diagnosisRules ?? []).map(clean),
    labels,
    input: {
      turns: turns.map((turn) => ({ role: turn.role, text: clean(turn.text) })),
      context: { network: frame?.network?.value ?? frame?.product?.network ?? null, action: null, page: null },
      frame: evalFrame,
      evidence: evalEvidence,
      profile: profileRefs,
    },
    evaluated: {
      role: evaluated.role === "agent" ? "agent" : "person",
      text: evaluatedText,
    },
    expected: {
      action: c.handoffReason && evaluated.role === "agent" ? "handoff" : "answer",
      answer:
        candidateText ??
        (labels.length === 1 && labels[0] === "correct" ? evaluatedText : null),
      handoffReason: c.handoffReason && evaluated.role === "agent" ? c.handoffReason : null,
      mustMention: [],
      mustNotMention: [],
    },
    notes: {},
    candidateAnswer: candidateText,
    replaced,
    checks: checks.slice(0, 20),
  };
}

type Ref = { network: string; address: string };
/** The profile refs a copy may keep: its own profile list and its frame's
 * product address (placeholders are not refs). */
function caseRefs(body: EvalCaseBody): Ref[] {
  const refs = body.input.profile.map((ref) => ({ network: ref.network, address: ref.address }));
  const product = body.input.frame?.product;
  if (product?.address && product.network && !/^<ADDR_\d+>$/.test(product.address))
    refs.push({ network: product.network, address: product.address });
  return refs;
}
const keyOf = (address: string) => (address.startsWith("0x") ? address.toLowerCase() : address);
const refKey = (ref: Ref) => `${ref.network}:${keyOf(ref.address)}`;
/** The keep sets rebuilt on the server: official hosts, and a function
 * giving one copy's kept addresses, the refs that copy lists that are in
 * this workspace's profile. Lookups go 20 refs at a time. */
async function serverKeeps(
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  bodies: readonly EvalCaseBody[],
) {
  const actor = knowledgeActor(viewer);
  const profile = await knowledgeCall<{ officialUrls: string[] }>(env, context.room, "profile.get", actor);
  const refs = [
    ...new Map(bodies.flatMap(caseRefs).map((ref) => [refKey(ref), ref])).values(),
  ];
  const inProfile = new Set<string>();
  for (let at = 0; at < refs.length; at += 20) {
    const { matches } = await knowledgeCall<{ matches: ProfileMatch[] }>(
      env,
      context.room,
      "profile.lookup",
      actor,
      { refs: refs.slice(at, at + 20) },
    ).catch((error) => {
      // An unreadable ref keeps nothing; anything else fails the request.
      if (error instanceof HttpError && error.status === 400) return { matches: [] as ProfileMatch[] };
      throw error;
    });
    for (const m of matches) inProfile.add(refKey(m));
  }
  const keepHosts = new Set(profile.officialUrls.map((origin) => new URL(origin).hostname.toLowerCase()));
  return {
    keepHosts,
    forCase: (body: EvalCaseBody) => ({
      keepHosts,
      unreadableRefs: caseRefs(body).some((ref) => !inProfile.has(refKey(ref))),
      keepAddresses: new Set(
        caseRefs(body)
          .filter((ref) => inProfile.has(refKey(ref)))
          .map((ref) => keyOf(ref.address)),
      ),
    }),
  };
}

/** Recheck the complete saved copy before it leaves the current audience. */
async function readableEvalBody(
  body: EvalCaseBody,
  keeps: Pick<DeidOptions, "keepAddresses" | "keepHosts"> & { unreadableRefs: boolean },
) {
  const secrets = await Promise.all(evalTexts(body).map((text) => detectStoredSecret(text)));
  return !keeps.unreadableRefs && !secrets.some(Boolean) && !residualInBody(body, keeps).length;
}

/** `POST /conversations/<tc>/evals`: preview, save and delete-copies. */
export async function threadEvalAction(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  record: TeamConversationRecord,
): Promise<Response> {
  const body = context.body;
  const action = body.action;
  if (action === "delete-copies") {
    if (viewer.bot) throw peopleOnly();
    if (!viewer.lead) throw leadOnly();
    const result = await knowledgeCall(env, context.room, "evals.deleteBySource", knowledgeActor(viewer), {
      thread: record.id,
    });
    context.pendingAudit.push({
      actor: viewer.principal,
      action: "support.settings",
      channelId: record.id,
      target: "evals",
      after: { op: "delete-copies", deleted: (result as { deleted?: number }).deleted ?? 0 },
    });
    return json(result);
  }
  if (viewer.bot) throw peopleOnly();
  if (action === "preview") {
    await paceEvals(storage, viewer.principal, context.now);
    const draft = await buildEvalDraft(storage, env, context, viewer, record, {
      message: body.message,
      keep: body.keep,
      remove: body.remove,
    });
    return json({ draft });
  }
  if (action !== "save")
    throw new HttpError(400, "Choose preview, save or delete-copies.", undefined, "eval-action");
  if (body.confirm !== true)
    throw new HttpError(400, "Confirm that you checked the copy.", undefined, "eval-confirm");
  const draft = body.draft as (EvalDraft & Record<string, unknown>) | undefined;
  const message = Number(body.message);
  const { thread: _t, seq, message: _m, candidateAnswer: _c, replaced: _r, checks: _ch, ...rest } =
    (draft ?? {}) as EvalDraft;
  const checked = checkedEvalBody(rest);
  if (!checked)
    throw new HttpError(400, "This eval case is too long or incomplete.", undefined, "eval-invalid");
  const { read } = await caseForMessage(storage, record, message).catch(() => {
    throw new HttpError(409, "The case changed. Open the copy again.", undefined, "eval-stale");
  });
  if (
    draft?.thread !== record.id ||
    draft?.message !== message ||
    seq !== read.seq ||
    read.case.excluded.length
  )
    throw new HttpError(409, "The case changed. Open the copy again.", undefined, "eval-stale");
  for (const text of evalTexts(checked)) await refusePhrase(text, "saved");
  const keeps = await serverKeeps(env, context, viewer, [checked]);
  const kinds = residualInBody(checked, keeps.forCase(checked));
  if (kinds.length) return notDeidentified(kinds);
  await paceEvals(storage, viewer.principal, context.now);
  const saved = await knowledgeCall<{ id: string; state: string }>(
    env,
    context.room,
    "evals.save",
    knowledgeActor(viewer),
    {
      body: checked,
      origin: body.origin === "review" ? "review" : "reply-label",
      sourceLink: `${record.id}:${read.seq}:${message}`,
      cap: await evalCap(storage, context.now),
    },
  );
  const data = await supportRecord(storage, record);
  await recordSupportActivity(storage, record.id, data, {
    actor: viewer.principal,
    action: "eval" as CaseActivityAction,
    at: context.now,
    detail: "saved",
  });
  context.pendingAudit.push({
    actor: viewer.principal,
    action: "support.settings",
    channelId: record.id,
    target: "evals",
    after: { op: "save", eval: saved.id },
  });
  return json({ eval: saved }, 201);
}

/* Room-level eval routes                                                  */

const agentAccessDenied = () =>
  new HttpError(403, "The manager hasn't let AI agents read eval cases.", undefined, "eval-agent-access");
async function agentAllowed(storage: Storage, viewer: QualityViewer) {
  if (!viewer.bot) return;
  if (!(await qualitySettings(storage)).evalAgentAccess) throw agentAccessDenied();
}

export async function evalsRoute(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  match: RegExpExecArray,
): Promise<Response> {
  const [, sub, run] = match;
  const actor = knowledgeActor(viewer);
  const get = context.method === "GET";
  if (run && sub !== "runs") throw new HttpError(404, "Support tools not found.");
  if (!sub) {
    if (!get) throw new HttpError(404, "Support tools not found.");
    await agentAllowed(storage, viewer);
    const q = context.query;
    const page = await knowledgeCall<Record<string, unknown> & { cases: EvalCaseSummary[] }>(env, context.room, "evals.list", actor, {
      state: q.get("state") ?? undefined,
      label: q.get("label") ?? undefined,
      category: q.get("category") ?? undefined,
      after: q.get("after") ?? undefined,
    });
    if (!viewer.bot) return json(page);
    const copies = await Promise.all(page.cases.map(async (row) => {
      try {
        const { case: copy } = await knowledgeCall<{ case: EvalCase }>(env, context.room, "evals.get", actor, { id: row.id });
        return copy.id === row.id && copy.version === row.version ? copy : null;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
    }));
    const keeps = await serverKeeps(env, context, viewer, copies.filter((copy): copy is EvalCase => copy !== null));
    const readable = await Promise.all(copies.map((copy) => copy ? readableEvalBody(copy, keeps.forCase(copy)) : false));
    return json({ ...page, cases: page.cases.filter((_row, index) => readable[index]) });
  }
  if (sub === "export") {
    if (!get) throw new HttpError(404, "Support tools not found.");
    if (viewer.bot) await agentAllowed(storage, viewer);
    else if (!viewer.lead) throw leadOnly();
    await admitExport(storage, viewer.principal, context.now, context.aliases);
    const set = context.query.get("set") === "all" ? "all" : "golden";
    const after = context.query.get("after");
    const keeps = await knowledgeCall<{ officialUrls: string[] }>(env, context.room, "profile.get", actor);
    const page = await knowledgeCall<{
      set: "golden" | "all";
      count: number;
      cases: Parameters<typeof evalExportLine>[0][];
      withheld: string[];
      next: string | null;
    }>(env, context.room, "evals.export", actor, {
      set,
      ...(after ? { after } : {}),
      keepAddresses: [],
      keepHosts: keeps.officialUrls.map((origin) => new URL(origin).hostname.toLowerCase()),
    });
    // Profile addresses a case keeps are checked against the profile again
    // before they leave, each case against its own refs.
    const profileKeep = await serverKeeps(env, context, viewer, page.cases);
    const lines: string[] = [];
    let withheld = page.withheld.length;
    for (const c of page.cases) {
      if (!(await readableEvalBody(c, profileKeep.forCase(c)))) {
        withheld++;
        continue;
      }
      lines.push(evalExportLine(c));
    }
    if (!after) {
      lines.unshift(
        JSON.stringify(
          evalExportHeader({ exportedAt: new Date(context.now).toISOString(), set, count: page.count }),
        ),
      );
      context.pendingAudit.push({
        actor: viewer.principal,
        action: "support.settings",
        target: "evals",
        after: { op: "export", set, poster: viewer.bot ? "agent" : "person" },
      });
    }
    // `format=json` answers the same page as JSON, for clients that read
    // JSON only (the SDK's exportEvalSet and the hosted trial).
    if (context.query.get("format") === "json")
      return json({ lines, next: page.next, withheld });
    return new Response(lines.length ? `${lines.join("\n")}\n` : "", {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Templ-Withheld": String(withheld),
        ...(page.next ? { "X-Templ-Next": page.next } : {}),
      },
    });
  }
  if (sub === "import") {
    if (get) throw new HttpError(404, "Support tools not found.");
    if (viewer.bot) throw peopleOnly();
    if (!viewer.lead) throw leadOnly();
    if (context.body.confirm !== true)
      throw new HttpError(400, "Confirm that you checked the copies.", undefined, "eval-confirm");
    const lines = context.body.lines;
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > EVAL_LIMITS.importLinesPerCall * 5)
      throw new HttpError(400, "Send the file in parts of up to 40 lines.", undefined, "eval-import");
    await paceEvals(storage, viewer.principal, context.now);
    const refused: { index: number; reason: string }[] = [];
    const cases: unknown[] = [];
    const indexes: number[] = [];
    const bodies: { index: number; parsed: Record<string, unknown>; body: EvalCaseBody }[] = [];
    for (const [index, line] of lines.entries()) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        refused.push({ index, reason: "eval-invalid" });
        continue;
      }
      if (parsed?.kind === "templ-eval-header") continue;
      const body = checkedEvalBody(parsed);
      if (!body) {
        refused.push({ index, reason: "eval-invalid" });
        continue;
      }
      let secret = false;
      for (const text of evalTexts(body)) {
        if (await detectStoredSecret(text)) { secret = true; break; }
      }
      if (secret) {
        refused.push({ index, reason: "secret-refused" });
        continue;
      }
      bodies.push({ index, parsed, body });
    }
    // Each case keeps the profile addresses it lists that are in this
    // workspace's profile, the same rule as a save.
    const keeps = await serverKeeps(env, context, viewer, bodies.map((entry) => entry.body));
    for (const { index, parsed, body } of bodies) {
      if (residualInBody(body, keeps.forCase(body)).length) {
        refused.push({ index, reason: "eval-not-deidentified" });
        continue;
      }
      cases.push(parsed);
      indexes.push(index);
    }
    let imported = 0;
    if (cases.length) {
      const result = await knowledgeCall<{ imported: number; refused: { index: number; reason: string }[] }>(
        env,
        context.room,
        "evals.import",
        actor,
        { cases, cap: await evalCap(storage, context.now) },
      );
      imported = result.imported;
      for (const item of result.refused) refused.push({ index: indexes[item.index], reason: item.reason });
    }
    context.pendingAudit.push({
      actor: viewer.principal,
      action: "support.settings",
      target: "evals",
      after: { op: "import", imported, refused: refused.length },
    });
    return json({ imported, refused: refused.sort((a, b) => a.index - b.index) });
  }
  if (sub === "runs") {
    await agentAllowed(storage, viewer);
    if (get)
      return json(
        run
          ? await knowledgeCall(env, context.room, "evals.runs.get", actor, { id: run })
          : await knowledgeCall(env, context.room, "evals.runs.list", actor, {
              after: context.query.get("after") ?? undefined,
            }),
      );
    if (run) throw new HttpError(404, "Support tools not found.");
    if (!viewer.bot && !viewer.lead) throw leadOnly();
    const result = await knowledgeCall<{ run: { id: string }; created: boolean }>(
      env,
      context.room,
      "evals.runs.post",
      actor,
      { input: context.body },
    );
    if (result.created)
      context.pendingAudit.push({
        actor: viewer.principal,
        action: "support.settings",
        target: "evals",
        after: { op: "run", run: result.run.id },
      });
    return json(result.run, result.created ? 201 : 200);
  }
  // One eval case.
  if (get) {
    await agentAllowed(storage, viewer);
    const found = await knowledgeCall<Record<string, unknown> & { case: EvalCaseBody }>(env, context.room, "evals.get", actor, { id: sub });
    if (viewer.bot) {
      const keeps = await serverKeeps(env, context, viewer, [found.case]);
      if (!(await readableEvalBody(found.case, keeps.forCase(found.case))))
        throw new HttpError(404, "Eval case not found.", undefined, "eval-not-found");
    }
    const { savedBy: _savedBy, ...view } = found;
    return json(view);
  }
  if (viewer.bot) throw peopleOnly();
  const action = context.body.action;
  if (action === "edit") {
    if (context.body.confirm !== true)
      throw new HttpError(400, "Confirm that you checked the copy.", undefined, "eval-confirm");
    const found = await knowledgeCall<{ case: { state: string }; savedBy: string | null }>(
      env,
      context.room,
      "evals.get",
      actor,
      { id: sub },
    );
    const saver = found.savedBy === viewer.principal && found.case.state === "candidate";
    if (!viewer.lead && !saver) throw leadOnly();
    const body = checkedEvalBody(context.body.patch);
    if (!body)
      throw new HttpError(400, "This eval case is too long or incomplete.", undefined, "eval-invalid");
    for (const text of evalTexts(body)) await refusePhrase(text, "saved");
    const keeps = await serverKeeps(env, context, viewer, [body]);
    const kinds = residualInBody(body, keeps.forCase(body));
    if (kinds.length) return notDeidentified(kinds);
    return json(await knowledgeCall(env, context.room, "evals.update", actor, { id: sub, action, body }));
  }
  if (!viewer.lead) throw leadOnly();
  if (action === "delete")
    return json(await knowledgeCall(env, context.room, "evals.delete", actor, { id: sub }));
  if (action === "promote" || action === "retire" || action === "restore")
    return json(await knowledgeCall(env, context.room, "evals.update", actor, { id: sub, action }));
  throw new HttpError(400, "Choose an eval action.", undefined, "eval-action");
}

/** Clears the links of eval copies whose thread is gone (a few threads per
 * call). Runs where leads read eval cases. */
export async function unlinkDeletedThreads(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
) {
  const { threads } = await knowledgeCall<{ threads: string[] }>(
    env,
    context.room,
    "evals.links",
    knowledgeActor(viewer),
    { limit: 25 },
  );
  const gone: string[] = [];
  for (const thread of threads) if (!(await readConversation(storage, thread))) gone.push(thread);
  if (gone.length)
    await knowledgeCall(env, context.room, "evals.unlink", knowledgeActor(viewer), { threads: gone });
  return gone.length;
}
