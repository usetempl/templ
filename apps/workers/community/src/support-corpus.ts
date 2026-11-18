/** Templ's de-identified improvement copy, room side: when a request is
 * finished, the workspace's own room object builds its row
 * (support-corpus-build.ts in the chat package) and hands only the row to
 * the workspace's SupportKnowledge object. Raw text never leaves the room
 * for this purpose: not to another object, a queue, a log line, an outside
 * service or a model.
 *
 * - Off unless `SUPPORT_CORPUS_ENABLED` is "true", `CORPUS_WORKSPACE_KEY`
 *   is 64 lowercase hex characters and `SUPPORT_CORPUS_SCOPE` is "all" or
 *   lists this workspace. Until `supportCorpusVerified`, the release check
 *   allows only Templ's own and synthetic workspaces in the scope.
 * - A request is finished when it was resolved and the reopen window passed
 *   with no reopen, or when it has had no message for `CORPUS_LIMITS.idleDays`.
 * - Never copied: excluded requests (test accounts, staff previews, spam,
 *   the canary), requests opened in the Templ app, requests whose opening
 *   message was not sent while the widget showed the notice line (the
 *   widget reports it for that request, and the room keeps the version on
 *   the case), requests of a member who objected, requests on a legal hold.
 *   A hold keeps the raw chat; it never keeps a row.
 * - A row's `ref` is an HMAC of `thread:seq` under a key only this room
 *   holds. The room can find a row to delete it; the knowledge object and
 *   Templ's readers can't turn a ref back into a thread.
 * - Each turn names its writer as `member-`/`staff-` and 8 hex of an HMAC
 *   of the principal under the same key, or `ai-agent`: stable across the
 *   workspace's rows, and nothing outside the room maps it back.
 * - The name pass replaces the current display names of the member, of
 *   everyone who wrote in the request and of everyone holding a team role,
 *   plus the bots' names. Without the names the row waits.
 * - Deletion: a member's privacy request deletes every row of the member's
 *   requests and stops new ones from their threads; an objection does the
 *   same and stops new ones for the member. The room keeps a member index
 *   (principal to ref, until the row expires) that outlives the chat, so
 *   both still reach rows after ordinary retention deleted the chat, which
 *   leaves its rows to their own 730-day limit. Workspace deletion purges
 *   the knowledge object.
 * - Logs carry counts and kinds only. */
import { CORPUS_LIMITS } from "@templ/chat/plans";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { SUPPORT_LIMITS, type SupportCase } from "@templ/chat/support";
import {
  CORPUS_NOTICE_VERSION,
  CORPUS_RULES,
  checkedCorpusCase,
  type CorpusCase,
  type CorpusTurn,
  type CorpusWorkspaceView,
} from "@templ/chat/support-corpus";
import {
  buildCorpusCase,
  type CorpusSource,
} from "@templ/chat/support-corpus-build";
import type { ProfileMatch } from "@templ/chat/protocol-profile";
import type { SupportEvidence } from "@templ/chat/support-evidence";
import { MAX_PROFILE_LOOKUP, identityStore } from "./account-identity";
import { readBots } from "./bots";
import { HttpError, json, type Env } from "./common";
import { messageKey, type StoredMessage } from "./message-store";
import { readRetentionHolds, type RetentionHolds, type SafetyEnv } from "./safety";
import { CASE_OPENED_PREFIX, CASE_PREFIX, checkedCase } from "./support-cases";
import { readTeamName } from "./staff-display-name";
import { readCaseEvidence, readCaseFrame } from "./support-evidence-store";
import { knowledgeBound, knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { leadOnly, qualityViewer, readQuality, toolsNotFound } from "./support-quality";
import { supportRecord } from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { corpusDirectory, type CorpusDirectoryEnv } from "./corpus-directory";
import { forgetMemberHandoffLearning, deleteThreadHandoffLearning, HANDOFF_LEARNING_ROOM_KEY } from "./support-handoff-learning";
import { featureOn } from "./workspace-flags";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
type MessageStorage = Pick<Storage, "list">;
export type CorpusEnv = KnowledgeEnv &
  SafetyEnv &
  CorpusDirectoryEnv & {
    SUPPORT_CORPUS_ENABLED?: string;
    /** "all", or comma-separated workspace ids (`room:<uuid>` or the uuid). */
    SUPPORT_CORPUS_SCOPE?: string;
    /** Secret: keys the workspace pseudonym (`ws_…`). */
    CORPUS_WORKSPACE_KEY?: string;
    /** The identity object, for the display names the name pass removes. */
    AUTH_RECORDS?: DurableObjectNamespace;
    APP_ORIGIN?: string;
  };

const DAY = 86_400_000;
/** The room's ref and pseudonym key. A storage restore keeps it, so rows
 * built after the restore point can still be found and deleted. */
const CORPUS_ROOM_KEY = "support-corpus-key-v1";
const CORPUS_SCAN_KEY = "support-corpus-scan-v1";
const CORPUS_REGISTERED_KEY = "support-corpus-registered-v1";
/** `<prefix><tc>:<seq pad 8>` → `{ at, resolvedAt, reopens, rules }`. */
export const CORPUS_BUILT_PREFIX = "support-corpus-built-v1:";
/** `<prefix><tc>:<seq pad 8>` → `{ v, at }`: the case's opening message
 * was sent while the widget showed notice version `v`. */
export const CORPUS_NOTICE_PREFIX = "support-corpus-notice-v1:";
/** `<prefix><principal>:<ref>` → `{ expires }`: a row of one of the
 * member's requests. Kept after the chat is deleted, until the row expires,
 * so the member's privacy request or objection still reaches it. */
export const CORPUS_MEMBER_PREFIX = "support-corpus-member-v1:";
const CORPUS_MEMBER_SCAN_KEY = "support-corpus-member-scan-v1";
/** `<prefix><principal>` → `{ at }`: the member objected. */
export const CORPUS_OBJECTION_PREFIX = "support-corpus-objection-v1:";
/** `<prefix><tc>` → `{ at }`: a privacy request deleted the thread's rows. */
export const CORPUS_SKIP_PREFIX = "support-corpus-skip-v1:";
/** The widget reports the notice right after the message that opened the
 * request; a later report names no case. */
const NOTICE_WINDOW_MS = 120_000;
/** A full pass over the case index, then a pause before the next. */
const CYCLE_MS = 6 * 3_600_000;
const ACTOR = { principal: "corpus", role: "staff" } as const;
const pad8 = (n: number) => String(n).padStart(8, "0");
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const OPENED = /^support-case-open-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9]{8})$/;

/** The workspace pseudonym key: 64 lowercase hex characters. */
const WORKSPACE_KEY = /^[0-9a-f]{64}$/;
/** Whether this workspace builds rows now. */
export function corpusOn(env: CorpusEnv, room: string): boolean {
  if (env.SUPPORT_CORPUS_ENABLED !== "true") return false;
  if (!WORKSPACE_KEY.test(env.CORPUS_WORKSPACE_KEY ?? "")) return false;
  const scope = (env.SUPPORT_CORPUS_SCOPE ?? "").trim();
  if (scope === "all") return true;
  const id = room.replace(/^room:/, "");
  return scope
    .split(",")
    .map((entry) => entry.trim().replace(/^room:/, ""))
    .some((entry) => entry.length > 0 && entry === id);
}

async function hmac(key: BufferSource, text: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text)));
}
/** `ws_` and 16 hex, keyed by Templ: the same workspace always maps to the
 * same pseudonym, and it names a business, never a person. */
export async function workspacePseudonym(env: CorpusEnv, room: string) {
  const key = env.CORPUS_WORKSPACE_KEY ?? "";
  if (!WORKSPACE_KEY.test(key)) throw new HttpError(503, "The de-identified copy is off.");
  return `ws_${(await hmac(new TextEncoder().encode(key), room)).slice(0, 16)}`;
}
/** The room's own ref key, made once and never returned or logged. */
async function roomKey(storage: Storage): Promise<Uint8Array> {
  const stored = await storage.get<string>(CORPUS_ROOM_KEY);
  if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored))
    return new Uint8Array(stored.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  await storage.put(CORPUS_ROOM_KEY, hex(fresh.buffer as ArrayBuffer));
  return fresh;
}
/** The row ref of one case. */
export async function corpusRef(storage: Storage, thread: string, seq: number) {
  return hmac(await roomKey(storage), `${thread}:${seq}`);
}
/** A turn's writer as the row names them. */
async function speaker(key: Uint8Array, role: CorpusTurn["role"], principal: string) {
  if (role === "agent") return "ai-agent";
  const kind = role === "member" ? "member" : "staff";
  return `${kind}-${(await hmac(key, `speaker:${kind}:${principal}`)).slice(0, 8)}`;
}
/** For a dispute record: the ref and workspace pseudonym of a case's row,
 * or null when the case has no row. The operator reads that one row
 * through `/operator/corpus`; the record never names the thread. */
export async function corpusRowFor(
  storage: Storage,
  env: CorpusEnv,
  room: string,
  ref: { thread: string; seq: number },
): Promise<{ workspace: string; ref: string } | null> {
  if (!corpusOn(env, room)) return null;
  const built = await storage.get(`${CORPUS_BUILT_PREFIX}${ref.thread}:${pad8(ref.seq)}`);
  if (!built) return null;
  return {
    workspace: await workspacePseudonym(env, room),
    ref: await corpusRef(storage, ref.thread, ref.seq),
  };
}

/* The notice ---------------------------------------------------------- */

/** The widget's `/auth/policy` field: the notice version to show, present
 * only while this workspace builds rows. */
export function corpusNoticeField(env: CorpusEnv, room: string) {
  return corpusOn(env, room) ? { notice: CORPUS_NOTICE_VERSION } : {};
}
/** `POST /conversations/notice {version}`: the member's widget sent the
 * message that opened a request while it showed the notice line. Widget
 * sessions only. The room keeps the version on the member's newest case
 * when that case opened in the last two minutes; any other report changes
 * nothing. */
async function recordNotice(storage: Storage, context: ConversationContext) {
  const principal = context.viewer.principalId;
  if (
    !principal ||
    context.headers.get("X-Support-Widget-Origin") === null ||
    context.body.version !== CORPUS_NOTICE_VERSION
  )
    throw new HttpError(404, "Not found.");
  const thread = await storage.get<string>(`conversation-member-v1:${principal}`);
  if (typeof thread !== "string") return json({ recorded: false });
  const [entry] = await storage.list<unknown>({
    prefix: `${CASE_PREFIX}${thread}:`,
    reverse: true,
    limit: 1,
  });
  const seq = entry ? Number(entry[0].slice(entry[0].lastIndexOf(":") + 1)) : 0;
  const c = entry ? checkedCase(entry[1], thread, seq) : null;
  if (!c || c.openedAt > context.now || context.now - c.openedAt > NOTICE_WINDOW_MS)
    return json({ recorded: false });
  const key = `${CORPUS_NOTICE_PREFIX}${thread}:${pad8(c.seq)}`;
  if (!(await storage.get(key))) await storage.put(key, { v: CORPUS_NOTICE_VERSION, at: context.now });
  return json({ recorded: true });
}
/** Whether the request's opening message was sent with the notice shown. */
async function noticed(storage: Storage, thread: string, seq: number) {
  const mark = await storage.get<{ v: number }>(`${CORPUS_NOTICE_PREFIX}${thread}:${pad8(seq)}`);
  return mark?.v === CORPUS_NOTICE_VERSION;
}
const membersOf = (record: TeamConversationRecord): string[] => [
  record.member,
  ...(record.formerMembers ?? []),
];
async function objected(storage: Storage, record: TeamConversationRecord) {
  for (const principal of membersOf(record))
    if (await storage.get(`${CORPUS_OBJECTION_PREFIX}${principal}`)) return true;
  return false;
}
/** A privacy deletion or objection now stops this thread's rows. */
async function copyStopped(storage: Storage, record: TeamConversationRecord) {
  return Boolean(await storage.get(`${CORPUS_SKIP_PREFIX}${record.id}`)) || objected(storage, record);
}

/* Building ------------------------------------------------------------- */

/** Resolved with the reopen window passed, or idle long enough; null while
 * the request may still change. */
export function settledState(
  c: SupportCase,
  now: number,
): CorpusCase["state"] | null {
  if (c.resolvedAt !== null) {
    return now - c.resolvedAt >= SUPPORT_LIMITS.caseReopenDays * DAY
      ? "resolved"
      : null;
  }
  const last = Math.max(c.lastMemberAt, c.lastReplyAt ?? 0, c.openedAt);
  return now - last >= CORPUS_LIMITS.idleDays * DAY ? "open-idle" : null;
}

type Built = { at: number; resolvedAt: number | null; reopens: number; rules: string };

type RawTurn = { role: CorpusTurn["role"]; author: string; text: string };
/** The request's member, person and agent messages, oldest first. */
async function caseTurns(
  storage: MessageStorage,
  record: TeamConversationRecord,
  from: number,
  until: number | null,
  bots: readonly string[],
): Promise<RawTurn[]> {
  const turns: RawTurn[] = [];
  let start: string | undefined;
  for (let page = 0; page < 5 && turns.length < CORPUS_LIMITS.turns; page++) {
    const rows = await storage.list<StoredMessage>({
      prefix: `channel-message:${record.id}:`,
      limit: 200,
      ...(start ? { startAfter: start } : {}),
    });
    for (const [key, row] of rows) {
      start = key;
      const at = Date.parse(row.createdAt);
      if (at < from) continue;
      if (until !== null && at >= until) return turns;
      if (typeof row.text !== "string" || !row.text.trim()) continue;
      const role =
        row.author === record.member ||
        record.formerMembers?.includes(row.author as ChatPrincipalId)
          ? "member"
          : bots.includes(row.author)
            ? "agent"
            : "person";
      turns.push({ role, author: row.author, text: row.text });
      if (turns.length >= CORPUS_LIMITS.turns) return turns;
    }
    if (rows.size < 200) break;
  }
  return turns;
}

/** Current display names, per principal, cached for one alarm run. */
export type NameCache = Map<string, string | null>;
/** Looks up the display names the cache lacks. Throws when the identity
 * object can't answer, so the row waits instead of keeping a name. */
async function lookupNames(env: CorpusEnv, cache: NameCache, principals: Iterable<string>) {
  const missing = [...new Set(principals)].filter((id) => !cache.has(id));
  if (!missing.length) return;
  if (!env.AUTH_RECORDS || !env.APP_ORIGIN)
    throw new HttpError(503, "Display names are unavailable.");
  for (let i = 0; i < missing.length; i += MAX_PROFILE_LOOKUP) {
    const ids = missing.slice(i, i + MAX_PROFILE_LOOKUP);
    const response = await identityStore(env as unknown as Env).fetch(
      new Request("https://internal/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "profiles", principalIds: ids }),
      }),
    );
    if (!response.ok) throw new HttpError(503, "Display names are unavailable.");
    const { profiles } = (await response.json()) as {
      profiles: { principalId: string; displayName: string | null }[];
    };
    for (const id of ids) cache.set(id, null);
    for (const profile of profiles)
      if (typeof profile.displayName === "string" && profile.displayName.trim())
        cache.set(profile.principalId, profile.displayName.trim());
  }
}
/** The manager and everyone holding a team role in this room, at most 200. */
async function rolePrincipals(storage: Storage) {
  const native = await storage.get<{ room?: { manager?: string } }>("native-room");
  const rows = await storage.list<unknown>({ prefix: "roles:", limit: 200 });
  const ids = [...rows.keys()].map((key) => key.slice("roles:".length));
  const manager = native?.room?.manager;
  return typeof manager === "string" && manager ? [manager, ...ids] : ids;
}

const EVM = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const TIED =
  /(?:\$\s?\d|\d[\d,.]*\s?(?:[A-Z]{2,6}|shares|tokens|USD|dollars)\b|\bblock\s*#?\s*\d{3,}|\b\d{4}-\d{2}-\d{2}\b)/i;

/** Builds one case's source: text inside this room only. */
async function caseSource(
  storage: Storage,
  messages: MessageStorage,
  env: CorpusEnv,
  room: string,
  workspace: string,
  record: TeamConversationRecord,
  c: SupportCase,
  state: CorpusCase["state"],
  names: NameCache,
  team: readonly string[],
): Promise<CorpusSource> {
  // A room that never set up chat settings has no bots.
  const bots = (await readBots(storage as never).catch(() => ({ bots: [] }))).bots;
  const next = await storage.get<unknown>(`${CASE_PREFIX}${c.thread}:${pad8(c.seq + 1)}`);
  const nextCase = next ? checkedCase(next, c.thread, c.seq + 1) : null;
  const raw = await caseTurns(
    messages,
    record,
    c.openedAt,
    nextCase?.openedAt ?? null,
    bots.map((bot) => bot.principalId as string),
  );
  const key = await roomKey(storage);
  // One pseudonym per member of the thread, whichever alias wrote.
  const turns = await Promise.all(
    raw.map(async (turn) => ({
      role: turn.role,
      speaker: await speaker(key, turn.role, turn.role === "member" ? record.member : turn.author),
      text: turn.text,
    })),
  );
  const members = [record.member, ...(record.formerMembers ?? [])] as string[];
  const writers = raw.filter((turn) => turn.role === "person").map((turn) => turn.author);
  await lookupNames(env, names, [...members, ...writers, ...team]);
  const nameOf = (ids: Iterable<string>) =>
    [...new Set(ids)].flatMap((id) => {
      const name = names.get(id);
      return name ? [name] : [];
    });
  const teamNames = await Promise.all(
    [...new Set([...writers, ...team])]
      .filter((id) => !members.includes(id))
      .map((id) => readTeamName(storage, id)),
  );
  const frame = await readCaseFrame(storage, c.thread, c.seq).catch(() => null);
  const evidence = (
    await readCaseEvidence(storage, c.thread, c.seq).catch(() => ({ rows: [] as SupportEvidence[] }))
  ).rows.filter((row) => !row.withdrawn && row.supersededBy === undefined);
  const data = await supportRecord(storage, record);
  const quality = await readQuality(storage, c.thread, c.seq).catch(() => null);
  // Profile entries the members may see stay, unless the request ties a
  // member amount, block or date to them.
  const text = turns.map((turn) => turn.text).join("\n");
  const addresses = [...new Set((text.match(EVM) ?? []).map((a) => a.toLowerCase()))].slice(0, 20);
  let matches: ProfileMatch[] = [];
  if (addresses.length)
    matches = (
      await knowledgeCall<{ matches: ProfileMatch[] }>(env, room, "profile.lookup", ACTOR, {
        refs: addresses.map((address) => ({
          network: frame?.product?.network ?? "eip155:1",
          address,
        })),
      }).catch(() => ({ matches: [] as ProfileMatch[] }))
    ).matches;
  const official = await knowledgeCall<{ officialUrls: string[] }>(env, room, "profile.get", ACTOR).catch(
    () => ({ officialUrls: [] as string[] }),
  );
  const tied = TIED.test(turns.filter((t) => t.role === "member").map((t) => t.text).join("\n"));
  return {
    workspace,
    case: c,
    state,
    turns,
    frame,
    evidence,
    category: data.category,
    tags: data.tags.slice(0, 10),
    labels: (quality?.labels ?? []).flatMap((label) => label.labels),
    diagnosisRules: quality?.facets.diagnosisRules ?? [],
    options: {
      keepAddresses: new Set(
        tied
          ? []
          : matches
              .filter((m) => m.visibility === "member-safe")
              .map((m) => m.address.toLowerCase()),
      ),
      keepHosts: new Set(
        official.officialUrls.flatMap((origin) => {
          try {
            return [new URL(origin).hostname.toLowerCase()];
          } catch {
            return [];
          }
        }),
      ),
      amountUnits: new Set(matches.map((m) => m.symbol).filter((s): s is string => Boolean(s))),
      names: {
        member: nameOf(members),
        team: [
          ...nameOf([...writers, ...team].filter((id) => !members.includes(id))),
          ...teamNames.filter((name): name is string => Boolean(name)),
          ...bots.map((bot) => bot.displayName).filter(Boolean),
        ],
      },
    },
    memberLast: turns.at(-1)?.role === "member",
  };
}

export type CorpusRunReport = {
  built: number;
  withheld: number;
  dropped: Record<string, number>;
  refused: number;
  skipped: number;
};

/** Room alarm consumer `support-corpus`: one bounded pass over the case
 * index. Returns when it next needs to run, or null while off. */
export async function corpusBuildAlarm(
  storage: Storage,
  env: CorpusEnv,
  now: number,
  readHolds: (roomKey: string) => Promise<RetentionHolds | null> = (key) =>
    readRetentionHolds(env, key),
  // Funded messages may live in this room's SupportStorage partitions. Open
  // that reader only for an eligible case; privacy markers stay room-local.
  readMessages: () => Promise<MessageStorage> = async () => storage,
): Promise<number | null> {
  const native = await storage.get<{ room: { id: string } }>("native-room");
  if (!native?.room?.id) return null;
  const room = `room:${native.room.id}`;
  if (!corpusOn(env, room) || !knowledgeBound(env)) return null;
  const scan = (await storage.get<{ after: string | null; nextAt: number }>(CORPUS_SCAN_KEY)) ?? {
    after: null,
    nextAt: 0,
  };
  if (scan.after === null && scan.nextAt > now) return scan.nextAt;
  const directory = corpusDirectory(env);
  const state = await directory?.state().catch(() => null);
  // Without the directory nobody could read a row or pause builds: wait.
  if (!directory || !state) return now + 3_600_000;
  if (state.paused) return now + CYCLE_MS;
  const holds = await readHolds(room);
  if (!holds) return now + 3_600_000;
  const workspace = await workspacePseudonym(env, room);
  if ((await storage.get<string>(CORPUS_REGISTERED_KEY)) !== workspace) {
    await directory.register(workspace, room);
    await storage.put(CORPUS_REGISTERED_KEY, workspace);
  }
  const report: CorpusRunReport = { built: 0, withheld: 0, dropped: {}, refused: 0, skipped: 0 };
  const names: NameCache = new Map();
  let team: string[] | null = null;
  let messages: MessageStorage | null = null;
  const index = await storage.list({
    prefix: CASE_OPENED_PREFIX,
    limit: CORPUS_LIMITS.casesReadPerRun,
    ...(scan.after ? { startAfter: scan.after } : {}),
  });
  const mark = (key: string, c: SupportCase) =>
    storage.put(key, {
      at: now,
      resolvedAt: c.resolvedAt,
      reopens: c.reopens,
      rules: CORPUS_RULES,
    } satisfies Built);
  /** One index entry: "next" once it is settled either way, "stop" when the
   * knowledge object can't take a row now (the entry is read again later). */
  const visit = async (key: string): Promise<"next" | "stop"> => {
    const match = OPENED.exec(key);
    if (!match || holds.room) return "next";
    const thread = match[2];
    const seq = Number(match[3]);
    const c = checkedCase(await storage.get(`${CASE_PREFIX}${thread}:${match[3]}`), thread, seq);
    if (!c) return "next";
    const builtKey = `${CORPUS_BUILT_PREFIX}${thread}:${match[3]}`;
    const built = await storage.get<Built>(builtKey);
    if (
      built?.rules === CORPUS_RULES &&
      built.resolvedAt === c.resolvedAt &&
      built.reopens === c.reopens
    )
      return "next";
    const state = settledState(c, now);
    if (!state) return "next";
    const record = await storage.get<TeamConversationRecord>(`conversation-v1:${thread}`);
    if (
      !record ||
      record.deleting ||
      c.excluded.length ||
      c.access === "app" ||
      holds.threads.has(thread) ||
      (await copyStopped(storage, record)) ||
      !(await noticed(storage, thread, seq))
    ) {
      report.skipped++;
      return "next";
    }
    team ??= await rolePrincipals(storage);
    let source: CorpusSource;
    try {
      messages ??= await readMessages();
      source = await caseSource(
        storage,
        messages,
        env,
        room,
        workspace,
        record,
        c,
        state,
        names,
        team,
      );
    } catch {
      // Display names or storage are unavailable: the entry is read again.
      return "stop";
    }
    const { row } = buildCorpusCase(source);
    const ref = await corpusRef(storage, thread, seq);
    // A row the checker or the knowledge object refuses is counted, marked
    // and never sent again for this state of the case; only an outage waits.
    const refuse = async () => {
      report.refused++;
      await mark(builtKey, c);
      return "next" as const;
    };
    if (!checkedCorpusCase(row)) return refuse();
    try {
      await knowledgeCall(env, room, "corpus.add", ACTOR, { ref, row });
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && !TRANSIENT.has(error.status))
        return refuse();
      return "stop";
    }
    // A privacy request or objection may have arrived while the row was
    // built: the route wrote its marker before deleting, so this read sees
    // it and the row goes again.
    if (await copyStopped(storage, record)) {
      await knowledgeCall(env, room, "corpus.deleteRefs", ACTOR, { refs: [ref] }).catch(() => undefined);
      report.skipped++;
      return "next";
    }
    const expires = now + CORPUS_LIMITS.retentionDays * DAY;
    for (const principal of membersOf(record))
      await storage.put(`${CORPUS_MEMBER_PREFIX}${principal}:${ref}`, { expires });
    await mark(builtKey, c);
    report.built++;
    if (row.flags.textWithheld) report.withheld++;
    for (const kind of row.flags.droppedKinds)
      report.dropped[kind] = (report.dropped[kind] ?? 0) + 1;
    return "next";
  };
  let after = scan.after;
  let stopped = false;
  for (const key of index.keys()) {
    if (report.built >= CORPUS_LIMITS.buildsPerRun || (await visit(key)) === "stop") {
      stopped = true;
      break;
    }
    after = key;
  }
  const finished = !stopped && index.size < CORPUS_LIMITS.casesReadPerRun;
  await pruneMemberIndex(storage, now);
  await storage.put(CORPUS_SCAN_KEY, finished ? { after: null, nextAt: now + CYCLE_MS } : { after, nextAt: 0 });
  if (report.built || report.refused)
    console.log(JSON.stringify({ event: "TEMPL_CORPUS_BUILD", ...report }));
  if (finished) return now + CYCLE_MS;
  return report.built >= CORPUS_LIMITS.buildsPerRun || !stopped ? now + 60_000 : now + 600_000;
}

/** The member index entries past their row's expiry, a page per run. */
async function pruneMemberIndex(storage: Storage, now: number) {
  const after = await storage.get<string>(CORPUS_MEMBER_SCAN_KEY);
  const page = await storage.list<{ expires: number }>({
    prefix: CORPUS_MEMBER_PREFIX,
    limit: CORPUS_LIMITS.casesReadPerRun,
    ...(after ? { startAfter: after } : {}),
  });
  const expired = [...page].filter(([, entry]) => !(entry?.expires > now)).map(([key]) => key);
  if (expired.length) await storage.delete(expired);
  const last = [...page.keys()].at(-1);
  if (page.size < CORPUS_LIMITS.casesReadPerRun || !last) await storage.delete(CORPUS_MEMBER_SCAN_KEY);
  else await storage.put(CORPUS_MEMBER_SCAN_KEY, last);
}

/* Deletion ------------------------------------------------------------- */

const DELETE_BATCH = 400;
/** Deletes rows by ref, in batches the knowledge object takes. */
async function deleteRefs(env: CorpusEnv, room: string, refs: Iterable<string>) {
  const list = [...new Set(refs)];
  let deleted = 0;
  for (let i = 0; i < list.length; i += DELETE_BATCH)
    deleted += (
      await knowledgeCall<{ deleted: number }>(env, room, "corpus.deleteRefs", ACTOR, {
        refs: list.slice(i, i + DELETE_BATCH),
      })
    ).deleted;
  return deleted;
}
/** The refs of a thread's cases, built or not, so a row built before a
 * marker was lost still goes. Returns them with the thread's build markers. */
async function threadRefs(storage: Storage, thread: string) {
  const built = await storage.list({ prefix: `${CORPUS_BUILT_PREFIX}${thread}:`, limit: 200 });
  const seqs = [...built.keys()].map((key) => Number(key.slice(key.lastIndexOf(":") + 1)));
  const cases = await storage.list({ prefix: `${CASE_PREFIX}${thread}:`, limit: 200 });
  for (const key of cases.keys()) seqs.push(Number(key.slice(key.lastIndexOf(":") + 1)));
  const refs = await Promise.all(
    [...new Set(seqs)].filter((seq) => seq >= 1).map((seq) => corpusRef(storage, thread, seq)),
  );
  return { refs, markers: [...built.keys()] };
}
/** Deletes every row of the members' requests: the rows of their live
 * threads and every row the member index names, including rows whose chat
 * ordinary retention already deleted. Returns how many rows went. */
async function deleteMemberRows(
  storage: Storage,
  env: CorpusEnv,
  room: string,
  principals: readonly string[],
  threads: Iterable<string>,
): Promise<number> {
  const refs: string[] = [];
  const markers: string[] = [];
  for (const thread of threads) {
    const found = await threadRefs(storage, thread);
    refs.push(...found.refs);
    markers.push(...found.markers);
  }
  const index: string[] = [];
  for (const principal of principals) {
    const prefix = `${CORPUS_MEMBER_PREFIX}${principal}:`;
    let after: string | undefined;
    for (;;) {
      const page = await storage.list({ prefix, limit: 1_000, ...(after ? { startAfter: after } : {}) });
      for (const key of page.keys()) {
        index.push(key);
        refs.push(key.slice(prefix.length));
      }
      after = [...page.keys()].at(-1);
      if (page.size < 1_000) break;
    }
  }
  const deleted = refs.length ? await deleteRefs(env, room, refs) : 0;
  for (const keys of [markers, index])
    for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
  return deleted;
}
/** A case's markers go with its case (the ledger's per-case deleters). */
export async function deleteCaseCorpusMarker(
  storage: Pick<DurableObjectStorage, "delete">,
  thread: string,
  seq: number,
  budget: number,
): Promise<number> {
  if (budget <= 0) return 0;
  return storage.delete(
    [
      `${CORPUS_BUILT_PREFIX}${thread}:${pad8(seq)}`,
      `${CORPUS_NOTICE_PREFIX}${thread}:${pad8(seq)}`,
    ].slice(0, budget),
  );
}
/** A thread's build and notice markers go before retention deletes the
 * chat; its rows stay to their own limit and the member index still names
 * them. At most `budget` keys per call. */
export async function deleteThreadCorpusMarkers(
  storage: Pick<DurableObjectStorage, "list" | "delete">,
  thread: string,
  budget: number,
): Promise<number> {
  let removed = 0;
  for (const prefix of [CORPUS_BUILT_PREFIX, CORPUS_NOTICE_PREFIX]) {
    if (removed >= budget) break;
    const rows = await storage.list({ prefix: `${prefix}${thread}:`, limit: budget - removed });
    if (!rows.size) continue;
    await storage.delete([...rows.keys()]);
    removed += rows.size;
  }
  return removed;
}

/* Routes --------------------------------------------------------------- */

const THREAD_ROUTE = /^\/conversations\/(tc-[0-9a-f]{32})\/corpus$/;
/** Statuses that mean "try again", never "this row is refused". */
const TRANSIENT = new Set([408, 409, 425, 429]);

/** The corpus routes, called at the top of the room's conversation routes. Returns null for any other path.
 * - `POST /conversations/notice`: a widget member's notice mark.
 * - `GET /conversations/corpus/on`: whether this workspace's requests are
 *   copied, and whether the viewer may act on a member's request. The
 *   widget's policy already says the first part to any visitor; the app
 *   reads it here to show the Plan card and the thread panel.
 * - `GET /conversations/corpus`: the manager and support leads see rows
 *   kept and last month's Templ reads (counts only).
 * - `POST /conversations/<tc>/corpus {action}`: the manager or a support
 *   lead acts on a member's request. Both actions delete every row of the
 *   member's requests, including rows whose chat was already deleted.
 *   `delete` (privacy request) stops new rows from the member's threads;
 *   `object` (objection) stops new rows for the member. */
export async function corpusRoute(
  storage: Storage,
  context: ConversationContext,
  deps: { authorize: (id: string) => Promise<{ record: TeamConversationRecord; role: "member" | "team" }> },
): Promise<Response | null> {
  const path = context.pathname;
  const thread = THREAD_ROUTE.exec(path);
  if (
    path !== "/conversations/notice" &&
    path !== "/conversations/corpus" &&
    path !== "/conversations/corpus/on" &&
    !thread
  )
    return null;
  const env = context.mediaEnv as unknown as CorpusEnv;
  const corpusEnabled = corpusOn(env, context.room);
  // Privacy cleanup remains reachable after either collection is switched
  // off. Learning never depends on the separate improvement corpus gate.
  const hasLearningPrivacy = (await featureOn(context.mediaEnv, storage, "handoffLearning")) ||
    (await storage.get(HANDOFF_LEARNING_ROOM_KEY)) !== undefined;
  const learningPrivacy = thread && context.method === "POST" && hasLearningPrivacy;
  if (!corpusEnabled && !learningPrivacy && !(path === "/conversations/corpus/on" && hasLearningPrivacy))
    throw new HttpError(404, "Not found.");
  if (path === "/conversations/notice") {
    if (context.method !== "POST") throw new HttpError(404, "Not found.");
    return recordNotice(storage, context);
  }
  const viewer = qualityViewer(context);
  if (path === "/conversations/corpus/on") {
    if (context.method !== "GET" || !context.viewer.principalId) throw new HttpError(404, "Not found.");
    return json({ on: corpusEnabled, learning: Boolean(viewer?.lead && hasLearningPrivacy), lead: Boolean(viewer?.lead) });
  }
  if (!viewer) throw toolsNotFound();
  if (!viewer.lead) throw leadOnly();
  if (path === "/conversations/corpus") {
    if (context.method !== "GET") throw new HttpError(404, "Not found.");
    const stats = await knowledgeCall<{ rows: number }>(env, context.room, "corpus.stats", ACTOR);
    const directory = corpusDirectory(env);
    const workspace = await workspacePseudonym(env, context.room);
    const reads = directory
      ? await directory.summary(workspace, lastMonth(context.now)).catch(() => null)
      : null;
    const view: CorpusWorkspaceView = {
      rows: stats.rows,
      reads: reads ?? { month: lastMonth(context.now), rows: 0, purposes: [] },
    };
    return json(view);
  }
  if (context.method !== "POST") throw new HttpError(404, "Not found.");
  const action = context.body.action;
  if (action !== "delete" && action !== "object")
    throw new HttpError(400, "Choose delete or object.", undefined, "corpus-action");
  const { record, role } = await deps.authorize(thread![1]);
  if (role !== "team") throw toolsNotFound();
  const members = membersOf(record);
  const threads = new Set<string>([record.id]);
  for (const principal of members) {
    const id = await storage.get<string>(`conversation-member-v1:${principal}`);
    if (typeof id === "string") threads.add(id);
  }
  // Markers first: a build running now reads them after its row lands and
  // deletes that row again.
  if (action === "delete")
    for (const id of threads) await storage.put(`${CORPUS_SKIP_PREFIX}${id}`, { at: context.now });
  else
    for (const principal of members)
      await storage.put(`${CORPUS_OBJECTION_PREFIX}${principal}`, { at: context.now });
  const deleted = corpusEnabled || (await storage.get(CORPUS_ROOM_KEY)) !== undefined
    ? await deleteMemberRows(storage, env, context.room, members, threads) : 0;
  const learnedDeleted = await forgetMemberHandoffLearning(storage, env, context.room, members);
  for (const thread of threads)
    while (await deleteThreadHandoffLearning(storage, thread, 100)) { /* Bounded pages; no case text. */ }
  context.pendingAudit.push({
    actor: viewer.principal,
    action: "support.settings",
    channelId: record.id,
    target: "corpus",
    after: { op: action, deleted, learnedDeleted },
  });
  return json({ deleted, learnedDeleted });
}
/** The last full UTC month, `YYYY-MM`. */
export function lastMonth(now: number) {
  const date = new Date(now);
  const first = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return new Date(first - DAY).toISOString().slice(0, 7);
}
