import { describe, expect, vi } from "vitest";
import { CRYPTO_LANGUAGES, cryptoLanguage } from "@templ/chat/crypto-languages";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { HOSTED_SOCIAL_REPLIES } from "@templ/chat/support-ai-interactions";
import {
  CRYPTO_SUPPORT_MODEL,
  CRYPTO_SUPPORT_WORKSPACE,
  DEFAULT_SUPPORT_MODEL,
} from "@templ/chat/support-models";
import { WORKSPACE_FLAG_KEYS, type WorkspaceFeatures, type WorkspaceFlag } from "@templ/chat/workspace-flags";
import bundled from "../src/managed-agent/crypto-service-translations.json" with { type: "json" };
import {
  CRYPTO_CHAT_LANGUAGE_PREFIX,
  cryptoChatLanguageInput,
  cryptoChatLanguageOn,
  cryptoChatLanguageState,
  deleteThreadCryptoChatLanguage,
  saveCryptoChatLanguage,
} from "../src/crypto-chat-language";
import { messageKey } from "../src/message-store";
import { addSource } from "../src/support-knowledge-kb";
import { ensureSchema, readMeta, writeMeta } from "../src/support-knowledge-schema";
import {
  WORKSPACE_FLAGS_KEY,
  workspaceFeatureEnvFromFlags,
  workspaceFeatureEnvFromValues,
} from "../src/workspace-flags";
import type { ModelRequest, ModelResult } from "../src/managed-agent/anthropic";
import { CRYPTO_LOOKUP_REPLIES } from "../src/managed-agent/crypto-chain-facts";
import { cryptoReplyLanguageRule } from "../src/managed-agent/crypto-language";
import { serviceReplyTable } from "../src/managed-agent/crypto-service-replies";
import {
  CRYPTO_CLARIFY_REPLY,
  CRYPTO_REPLY_TRANSLATIONS,
  CRYPTO_SCAM_REPLY,
  CRYPTO_TRIAGE_SYSTEM,
  INVESTMENT_REFUSAL,
  cryptoServiceReplies,
} from "../src/managed-agent/crypto-triage";
import { GROUNDED_SUMMARY, groundedVerifierSystem, verifyGroundedReceipt } from "../src/managed-agent/grounded";
import { runManagedJobs, type JobOutcome, type RunnerDeps } from "../src/managed-agent/runner";
import { addJobs } from "../src/managed-agent/store";
import { knowledgeTestDb } from "./knowledge-sqlite";

// The self-hosted desk is unconfigured until the operator chooses a workspace.
vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000001",
}));

const DESK = CRYPTO_SUPPORT_WORKSPACE;
const OTHER = "01990000-0000-7000-8000-00000000000c";
const ORIGIN = "https://usetempl.com";
const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 27, 12);
const RECEIPT = "managed.grounded.receipt:";
// Every language rule names the menu; conversation text never carries it.
const MENU = "in Templ's language menu";
const bot = ("0x" + "4".repeat(40)) as ChatPrincipalId;
const operator = ("0x" + "5".repeat(40)) as ChatPrincipalId;
const FIXED = [CRYPTO_SCAM_REPLY, CRYPTO_CLARIFY_REPLY, INVESTMENT_REFUSAL, ...Object.values(CRYPTO_LOOKUP_REPLIES)];
const SOURCES = [...FIXED, HOSTED_SOCIAL_REPLIES.offTopic];
const TRANSLATED = CRYPTO_LANGUAGES.filter((language) => language.code !== "en");
const INVALID: unknown[] = ["EN", "Fr", "fr-FR", "zh-hans", "pt", "xx", "", " fr", "fr\n", "en-US", 42, null, true, ["fr"], { code: "fr" }];
const translated = (english: string, code: string | null) =>
  (code && CRYPTO_REPLY_TRANSLATIONS.get(code)?.get(english)) || english;

/** One room object's storage, with Durable Object list order. `written` holds
 * the keys the code under test wrote or deleted; the harness writes rows directly. */
class Memory {
  rows = new Map<string, unknown>();
  written = new Set<string>();
  async get(key: string | string[]) {
    if (Array.isArray(key))
      return new Map(key.filter((name) => this.rows.has(name)).map((name) => [name, structuredClone(this.rows.get(name))]));
    return structuredClone(this.rows.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    for (const [name, row] of entries) {
      this.rows.set(name, structuredClone(row));
      this.written.add(name);
    }
  }
  async delete(key: string | string[]) {
    let deleted = 0;
    for (const name of Array.isArray(key) ? key : [key]) {
      this.written.add(name);
      if (this.rows.delete(name)) deleted++;
    }
    return Array.isArray(key) ? deleted : deleted > 0;
  }
  async list(options: { prefix?: string; reverse?: boolean; limit?: number } = {}) {
    let keys = [...this.rows.keys()].filter((key) => !options.prefix || key.startsWith(options.prefix)).sort();
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return new Map(keys.map((key) => [key, structuredClone(this.rows.get(key))]));
  }
}

type FlagState = "on" | "off" | "expired";
type Server = "production" | "staging" | "switch-off";
const ENTRIES = ["hosted", "frame", "embed", "app", "other-origin", "bot"] as const;
type Entry = (typeof ENTRIES)[number];

const chatFlag = (until: number): WorkspaceFlag => ({
  key: "cryptoChatLanguage",
  on: true,
  until: new Date(until).toISOString(),
  operator,
  authenticatedAt: new Date(Date.now() - 60_000).toISOString(),
  reason: "Synthetic chat language simulation",
});
// Flags expire against the clock that reads them.
const flagRows = (state: FlagState) =>
  state === "off" ? [] : [chatFlag(state === "on" ? Date.now() + 30 * DAY : Date.now() - 60_000)];
function setFlag(storage: Memory, state: FlagState) {
  const [flag] = flagRows(state);
  if (flag) storage.rows.set(WORKSPACE_FLAGS_KEY, { cryptoChatLanguage: flag });
  else storage.rows.delete(WORKSPACE_FLAGS_KEY);
}
function room(id: string, state: FlagState) {
  const storage = new Memory();
  storage.rows.set("native-room", {
    room: { id, manager: bot, creator: bot, visibility: "public", createdAt: new Date(T - 90 * DAY).toISOString() },
  });
  setFlag(storage, state);
  return storage;
}
const serverEnv = (server: Server = "production") => ({
  APP_ORIGIN: server === "staging" ? "https://staging.example.invalid" : ORIGIN,
  MANAGED_AGENT_ENABLED: server === "switch-off" ? "false" : "true",
});
/** The headers the worker sets for a member send: only the desk's hosted page
 * on Templ's own origin, outside a frame, may carry a choice. */
function sendContext(workspace: string, entry: Entry, server: Server = "production") {
  const mediaEnv = serverEnv(server);
  const headers = new Headers();
  if (entry !== "app") {
    headers.set("X-Support-Widget", "member");
    headers.set("X-Support-Widget-Origin", entry === "embed" || entry === "other-origin" ? "https://wallet.example" : ORIGIN);
  }
  if (entry !== "app" && entry !== "embed") headers.set("X-Support-Entry", "hosted");
  if (entry === "frame") headers.set("X-Support-Widget-Frame", "1");
  return { room: "room:" + workspace, isBot: entry === "bot", appOrigin: mediaEnv.APP_ORIGIN, headers, mediaEnv } as never;
}
const readContext = (workspace: string) => {
  const mediaEnv = serverEnv();
  return { room: "room:" + workspace, appOrigin: mediaEnv.APP_ORIGIN, mediaEnv } as never;
};
/** Only language records, each holding the code and its binding. */
function recordsOnly(storage: Memory, label: string) {
  for (const key of storage.written) expect(key.startsWith(CRYPTO_CHAT_LANGUAGE_PREFIX), label).toBe(true);
  for (const [key, row] of storage.rows)
    if (key.startsWith(CRYPTO_CHAT_LANGUAGE_PREFIX)) {
      expect(Object.keys(row as object).sort(), label).toEqual(["case", "code", "message", "v"]);
      expect(cryptoLanguage((row as { code: unknown }).code), label).toBeDefined();
    }
}

type Visit = {
  workspace: string;
  thread: string;
  seq: number;
  messages: { id: string; revision: number; author: string }[];
  record: { case: number; message: string; code: string } | null;
};

describe("crypto desk chat language", () => {
  simulate("keeps one checked choice per desk thread, bound to its message and case", async (draw) => {
    const network = vi.fn(async () => {
      throw new Error("The simulation has no network.");
    });
    vi.stubGlobal("fetch", network);
    try {
      // The public policy offers the choice only on the desk's own production page.
      for (const workspace of [DESK, OTHER])
        for (const state of ["on", "off", "expired"] as const)
          for (const server of ["production", "staging", "switch-off"] as const)
            for (const origin of [ORIGIN, "https://wallet.example"])
              expect(
                cryptoChatLanguageOn(workspaceFeatureEnvFromFlags(serverEnv(server), flagRows(state), workspace), workspace, origin),
                JSON.stringify({ workspace, state, server, origin }),
              ).toBe(workspace === DESK && state === "on" && server === "production" && origin === ORIGIN);

      let deskFlag: FlagState = draw.pick(["on", "on", "off", "expired"] as const);
      const stores: Record<string, Memory> = { [DESK]: room(DESK, deskFlag), [OTHER]: room(OTHER, "on") };
      const visits: Visit[] = [
        { workspace: DESK, thread: `tc-${"a".repeat(32)}`, seq: 1, messages: [], record: null },
        { workspace: DESK, thread: `tc-${"b".repeat(32)}`, seq: 1, messages: [], record: null },
        { workspace: OTHER, thread: `tc-${"c".repeat(32)}`, seq: 1, messages: [], record: null },
      ];
      let id = 0;
      for (let step = 0; step < 60; step++) {
        const visit = draw.pick(visits);
        const storage = stores[visit.workspace];
        const action = draw.pick(["send", "send", "send", "send", "reply", "edit", "new-case", "purge", "flag"] as const);
        const label = JSON.stringify({ step, action, workspace: visit.workspace, thread: visit.thread, deskFlag });
        if (action === "send") {
          const entry: Entry = draw.chance(0.7) ? "hosted" : draw.pick(ENTRIES);
          const server: Server = draw.chance(0.85) ? "production" : draw.pick(["staging", "switch-off"] as const);
          const value = draw.chance(0.3) ? undefined : draw.chance(0.75) ? draw.pick(CRYPTO_LANGUAGES).code : draw.pick(INVALID);
          const gate = visit.workspace === DESK && entry === "hosted" && server === "production" && deskFlag === "on";
          const sendLabel = JSON.stringify({ step, entry, server, value, gate, thread: visit.thread });
          const before = JSON.stringify([...storage.rows]);
          const checked = cryptoChatLanguageInput(storage as never, sendContext(visit.workspace, entry, server), value);
          if (gate && value !== undefined && !cryptoLanguage(value)) {
            await expect(checked, sendLabel).rejects.toMatchObject({ status: 400, reason: "chat-language" });
            // A refused send writes nothing, so its message never exists.
            expect(JSON.stringify([...storage.rows]), sendLabel).toBe(before);
            continue;
          }
          // Without the gate the field is ignored and the send goes on as before.
          const chosen = await checked;
          expect(chosen, sendLabel).toBe(gate ? (value === undefined ? null : value) : undefined);
          const message = { id: String(++id), revision: 1, author: "account:visitor" };
          visit.messages.push(message);
          storage.rows.set(messageKey(visit.thread, id), {
            ...message,
            text: "Synthetic question.",
            createdAt: new Date(T + step).toISOString(),
          });
          if (chosen !== undefined) {
            await saveCryptoChatLanguage(storage as never, visit.thread, visit.seq, message.id, chosen);
            visit.record = chosen === null ? null : { case: visit.seq, message: message.id, code: chosen };
          }
        } else if (action === "reply") {
          const message = { id: String(++id), revision: 1, author: bot };
          visit.messages.push(message);
          storage.rows.set(messageKey(visit.thread, id), { ...message, text: "Synthetic reply.", createdAt: new Date(T + step).toISOString() });
        } else if (action === "edit") {
          const last = visit.messages.at(-1);
          if (!last) continue;
          last.revision++;
          const row = storage.rows.get(messageKey(visit.thread, Number(last.id))) as { revision: number };
          row.revision = last.revision;
        } else if (action === "new-case") visit.seq++;
        else if (action === "purge") {
          await deleteThreadCryptoChatLanguage(storage as never, "room:" + visit.workspace, visit.thread);
          visit.record = null;
        } else {
          deskFlag = draw.pick(["on", "off", "expired"] as const);
          setFlag(stores[DESK], deskFlag);
        }
        // The runner reads a choice only for the newest message it was sent
        // with, in the current case, on the desk, while the flag is on.
        for (const other of visits) {
          const read = await cryptoChatLanguageState(stores[other.workspace] as never, readContext(other.workspace), other.thread, other.seq);
          const last = other.messages.at(-1);
          if (other.workspace !== DESK || deskFlag !== "on" || !last) expect(read, label).toBeNull();
          else
            expect(read, label).toEqual({
              latest: { id: last.id, revision: last.revision },
              code: other.record?.case === other.seq && other.record.message === last.id ? other.record.code : null,
            });
        }
        // Only the desk ever holds or clears a record; a neighbor's storage sees no write.
        recordsOnly(stores[DESK], label);
        expect(stores[OTHER].written.size, label).toBe(0);
        expect([...stores[OTHER].rows.keys()].some((key) => key.startsWith(CRYPTO_CHAT_LANGUAGE_PREFIX)), label).toBe(false);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, { timeout: 60_000 });
});

const SCENARIOS = [
  "chosen", "english", "unselected", "asks-other", "fixed", "late", "fixed-text",
  "stale", "reply-retry", "runner-flag-off", "other-workspace", "old-case", "neighbor",
] as const;
type Scenario = (typeof SCENARIOS)[number];
const QUESTION = "My transfer has been pending since this morning. What should I check first?";
const ANSWER = "A pending transfer usually finishes after the network confirms it.";
type Message = { id: string; revision: number; author: string; text: string; createdAt: string };
const answer = (body: object, model: string): ModelResult => ({ kind: "answer", model, usage: {}, value: body });
const value = (text: string, extra: object = {}) => ({
  action: "reply", text, confidence: "high", handoffReason: null,
  sources: [], facts: [], claims: [], comparisons: [], summary: "", ...extra,
});

/** One member turn through the room's own choice records and the real runner.
 * The fake room serves the bot view and admits a managed reply only with a
 * current receipt. Nothing reaches a network or a knowledge source. */
async function runDesk(draw: Rng, scenario: Scenario) {
  const desk = scenario !== "other-workspace";
  const workspace = desk ? DESK : OTHER;
  const roomId = "room:" + workspace;
  const model = desk ? CRYPTO_SUPPORT_MODEL : DEFAULT_SUPPORT_MODEL;
  const chosen = draw.pick(TRANSLATED).code;
  const sent = scenario === "english" ? "en" : scenario === "unselected" || scenario === "neighbor" ? undefined : chosen;
  const newer = draw.chance(0.25) ? undefined : draw.pick(CRYPTO_LANGUAGES.filter((language) => language.code !== sent)).code;
  const asked = draw.pick(TRANSLATED.filter((language) => language.code !== chosen));
  const verdict = draw.pick(["technical", "scam", "investing", "other"] as const);
  const refusal = draw.pick([INVESTMENT_REFUSAL, HOSTED_SOCIAL_REPLIES.offTopic]);
  const db = knowledgeTestDb();
  ensureSchema(db, T);
  writeMeta(db, "room", roomId);
  const faq = addSource(db, { kind: "faq", title: "Pending transfers", text: ANSWER }, T);
  const sourceCount = () => db.sql.exec("SELECT COUNT(*) AS n FROM kb_sources").toArray()[0].n;
  const sourcesBefore = sourceCount();
  const storage = room(workspace, "on");
  const thread = `tc-${"d".repeat(32)}`;
  const member = "account:language-visitor";
  let seq = 1;
  let now = T + 1_000;
  const messages: Message[] = [];
  const latest = () => messages.at(-1)!;
  const write = (message: Message) => {
    messages.push(message);
    storage.rows.set(messageKey(thread, Number(message.id)), structuredClone(message));
  };
  /** A member send through the room's own check, then its record in the same write. */
  const send = async (text: string, language: string | undefined) => {
    const accepted = await cryptoChatLanguageInput(storage as never, sendContext(workspace, "hosted"), language);
    const message = { id: String(messages.length + 1), revision: 1, author: member, text, createdAt: new Date(now).toISOString() };
    write(message);
    if (accepted !== undefined) await saveCryptoChatLanguage(storage as never, thread, seq, message.id, accepted);
  };
  // Another visitor's choice in the same workspace.
  if (scenario === "neighbor") await saveCryptoChatLanguage(storage as never, `tc-${"9".repeat(32)}`, 1, "1", chosen);
  await send(scenario === "asks-other" ? `Please answer in ${asked.english}. ${QUESTION}` : QUESTION, sent);
  if (scenario === "old-case") seq = 2;

  const calls: { kind: string; system: string; user: string }[] = [];
  const replies: { text: string; tools: string[]; language?: string }[] = [];
  const drafts: string[] = [], handoffs: Record<string, unknown>[] = [], refused: Record<string, unknown>[] = [];
  const tampered: boolean[] = [];
  let newerSent = false;
  let replyFailed = false;
  const client = {
    async get(path: string) {
      if (path.includes("managed/state")) {
        const bound = await cryptoChatLanguageState(storage as never, readContext(workspace), thread, seq);
        // Another workspace's runner ignores even a choice its state names.
        const forged = { latest: { id: latest().id, revision: latest().revision }, code: chosen };
        const cryptoLanguage = desk ? bound : forged;
        return { status: 200, body: {
          prepaid: true, prepaidModel: DEFAULT_SUPPORT_MODEL, sponsoredResearch: desk, readinessPolicy: "grounded_v1",
          enabled: true, onTeam: true, grant: true, thread, member, state: "open", mode: "answers",
          caseSeq: seq, caseOpenedAt: T, caseMemberMessages: messages.filter((message) => message.author === member).length,
          evidence: [], memberEvidence: [], storageGrant: null,
          ...(cryptoLanguage ? { cryptoLanguage } : {}),
        } };
      }
      // A newer send with its own choice lands between the state and message reads.
      if (scenario === "stale" && !newerSent) {
        newerSent = true;
        await send("Any update on this?", newer);
      }
      return { status: 200, body: { messages: structuredClone(messages) } };
    },
    async post(path: string, body: Record<string, unknown>) {
      if (body.action === "handoff") {
        handoffs.push(body);
        return { status: 200, body: {} };
      }
      if (body.action === "draft") {
        drafts.push(String(body.text));
        return { status: 201, body: {} };
      }
      if (body.action === "evidence")
        return { status: 201, body: { evidence: (body.rows as unknown[]).map((_, index) => ({ n: index + 1 })) } };
      if (!path.endsWith("/messages")) return { status: 400, body: {} };
      // The room is briefly unavailable for the first reply; the job runs again.
      if (scenario === "reply-retry" && !replyFailed) {
        replyFailed = true;
        return { status: 503, body: {} };
      }
      const last = latest();
      const ifLatest = body.ifLatest as { id: string; revision: number };
      if (ifLatest.id !== last.id || ifLatest.revision !== last.revision) return { status: 409, body: { reason: "stale" } };
      const managed = body.managed as { grounded: string; clarifying: boolean };
      const provenance = body.provenance as { sources: { id: string }[]; grounding: unknown; tools: string[] };
      const args = {
        receipt: managed.grounded, grounding: provenance.grounding, thread, case: seq,
        latest: { id: last.id, revision: last.revision }, text: body.text,
        sourceIds: provenance.sources.map((source) => source.id), sources: provenance.sources, storageGrant: null,
      };
      const checked = (await verifyGroundedReceipt(db, args, now)) as { ok: boolean; clarifying?: boolean };
      if (!checked.ok || checked.clarifying !== managed.clarifying) {
        refused.push(body);
        return { status: 409, body: { reason: "grounded-answer-unverified" } };
      }
      // The receipt binds the language its verifier used: another code, or none, fails.
      const key = RECEIPT + managed.grounded;
      const saved = readMeta(db, key)!;
      const receipt = JSON.parse(saved) as { language?: string };
      const swapped = receipt.language
        ? draw.chance(0.5) ? undefined : draw.pick(CRYPTO_LANGUAGES.filter((language) => language.code !== receipt.language)).code
        : draw.pick(CRYPTO_LANGUAGES).code;
      writeMeta(db, key, JSON.stringify({ ...receipt, language: swapped }));
      tampered.push((await verifyGroundedReceipt(db, args, now)).ok);
      writeMeta(db, key, saved);
      write({ id: String(messages.length + 1), revision: 1, author: bot, text: String(body.text), createdAt: new Date(now).toISOString() });
      replies.push({ text: String(body.text), tools: provenance.tools, language: receipt.language });
      return { status: 201, body: { message: latest() } };
    },
  };
  const provider = async ({ system, user }: ModelRequest): Promise<ModelResult> => {
    const kind = system.startsWith("Classify an unresolved") ? "triage"
      : system.startsWith("You independently check") ? "verify"
        : system.includes("using only the supplied FAQs") ? "faq" : "answer";
    calls.push({ kind, system, user });
    if (kind === "triage") return answer(value(verdict), model);
    if (kind === "faq") return { kind: "failed", reason: "provider", usage: null };
    if (kind === "verify")
      return answer(value("Supported.", {
        sources: (JSON.parse(user).passages as { sourceId: string }[]).map((passage) => passage.sourceId),
      }), model);
    if (scenario === "fixed") return answer(value("", { action: "handoff", confidence: "low", handoffReason: "unsure" }), model);
    if (scenario === "fixed-text") return answer(value(refusal, { action: "clarify" }), model);
    return answer(value(ANSWER, { sources: [`kb:${faq.id}-1`] }), model);
  };
  const features = Object.fromEntries(WORKSPACE_FLAG_KEYS.map((key) => [key, false])) as WorkspaceFeatures;
  features.managedAgent = true;
  features.cryptoChatLanguage = scenario !== "runner-flag-off";
  const deps: RunnerDeps = {
    db, room: roomId, principal: bot,
    env: workspaceFeatureEnvFromValues({
      MANAGED_AGENT_ENABLED: "true", MANAGED_AGENT_SPEND_CAP_USD_CENTS: "10000", MANAGED_AGENT_GATEWAY_ID: "templ-support",
      AI: { run: async () => ({}) } as unknown as Pick<Ai, "run">,
    }, features, workspace),
    roomClient: () => client as never,
    model: null,
    prepaidModel: (_billing, sponsored) => {
      if (Boolean(sponsored) !== desk) throw new Error("The call used another funding path.");
      return provider;
    },
    now: () => now,
    templMeter: { reserve: async () => true, settle: async () => {}, release: async () => {} },
  };
  addJobs(db, [{
    id: crypto.randomUUID(), kind: "member-message", thread, request: null, manager: bot,
    at: now - (scenario === "late" ? 91_000 : 500), due: now, attempts: 0,
  }]);
  const first: JobOutcome[] = await runManagedJobs(deps);
  const firstCalls = calls.length;
  let again: JobOutcome[] = [];
  if (first[0] === "retry") {
    now += 30_000;
    again = await runManagedJobs(deps);
  }
  const sourcesAfter = sourceCount();
  db.raw.close();
  return {
    desk, model, sent, newer, asked, verdict, refusal, first, again, firstCalls,
    calls, replies, drafts, handoffs, refused, tampered, storage, sourcesBefore, sourcesAfter,
  };
}

describe("crypto desk chat language in answers", () => {
  simulate("answers in the visitor's chosen language only for their current desk turn", async (draw) => {
    const network = vi.fn(async () => {
      throw new Error("The simulation has no network.");
    });
    vi.stubGlobal("fetch", network);
    try {
      for (const scenario of draw.shuffle(SCENARIOS)) {
        const run = await runDesk(draw, scenario);
        const label = JSON.stringify({ scenario, sent: run.sent, newer: run.newer, verdict: run.verdict });
        // The choice that drives this turn: the desk, the runner's flag, the
        // current case and the visitor's own newest message must all agree.
        const active = !run.desk || ["runner-flag-off", "old-case", "unselected", "neighbor"].includes(scenario)
          ? null
          : (scenario === "stale" ? run.newer : run.sent) ?? null;
        const language = active ? cryptoLanguage(active)! : null;
        const fixedEnglish = scenario === "fixed" || scenario === "late"
          ? { technical: null, scam: CRYPTO_SCAM_REPLY, investing: INVESTMENT_REFUSAL, other: CRYPTO_CLARIFY_REPLY }[run.verdict]
          : scenario === "fixed-text" ? run.refusal : undefined;

        if (scenario === "stale" || scenario === "reply-retry") {
          // A choice bound to an older message waits for the next read, before
          // any model call. A failed reply runs again with the same choice.
          expect(run.first, label).toEqual(["retry"]);
          expect(run.firstCalls, label).toBe(scenario === "stale" ? 0 : 2);
          expect(run.again, label).toEqual(["answered"]);
        } else expect(run.first, label).toEqual([fixedEnglish === null ? "handed-off" : fixedEnglish ? "clarified" : "answered"]);
        expect(run.calls.map((call) => call.kind), label).toEqual(
          scenario === "fixed" ? ["answer", "triage"]
            : scenario === "late" ? ["triage"]
              : scenario === "fixed-text" ? ["answer"]
                : scenario === "reply-retry" ? ["answer", "verify", "answer", "verify"]
                  : ["answer", "verify"],
        );
        // Fixed replies use Templ's checked translation, or stay English.
        expect(run.replies.map((reply) => reply.text), label).toEqual(
          fixedEnglish === null ? [] : fixedEnglish ? [translated(fixedEnglish, active)] : [ANSWER],
        );
        if (fixedEnglish === null) {
          expect(run.handoffs, label).toHaveLength(1);
          expect(run.drafts, label).toEqual([GROUNDED_SUMMARY]);
        }
        for (const call of run.calls) {
          // The rule comes from the allowlist entry, in the trusted system prompt only.
          expect(call.user.includes(MENU), label).toBe(false);
          if (call.kind === "triage") expect(call.system, label).toBe(CRYPTO_TRIAGE_SYSTEM);
          else if (call.kind === "verify") expect(call.system, label).toBe(groundedVerifierSystem(run.model, active ?? undefined));
          else if (language) expect(call.system.endsWith(cryptoReplyLanguageRule(language)), label).toBe(true);
          else expect(call.system.includes(MENU), label).toBe(false);
        }
        // A choice outranks a language the question asks for.
        if (scenario === "asks-other") {
          const call = run.calls.find((item) => item.kind === "answer")!;
          expect(call.user, label).toContain(`Please answer in ${run.asked.english}.`);
          expect(call.system, label).not.toContain(`${run.asked.english} (${run.asked.code})`);
        }
        // Each reply records the language Templ asked for, and the receipt binds it.
        for (const reply of run.replies) {
          expect(reply.tools.includes("chat-language"), label).toBe(Boolean(active));
          expect(reply.language, label).toBe(active ?? undefined);
        }
        expect(run.tampered, label).toEqual(run.replies.map(() => false));
        expect(run.refused, label).toEqual([]);
        // Nothing else was written: no knowledge source and, in another workspace, no record.
        expect(run.sourcesAfter, label).toBe(run.sourcesBefore);
        recordsOnly(run.storage, label);
        if (!run.desk) expect(run.storage.written.size, label).toBe(0);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, { timeout: 60_000 });

  simulate("uses only Templ's checked translations of the current fixed replies", (draw) => {
    // Every bundled translation is current, passes the checks and stays a fixed reply.
    for (const [code, replies] of Object.entries(bundled as Record<string, Record<string, string>>)) {
      expect(code === "en" || !cryptoLanguage(code), code).toBe(false);
      for (const [english, text] of Object.entries(replies)) {
        expect(SOURCES, `${code}: ${english}`).toContain(english);
        expect(CRYPTO_REPLY_TRANSLATIONS.get(code)?.get(english), `${code}: ${english}`).toBe(text);
        expect(cryptoServiceReplies.has(text), `${code}: ${english}`).toBe(true);
      }
    }
    // Synthetic entries that add or drop something fall back to English.
    const examples: Record<string, string> = {
      "Ask Security Alliance for help.": "Demandez de l’aide à Security Alliance.",
      "Paste the link from mempool.space.": "Collez le lien depuis mempool.space.",
      "Try again later.": "Réessayez plus tard.",
    };
    const sources = Object.keys(examples);
    const english = draw.pick(sources);
    const clean = examples[english];
    const code = draw.pick(TRANSLATED).code;
    const broken: unknown[] = [
      `${clean} 2`, `${clean} ${String.fromCodePoint(0x663)}`, `${clean} https://wallet.example`,
      `${clean} www.wallet.example`, `${clean} wallet.example`, `<b>${clean}</b>`, `${clean} [lien](x)`,
      String.fromCodePoint(0x202e) + clean, `${clean}\n${clean}`, ` ${clean}`, `${clean} `, "é".repeat(600), "", 42, null,
      ...(english === "Try again later." ? [] : [clean.replace("Security Alliance", "l’alliance").replace("mempool.space", "un explorateur")]),
    ];
    for (const text of draw.shuffle(broken))
      expect(serviceReplyTable(sources, { [code]: { [english]: text } }).size, JSON.stringify(text)).toBe(0);
    expect(serviceReplyTable(sources, { [code]: { [english]: clean } }).get(code)?.get(english)).toBe(clean);
    for (const raw of [
      { en: { [english]: clean } }, { [code.toUpperCase()]: { [english]: clean } }, { xx: { [english]: clean } },
      { [code]: { [english + " "]: clean } }, { [code]: [clean] }, [], null, "table",
    ])
      expect(serviceReplyTable(sources, raw).size, JSON.stringify(raw)).toBe(0);
  });
});
