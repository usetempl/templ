import { describe, expect, vi } from "vitest";
import { spendMonth } from "@templ/chat/managed-agent";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import {
  CRYPTO_MONTHLY_BUDGET_CENTS,
  CRYPTO_SUPPORT_WORKSPACE,
} from "@templ/chat/support-models";
import type { WorkspaceFlag } from "@templ/chat/workspace-flags";
import {
  CRYPTO_VOICE_HEADER,
  CRYPTO_VOICE_NOTE,
  cryptoVoiceAdmission,
  cryptoVoiceNotesOn,
} from "../src/crypto-voice-notes";
import {
  CRYPTO_VOICE_MODEL,
  transcribeCryptoVoiceNote,
} from "../src/crypto-voice-transcribe";
import {
  CRYPTO_VOICE_WAV,
  readCryptoVoiceNote,
  type CryptoVoiceNote,
} from "../src/crypto-voice-wav";
import {
  CRYPTO_VOICE_LIMITS,
  cryptoVoiceCents,
  cryptoVoiceInput,
  cryptoVoiceLedger,
  type CryptoVoiceResult,
} from "../src/managed-agent/crypto-voice-ledger";
import { TEMPL_SPEND_OBJECT } from "../src/managed-agent/knowledge-hooks";
import {
  RESERVATION_MS,
  reserveSpend,
  saveWorkspaceSpend,
  settleSpend,
  templSpendRequest,
  workspaceSpend,
  type SpendRecord,
} from "../src/managed-agent/store";
import { ENCRYPTION_POLICY_KEY } from "../src/support-encryption";
import {
  KnowledgeError,
  ensureSchema,
  readMetaJson,
  type KnowledgeDb,
} from "../src/support-knowledge-schema";
import {
  WORKSPACE_FLAGS_KEY,
  workspaceFeatureEnvFromFlags,
} from "../src/workspace-flags";
import { knowledgeTestDb } from "./knowledge-sqlite";

// This portable source has no production workspace identity. Exercise an isolated desk.
vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000003",
}));


const DESK = CRYPTO_SUPPORT_WORKSPACE;
const DESK_ROOM = "room:" + DESK;
const OTHER = "01990000-0000-7000-8000-00000000000c";
const ORIGIN = "https://usetempl.com";
const MINUTE = 60_000;
const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 27, 12);
const SPONSORED = "product-sponsored-support-v1";
const operator = ("0x" + "5".repeat(40)) as ChatPrincipalId;
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const hex = (draw: Rng, length: number) => draw.text("0123456789abcdef", length);
const uuid = (draw: Rng) =>
  `${hex(draw, 8)}-${hex(draw, 4)}-4${hex(draw, 3)}-${draw.pick(["8", "9", "a", "b"])}${hex(draw, 3)}-${hex(draw, 12)}`;

/** A canonical recording of `dataBytes` of a 220 Hz tone. */
function recording(dataBytes: number, amplitude = 8_000): Uint8Array {
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) =>
    [...text].forEach((letter, index) => view.setUint8(at + index, letter.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let at = 0; at + 1 < dataBytes; at += 2)
    view.setInt16(44 + at, Math.round(amplitude * Math.sin((at * Math.PI * 220) / 16_000)), true);
  return bytes;
}

/** An upload whose body arrives in random pieces and counts what was pulled. */
function upload(
  draw: Rng,
  bytes: Uint8Array,
  options: { type?: string | null; encoding?: string; query?: string; declared?: string } = {},
) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.byteLength) return controller.close();
      const size = draw.int(1, 65_536);
      controller.enqueue(bytes.slice(sent, sent + size));
      sent += size;
    },
  });
  const headers = new Headers();
  if (options.type !== null) headers.set("Content-Type", options.type ?? "audio/wav");
  if (options.encoding) headers.set("Content-Encoding", options.encoding);
  if (options.declared) headers.set("Content-Length", options.declared);
  const url = new URL(`https://api.usetempl.com/widget/${DESK}/voice/transcribe${options.query ?? `?clientId=${uuid(draw)}`}`);
  // The reader takes only the headers and the body stream of a request.
  const request = { headers, body } as unknown as Request;
  return { request, url, sent: () => sent };
}

const MUTATIONS = [
  "riff-tag", "wave-tag", "fmt-tag", "data-tag", "fmt-size", "format", "channels", "rate",
  "byte-rate", "align", "bits", "riff-size", "declares-more", "declares-less", "trailing",
  "truncated", "odd", "short", "long", "empty", "silent", "hiss", "type", "encoding",
  "client-id", "declared-large", "declared-junk",
] as const;
const INVALID = { status: 400, reason: "voice-note-invalid" };

describe("crypto desk voice note uploads", () => {
  simulate("reads only the canonical recording, within the bytes its header declares", async (draw) => {
    // Valid recordings of every length, the shortest and the longest included.
    const lengths = [
      CRYPTO_VOICE_WAV.minDataBytes,
      CRYPTO_VOICE_WAV.maxDataBytes,
      ...Array.from({ length: 4 }, () => 2 * draw.int(6_400, 80_000)),
    ];
    for (const dataBytes of draw.shuffle(lengths)) {
      const bytes = recording(dataBytes);
      const clientId = uuid(draw);
      const sentLength = draw.chance(0.5) ? { declared: String(bytes.byteLength) } : {};
      const { request, url } = upload(draw, bytes, { query: `?clientId=${clientId}`, ...sentLength });
      const note = await readCryptoVoiceNote(request, url);
      expect(note.clientId).toBe(clientId);
      expect(note.seconds, String(dataBytes)).toBe(Math.ceil(dataBytes / 32_000));
      expect(note.seconds).toBeLessThanOrEqual(120);
      expect(note.bytes.byteLength).toBe(bytes.byteLength);
      expect(Buffer.from(note.bytes).equals(Buffer.from(bytes))).toBe(true);
    }

    for (const mutation of draw.shuffle(MUTATIONS)) {
      const dataBytes = 2 * draw.int(8_000, 40_000);
      let bytes = recording(dataBytes);
      const view = new DataView(bytes.buffer);
      let options: Parameters<typeof upload>[2] = {};
      let expected: { status: number; reason: string } = INVALID;
      let pulledAtMost = Infinity;
      if (mutation === "riff-tag") bytes[draw.int(0, 3)] ^= 0x20;
      else if (mutation === "wave-tag") bytes[draw.int(8, 11)] ^= 0x20;
      else if (mutation === "fmt-tag") bytes[draw.int(12, 15)] ^= 0x01;
      else if (mutation === "data-tag") bytes[draw.int(36, 39)] ^= 0x20;
      else if (mutation === "fmt-size") view.setUint32(16, draw.pick([18, 40, 0]), true);
      else if (mutation === "format") view.setUint16(20, draw.pick([3, 6, 7, 0xfffe]), true);
      else if (mutation === "channels") view.setUint16(22, draw.pick([0, 2, 6]), true);
      else if (mutation === "rate") view.setUint32(24, draw.pick([8_000, 22_050, 44_100, 48_000]), true);
      else if (mutation === "byte-rate") view.setUint32(28, draw.pick([16_000, 64_000]), true);
      else if (mutation === "align") view.setUint16(32, draw.pick([1, 4]), true);
      else if (mutation === "bits") view.setUint16(34, draw.pick([8, 24, 32]), true);
      else if (mutation === "riff-size") view.setUint32(4, draw.pick([0, 35 + dataBytes, 37 + dataBytes, 0xffff_ffff]), true);
      else if (mutation === "declares-more" || mutation === "declares-less") {
        const declared = dataBytes + (mutation === "declares-more" ? 2 : -2) * draw.int(1, 500);
        view.setUint32(40, declared, true);
        view.setUint32(4, declared + 36, true);
      } else if (mutation === "trailing") {
        const longer = new Uint8Array(bytes.byteLength + draw.int(1, 4_000));
        longer.set(bytes);
        bytes = longer;
      } else if (mutation === "truncated") bytes = bytes.slice(0, draw.int(1, bytes.byteLength - 1));
      else if (mutation === "odd") {
        const longer = new Uint8Array(bytes.byteLength + 1);
        longer.set(bytes);
        new DataView(longer.buffer).setUint32(40, dataBytes + 1, true);
        new DataView(longer.buffer).setUint32(4, dataBytes + 37, true);
        bytes = longer;
      } else if (mutation === "short") {
        bytes = recording(CRYPTO_VOICE_WAV.minDataBytes - 2 * draw.int(1, 6_000));
        expected = { status: 400, reason: "voice-note-too-short" };
      } else if (mutation === "long") {
        // The header alone refuses it; the samples are never pulled.
        const declared = CRYPTO_VOICE_WAV.maxDataBytes + 2 * draw.int(1, 100_000);
        const longer = new Uint8Array(44 + declared);
        longer.set(bytes.subarray(0, 44));
        new DataView(longer.buffer).setUint32(40, declared, true);
        new DataView(longer.buffer).setUint32(4, declared + 36, true);
        bytes = longer;
        expected = { status: 413, reason: "voice-note-too-large" };
        pulledAtMost = 3 * 65_536;
      } else if (mutation === "empty") bytes = new Uint8Array(0);
      else if (mutation === "silent" || mutation === "hiss") {
        bytes = recording(dataBytes, mutation === "silent" ? 0 : draw.int(1, 40));
        expected = { status: 422, reason: "voice-note-silent" };
      } else if (mutation === "type") {
        options = { type: draw.pick(["audio/wave", "audio/x-wav", "audio/wav; codecs=1", "AUDIO/WAV", "audio/webm", "application/octet-stream", "application/json", null]) };
        expected = { status: 415, reason: "voice-note-invalid" };
        pulledAtMost = 0;
      } else if (mutation === "encoding") {
        options = { encoding: draw.pick(["gzip", "br", "identity"]) };
        expected = { status: 415, reason: "voice-note-invalid" };
        pulledAtMost = 0;
      } else if (mutation === "client-id") {
        const id = uuid(draw);
        options = { query: draw.pick(["", "?clientId=", "?clientId=1", `?clientId=${id.toUpperCase()}`, `?clientId=${id}&clientId=${id}`, `?clientId=${id}&attachment=1`, `?id=${id}`]) };
        pulledAtMost = 0;
      } else if (mutation === "declared-large") {
        options = { declared: String(CRYPTO_VOICE_WAV.maxBytes + draw.int(1, 9_000_000)) };
        expected = { status: 413, reason: "voice-note-too-large" };
        pulledAtMost = 0;
      } else {
        options = { declared: draw.pick(["abc", "-1", "1e3", "12.5"]) };
        pulledAtMost = 0;
      }
      const { request, url, sent } = upload(draw, bytes, options);
      await expect(readCryptoVoiceNote(request, url), mutation).rejects.toMatchObject(expected);
      // A refusal before the body leaves it unread; one stream piece may be buffered.
      expect(sent(), mutation).toBeLessThanOrEqual(pulledAtMost === 0 ? 65_536 : pulledAtMost);
    }
  }, { timeout: 60_000 });
});

/** One room object's storage. `written` holds every key the code under test wrote or deleted. */
class Memory {
  rows = new Map<string, unknown>();
  written = new Set<string>();
  async get(key: string) {
    return structuredClone(this.rows.get(key));
  }
  async put(key: string, value: unknown) {
    this.rows.set(key, structuredClone(value));
    this.written.add(key);
  }
  async delete(key: string) {
    this.written.add(key);
    return this.rows.delete(key);
  }
}
type FlagState = "on" | "off" | "expired";
type Server = "production" | "staging" | "switch-off";
const ENTRIES = ["hosted", "frame", "embed", "app", "other-origin", "bot"] as const;
type Entry = (typeof ENTRIES)[number];
const flagRows = (state: FlagState): WorkspaceFlag[] =>
  state === "off"
    ? []
    : [{
        key: "cryptoVoiceNotes",
        on: true,
        until: new Date(Date.now() + (state === "on" ? 30 * DAY : -MINUTE)).toISOString(),
        operator,
        authenticatedAt: new Date(Date.now() - MINUTE).toISOString(),
        reason: "Synthetic voice note simulation",
      }];
const serverEnv = (server: Server) => ({
  APP_ORIGIN: server === "staging" ? "https://staging.example.org" : ORIGIN,
  MANAGED_AGENT_ENABLED: server === "switch-off" ? "false" : "true",
});
const fakeAi = { run: async () => ({}) } as unknown as Pick<Ai, "run">;

describe("crypto desk voice note scope", () => {
  simulate("offers voice notes only on the desk's own page and admits only its visitors", async (draw) => {
    // The public policy and the upload route share this gate.
    for (const workspace of [DESK, OTHER])
      for (const state of ["on", "off", "expired"] as const)
        for (const server of ["production", "staging", "switch-off"] as const)
          for (const origin of [ORIGIN, "https://wallet.example"])
            for (const binding of ["bound", "no-ai", "no-gateway", "bad-gateway"] as const) {
              const env = workspaceFeatureEnvFromFlags({
                ...serverEnv(server),
                ...(binding === "no-ai" ? {} : { AI: fakeAi }),
                ...(binding === "no-gateway" ? {} : { MANAGED_AGENT_GATEWAY_ID: binding === "bad-gateway" ? "Templ Support" : "templ-support" }),
              }, flagRows(state), workspace);
              expect(
                cryptoVoiceNotesOn(env, workspace, origin),
                JSON.stringify({ workspace, state, server, origin, binding }),
              ).toBe(workspace === DESK && state === "on" && server === "production" && origin === ORIGIN && binding === "bound");
            }

    for (let step = 0; step < 80; step++) {
      const usual = draw.chance(0.6);
      const workspace = usual || draw.chance(0.6) ? DESK : OTHER;
      const state: FlagState = usual ? "on" : draw.pick(["on", "off", "expired"] as const);
      const server: Server = usual ? "production" : draw.pick(["production", "staging", "switch-off"] as const);
      const entry: Entry = usual ? "hosted" : draw.pick(ENTRIES);
      const sponsored = usual || draw.chance(0.7);
      const encrypted = !usual && draw.chance(0.25);
      const marker = usual || draw.chance(0.7);
      const method = usual || draw.chance(0.8) ? "POST" : "GET";
      const signedIn = usual || draw.chance(0.85);
      const blocked = draw.pick([null, null, null, "banned", "muted"] as const);
      const storage = new Memory();
      storage.rows.set("native-room", {
        room: { id: workspace, manager: operator, creator: operator, visibility: "public", createdAt: new Date(T - 90 * DAY).toISOString() },
      });
      const [flag] = flagRows(state);
      if (flag) storage.rows.set(WORKSPACE_FLAGS_KEY, { cryptoVoiceNotes: flag });
      if (sponsored) storage.rows.set(SPONSORED, true);
      if (encrypted)
        storage.rows.set(ENCRYPTION_POLICY_KEY, {
          v: 1, revision: 1, on: true,
          profile: { custody: "customer", clientOrigin: "https://secure.wallet.example" },
        });
      const mediaEnv = serverEnv(server);
      const headers = new Headers({ "X-Client-IP-Digest": hex(draw, 64) });
      if (entry !== "app") {
        headers.set("X-Support-Widget", "member");
        headers.set("X-Support-Widget-Origin", entry === "embed" || entry === "other-origin" ? "https://wallet.example" : ORIGIN);
      }
      if (entry !== "app" && entry !== "embed") headers.set("X-Support-Entry", "hosted");
      if (entry === "frame") headers.set("X-Support-Widget-Frame", "1");
      if (marker) headers.set(CRYPTO_VOICE_HEADER, "1");
      const aliases = [`account:${uuid(draw)}`, ...(draw.chance(0.3) ? ["0x" + hex(draw, 40)] : [])];
      const admission = cryptoVoiceAdmission(storage as never, {
        method,
        room: "room:" + workspace,
        isBot: entry === "bot",
        appOrigin: mediaEnv.APP_ORIGIN,
        headers,
        mediaEnv,
        viewer: {
          principalId: signedIn ? aliases[0] : null,
          banned: blocked === "banned",
          mutedUntil: blocked === "muted" ? new Date(Date.now() + DAY).toISOString() : null,
        },
        aliases,
      } as never);
      const label = JSON.stringify({ step, workspace, state, server, entry, sponsored, encrypted, marker, method, signedIn, blocked });
      const open = workspace === DESK && state === "on" && server === "production" && entry === "hosted" &&
        sponsored && !encrypted && marker && method === "POST" && signedIn;
      if (!open) await expect(admission, label).rejects.toMatchObject({ status: 404 });
      else if (blocked) await expect(admission, label).rejects.toMatchObject({ status: 403 });
      else {
        const response = await admission;
        expect(response.status, label).toBe(200);
        expect(await response.json(), label).toEqual({ admitted: true, principals: aliases, network: headers.get("X-Client-IP-Digest") });
      }
      // Admission reads the room's records and never writes one.
      expect(storage.written.size, label).toBe(0);
    }
  }, { timeout: 60_000 });
});

const spendRow = (db: KnowledgeDb, month: string) =>
  readMetaJson<SpendRecord>(db, `managed.spend:${month}`);
const booked = (db: KnowledgeDb, month: string) => {
  const row = spendRow(db, month);
  return (row?.spentCents ?? 0) +
    Object.values(row?.reservations ?? {}).reduce((sum, held) => sum + held.cents, 0);
};
const voiceRows = (db: KnowledgeDb) =>
  db.sql.exec("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key", "managed.voice.", "managed.voice/")
    .toArray() as { key: string; value: string }[];
const call = (db: KnowledgeDb, now: number, body: Record<string, unknown>) =>
  cryptoVoiceLedger(db, cryptoVoiceInput({ room: DESK_ROOM, seconds: 7, network: null, ...body }), now);

type Visitor = { ids: string[]; network: string | null; admitted: number[]; open: Map<string, number> };
type Attempt = { id: string; visitor: Visitor; at: number; settled: boolean };

describe("crypto desk voice note ledger", () => {
  simulate("admits each request id once, inside every limit and the desk's shared month", async (draw) => {
    const db = knowledgeTestDb();
    ensureSchema(db, T);
    let now = T + draw.int(0, 5_000);
    const networks = [hex(draw, 64), hex(draw, 64), null];
    const visitors: Visitor[] = Array.from({ length: 5 }, () => ({
      ids: [`account:${uuid(draw)}`, ...Array.from({ length: draw.int(0, 2) }, () => "0x" + hex(draw, 40))],
      network: draw.pick(networks),
      admitted: [],
      open: new Map(),
    }));
    const attempts: Attempt[] = [];
    const expected = new Map<string, number>();
    const byNetwork = new Map<string, number[]>();
    const byDay = new Map<number, number>();
    const within = (times: number[], ms: number) => times.filter((at) => at > now - ms).length;
    // Any order of the same linked identities is the same visitor.
    const acting = (visitor: Visitor) => ({ principals: draw.shuffle(visitor.ids), network: visitor.network });
    // Every cent is booked or held exactly once. A ledger call also leaves no
    // row from before yesterday.
    const check = (label: string, cleaned = true) => {
      for (const [month, cents] of expected) expect(booked(db, month), label).toBe(cents);
      const oldest = cleaned ? Math.floor(now / DAY) - 1 : 0;
      for (const row of voiceRows(db)) {
        expect(Number(row.key.split(":")[1]), label).toBeGreaterThanOrEqual(oldest);
        // Rows hold digests, times and cents: never an account or a network id.
        for (const secret of [...visitors.flatMap((visitor) => visitor.ids), ...networks])
          if (secret) expect(row.key.includes(secret) || row.value.includes(secret), label).toBe(false);
        const keys = Object.keys(JSON.parse(row.value)).sort().join();
        expect(["at,held,v", "at,v", "cents,v", "at,cents,hold,month,v,who", "at,cents,done,hold,month,v,who"], label).toContain(keys);
      }
    };

    for (let step = 0; step < 160; step++) {
      const action = draw.pick(["new", "new", "new", "new", "retry", "settle", "settle", "swap-settle", "wait", "wait", "text"] as const);
      const label = JSON.stringify({ step, action, now });
      if (action === "wait") {
        now += draw.pick([1_000, 20_000, 31_000, 61_000, RESERVATION_MS + 1, 6 * 3_600_000, 25 * 3_600_000]);
        continue;
      }
      if (action === "text") {
        // The desk's answers hold and settle against the same month record.
        const cents = draw.int(1, 40);
        const actual = draw.int(0, cents);
        const month = db.transaction(() => {
          const spend = workspaceSpend(db, now);
          const id = uuid(draw);
          expect(reserveSpend(spend.record, { id, cents, cap: CRYPTO_MONTHLY_BUDGET_CENTS, now, sponsored: true }), label).toBe(true);
          settleSpend(spend.record, id, actual);
          saveWorkspaceSpend(db, spend.month, spend.record);
          return spend.month;
        });
        expected.set(month, (expected.get(month) ?? 0) + actual);
        check(label, false);
        continue;
      }
      if (action === "settle" || action === "swap-settle") {
        if (!attempts.length) continue;
        const attempt = draw.pick(attempts);
        const other = draw.pick(visitors.filter((visitor) => visitor !== attempt.visitor));
        const result = await call(db, now, { op: "settle", clientId: attempt.id, ...acting(action === "settle" ? attempt.visitor : other) });
        // Rows from before yesterday are gone, so an old id reads as unknown.
        const kept = Math.floor(attempt.at / DAY) >= Math.floor(now / DAY) - 1;
        if (action === "swap-settle" || !kept) expect(result, label).toEqual({ ok: false, reason: "voice-note-used" });
        else {
          expect(result, label).toEqual({ ok: true });
          attempt.settled = true;
          attempt.visitor.open.delete(attempt.id);
        }
        check(label);
        continue;
      }
      const visitor = draw.pick(visitors);
      const known = action === "retry" && attempts.length ? draw.pick(attempts) : null;
      const kept = known && Math.floor(known.at / DAY) >= Math.floor(now / DAY) - 1;
      const id = known ? known.id : uuid(draw);
      const seconds = draw.int(1, 120);
      expect(cryptoVoiceCents(seconds), label).toBe(1);
      const result: CryptoVoiceResult = await call(db, now, { op: "reserve", clientId: id, seconds, ...acting(visitor) });
      const openHolds = [...visitor.open.values()].filter((until) => until > now).length;
      const today = Math.floor(now / DAY);
      const net = visitor.network ? (byNetwork.get(visitor.network) ?? []) : [];
      if (result.ok) {
        // A new id, no open hold and room under every limit.
        expect(Boolean(kept), label).toBe(false);
        expect(openHolds, label).toBe(0);
        expect(within(visitor.admitted, MINUTE), label).toBeLessThan(CRYPTO_VOICE_LIMITS.visitorPerMinute);
        expect(within(visitor.admitted, DAY), label).toBeLessThan(CRYPTO_VOICE_LIMITS.visitorDailyCents);
        expect(within(net, MINUTE), label).toBeLessThan(CRYPTO_VOICE_LIMITS.networkPerMinute);
        expect(within(net, DAY), label).toBeLessThan(CRYPTO_VOICE_LIMITS.networkDailyCents);
        expect(byDay.get(today) ?? 0, label).toBeLessThan(CRYPTO_VOICE_LIMITS.deskDailyCents);
        visitor.admitted.push(now);
        visitor.open.set(id, now + RESERVATION_MS);
        if (visitor.network) byNetwork.set(visitor.network, [...net, now]);
        byDay.set(today, (byDay.get(today) ?? 0) + 1);
        // An id whose row has expired is a new attempt.
        if (known) Object.assign(known, { visitor, at: now, settled: false });
        else attempts.push({ id, visitor, at: now, settled: false });
        const month = spendMonth(now);
        expected.set(month, (expected.get(month) ?? 0) + 1);
      } else if (result.reason === "voice-note-used") {
        expect(Boolean(kept) && (known!.settled || now >= known!.at + RESERVATION_MS), label).toBe(true);
      } else if (result.reason === "voice-note-in-progress") {
        expect((Boolean(kept) && !known!.settled && now < known!.at + RESERVATION_MS) || openHolds > 0, label).toBe(true);
        expect(result.retryAfter, label).toBeGreaterThan(0);
      } else if (result.reason === "voice-note-limit") {
        expect(within(visitor.admitted, MINUTE), label).toBe(CRYPTO_VOICE_LIMITS.visitorPerMinute);
        expect(result.retryAfter, label).toBeLessThanOrEqual(60);
      } else if (result.reason === "voice-note-daily-limit") {
        expect(within(visitor.admitted, DAY), label).toBe(CRYPTO_VOICE_LIMITS.visitorDailyCents);
      } else if (result.reason === "voice-note-network-limit") {
        expect(within(net, MINUTE) >= CRYPTO_VOICE_LIMITS.networkPerMinute || within(net, DAY) >= CRYPTO_VOICE_LIMITS.networkDailyCents, label).toBe(true);
      } else expect(byDay.get(today) ?? 0, label).toBe(CRYPTO_VOICE_LIMITS.deskDailyCents);
      check(label);
    }
    db.raw.close();
  }, { timeout: 120_000 });

  simulate("stops at the desk's day and at the month its answers share", async (draw) => {
    // The desk's day: sixteen visitors, each inside their own limits.
    const db = knowledgeTestDb();
    ensureSchema(db, T);
    let now = T;
    const crowd = Array.from({ length: 16 }, () => [`account:${uuid(draw)}`]);
    let admitted = 0;
    for (let round = 0; round < 20; round++) {
      for (const principals of draw.shuffle(crowd)) {
        const clientId = uuid(draw);
        const result = await call(db, now, { op: "reserve", clientId, principals });
        if (result.ok) {
          admitted++;
          expect(await call(db, now, { op: "settle", clientId, principals })).toEqual({ ok: true });
        } else expect(result).toEqual({ ok: false, reason: "voice-note-budget" });
      }
      now += 31_000;
    }
    expect(admitted).toBe(CRYPTO_VOICE_LIMITS.deskDailyCents);
    expect(spendRow(db, spendMonth(T))).toEqual({ spentCents: admitted, calls: admitted, reservations: {} });
    const late = [`account:${uuid(draw)}`];
    expect(await call(db, now, { op: "reserve", clientId: uuid(draw), principals: late })).toEqual({ ok: false, reason: "voice-note-budget" });
    expect(await call(db, now + DAY, { op: "reserve", clientId: uuid(draw), principals: late })).toEqual({ ok: true });
    db.raw.close();

    // The month: answers and voice notes draw down one record and one ceiling.
    const shared = knowledgeTestDb();
    ensureSchema(shared, T);
    const month = spendMonth(T);
    const room = draw.int(1, 2);
    const textHeld = draw.int(0, 30);
    saveWorkspaceSpend(shared, month, {
      spentCents: CRYPTO_MONTHLY_BUDGET_CENTS - room - textHeld,
      calls: 9,
      reservations: textHeld ? { [uuid(draw)]: { cents: textHeld, at: T, sponsored: true } } : {},
    });
    const principals = [`account:${uuid(draw)}`, "0x" + hex(draw, 40)];
    const ids = Array.from({ length: room + 1 }, () => uuid(draw));
    let at = T + 1_000;
    for (const [index, clientId] of ids.entries()) {
      const result = await call(shared, at, { op: "reserve", clientId, principals });
      if (index < room) {
        expect(result).toEqual({ ok: true });
        // A lost answer: the hold books itself in full when it runs out.
        if (draw.chance(0.5)) expect(await call(shared, at, { op: "settle", clientId, principals })).toEqual({ ok: true });
        at += RESERVATION_MS + 1;
      } else expect(result).toEqual({ ok: false, reason: "voice-note-budget" });
    }
    expect(booked(shared, month)).toBe(CRYPTO_MONTHLY_BUDGET_CENTS);
    // An answer finds the same month full.
    const textLane = workspaceSpend(shared, at);
    expect(reserveSpend(textLane.record, { id: uuid(draw), cents: 1, cap: CRYPTO_MONTHLY_BUDGET_CENTS, now: at, sponsored: true })).toBe(false);
    expect(textLane.record.spentCents).toBe(CRYPTO_MONTHLY_BUDGET_CENTS);
    // Late and repeated settlements of a booked note add nothing.
    for (const clientId of draw.shuffle(ids))
      await call(shared, at, { op: "settle", clientId, principals: draw.shuffle(principals) });
    expect(booked(shared, month)).toBe(CRYPTO_MONTHLY_BUDGET_CENTS);
    // A new month opens the ledger again.
    const next = Date.UTC(2026, 11, 1, 0, 5);
    expect(await call(shared, next, { op: "reserve", clientId: uuid(draw), principals })).toEqual({ ok: true });
    expect(booked(shared, spendMonth(next))).toBe(1);

    // Only the desk's room has a ledger, and only for well-formed calls.
    const base = { room: DESK_ROOM, op: "reserve", clientId: uuid(draw), seconds: 5, principals, network: null };
    for (const body of draw.shuffle<Record<string, unknown>>([
      { ...base, room: "room:" + OTHER }, { ...base, room: DESK }, { ...base, op: "refund" },
      { ...base, clientId: "1" }, { ...base, seconds: 0 }, { ...base, seconds: 121 }, { ...base, seconds: 1.5 },
      { ...base, principals: [] }, { ...base, principals: "account:x" }, { ...base, principals: [42] },
      { ...base, principals: ["account: x"] }, { ...base, network: "digest" },
    ]))
      expect(() => cryptoVoiceInput(body), JSON.stringify(body)).toThrow(KnowledgeError);
    shared.raw.close();

    // A hold for a model call that never started goes with nothing booked,
    // and only for the account that made it.
    const idle = knowledgeTestDb();
    ensureSchema(idle, T);
    const who = [`account:${uuid(draw)}`];
    const stranger = [`account:${uuid(draw)}`];
    const [released, expired] = [uuid(draw), uuid(draw)];
    expect(await call(idle, T, { op: "reserve", clientId: released, principals: who })).toEqual({ ok: true });
    expect(await call(idle, T + 5, { op: "release", clientId: released, principals: stranger })).toEqual({ ok: false, reason: "voice-note-used" });
    expect(booked(idle, month)).toBe(1);
    expect(await call(idle, T + 10, { op: "release", clientId: released, principals: who })).toEqual({ ok: true });
    for (const op of draw.shuffle(["release", "settle", "settle"]))
      expect(await call(idle, T + 20, { op, clientId: released, principals: who })).toEqual({ ok: true });
    expect(booked(idle, month)).toBe(0);
    expect(readMetaJson(idle, `managed.voice.desk:${String(Math.floor(T / DAY)).padStart(6, "0")}`)).toEqual({ v: 1, cents: 0 });
    expect(await call(idle, T + 30, { op: "reserve", clientId: released, principals: who })).toEqual({ ok: false, reason: "voice-note-used" });
    // A hold that ran out is booked; a late release leaves it booked.
    expect(await call(idle, T + MINUTE, { op: "reserve", clientId: expired, principals: who })).toEqual({ ok: true });
    const later = T + MINUTE + RESERVATION_MS + 1;
    expect(await call(idle, later, { op: "reserve", clientId: uuid(draw), principals: stranger })).toEqual({ ok: true });
    expect(spendRow(idle, month)?.spentCents).toBe(1);
    expect(await call(idle, later, { op: "release", clientId: expired, principals: who })).toEqual({ ok: true });
    expect(spendRow(idle, month)?.spentCents).toBe(1);
    expect(booked(idle, month)).toBe(2);
    idle.raw.close();
  }, { timeout: 120_000 });
});

const heard = (text: string, voiced = 2.4, extra: object = {}) => ({
  text,
  word_count: text.split(" ").length,
  transcription_info: { language: "en", language_probability: 0.98, duration: 3, duration_after_vad: voiced },
  segments: [{ start: 0, end: voiced, text, no_speech_prob: 0.02, avg_logprob: -0.2, compression_ratio: 1.2 }],
  ...extra,
});
const SCENARIOS = [
  "spoken", "short-speech", "untidy", "mixed-segments", "vad-empty", "ghost", "shapeless", "throws", "phrase",
  "spoken-phrase", "long", "refused-room", "no-ledger", "no-binding", "no-note", "duplicate",
  "swapped", "budget", "operating-cap",
] as const;
/** The spend meter object's storage, with what it has booked or holds. */
class Kv {
  rows = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.rows.get(key));
  }
  async put(key: string, value: unknown) {
    this.rows.set(key, structuredClone(value));
  }
  async transaction<T>(run: (tx: Kv) => Promise<T>) {
    return run(this);
  }
  booked() {
    let cents = 0;
    for (const [key, row] of this.rows)
      if (/^spend:\d{4}-\d{2}$/.test(key)) {
        const record = row as SpendRecord;
        cents += record.spentCents + Object.values(record.reservations).reduce((sum, held) => sum + held.cents, 0);
      }
    return cents;
  }
}
const QUESTION = "My transfer has been pending since this morning. What should I check first?";
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("crypto desk voice note transcription", () => {
  simulate("calls the model once per admitted note and returns only checked words", async (draw) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    const network = vi.fn(async () => {
      throw new Error("The simulation has no network.");
    });
    vi.stubGlobal("fetch", network);
    try {
      for (const scenario of draw.shuffle(SCENARIOS)) {
        const db = knowledgeTestDb();
        ensureSchema(db, T);
        const clock = { now: T + draw.int(0, 60_000) };
        const month = spendMonth(clock.now);
        if (scenario === "budget")
          saveWorkspaceSpend(db, month, { spentCents: CRYPTO_MONTHLY_BUDGET_CENTS, calls: 1, reservations: {} });
        const before = booked(db, month);
        const bytes = recording(2 * draw.int(8_000, 60_000));
        const note: CryptoVoiceNote = { bytes, clientId: uuid(draw), seconds: Math.ceil((bytes.byteLength - 44) / 32_000) };
        const principals = [`account:${uuid(draw)}`];
        const ledgerCalls: Record<string, unknown>[] = [];
        const meterCalls: Record<string, unknown>[] = [];
        const meter = new Kv();
        // The desk's knowledge object and Templ's spend meter, each with its own storage.
        const knowledge = {
          idFromName: (name: string) => name,
          get: (name: string) => ({
            fetch: async (_url: string, init: { body: string }) => {
              const body = JSON.parse(init.body) as Record<string, unknown>;
              if (name === TEMPL_SPEND_OBJECT) {
                meterCalls.push(body);
                return answer(await templSpendRequest(meter as never, body, clock.now));
              }
              ledgerCalls.push(body);
              return answer(await cryptoVoiceLedger(db, cryptoVoiceInput(body), clock.now));
            },
          }),
        };
        const spokenPhrase = PHRASE.split(" ").map((word, index) => (index ? word : "Legal")).join(", ") + ".";
        const reply =
          scenario === "untidy" ? heard(`  ${QUESTION.replace(". ", `.\n${String.fromCodePoint(0x200b)}\t`)}${String.fromCodePoint(0x202e)} `)
          : scenario === "mixed-segments" ? heard("ignored", 2.4, { segments: [
              { text: " My transfer is pending.", no_speech_prob: 0.01, avg_logprob: -0.3, compression_ratio: 1.1 },
              { text: " Thanks for watching!", no_speech_prob: 0.93, avg_logprob: -0.4, compression_ratio: 1.0 },
              { text: " la la la la la la la la", no_speech_prob: 0.1, avg_logprob: -0.5, compression_ratio: 3.4 },
              { text: " mumble", no_speech_prob: 0.2, avg_logprob: -1.7, compression_ratio: 1.0 },
              { text: " What should I check?", no_speech_prob: 0.02, avg_logprob: -0.2, compression_ratio: 1.2 },
            ] })
          : scenario === "vad-empty" ? heard("Thank you.", draw.pick([0, 0.1, 0.29]))
          : scenario === "ghost" ? heard("Thanks for watching!", 1, { segments: [{ text: "Thanks for watching!", no_speech_prob: 0.93 }] })
          : scenario === "short-speech" ? heard(draw.pick(["Thank you.", "Bye-bye.", "می‌فرستم"]))
          : scenario === "shapeless" ? draw.pick<unknown>([null, "text", [], {}, { response: QUESTION }, { text: 7 }, { text: QUESTION }])
          : scenario === "phrase" ? heard(PHRASE)
          : scenario === "spoken-phrase" ? heard(spokenPhrase)
          : scenario === "long" ? heard(Array.from({ length: 420 }, () => "confirmation").join(" "))
          : heard(QUESTION);
        const runs: unknown[][] = [];
        let release = () => {};
        const gate = scenario === "duplicate" || scenario === "swapped"
          ? new Promise<void>((resolve) => { release = resolve; })
          : Promise.resolve();
        const ai = {
          run: async (...args: unknown[]) => {
            runs.push(args);
            await gate;
            if (scenario === "throws") throw new Error(`provider failed on ${QUESTION}`);
            return reply;
          },
        } as unknown as Pick<Ai, "run">;
        const cap = scenario === "operating-cap" ? draw.pick(["0", "-5", "many", undefined]) : "50000";
        const env = {
          ...(scenario === "no-binding" ? {} : { AI: ai }),
          MANAGED_AGENT_GATEWAY_ID: "templ-support",
          ...(cap === undefined ? {} : { MANAGED_AGENT_SPEND_CAP_USD_CENTS: cap }),
          ...(scenario === "no-ledger" ? {} : { SUPPORT_KNOWLEDGE: knowledge as never }),
          ...(scenario === "no-note" ? {} : { [CRYPTO_VOICE_NOTE]: note }),
        };
        const digest = hex(draw, 64);
        const admission = (ids = principals) =>
          scenario === "refused-room"
            ? answer({ error: "Support action not found." }, 404)
            : answer({ admitted: true, principals: ids, network: digest });
        const outcome = async (pending: Promise<Response>) => {
          try {
            const response = await pending;
            return { status: response.status, body: (await response.json()) as Record<string, unknown>, retry: response.headers.get("Retry-After") };
          } catch (error) {
            const refused = error as { status?: number; reason?: string; message: string };
            return { status: refused.status ?? 500, body: { error: refused.message, reason: refused.reason }, retry: null };
          }
        };
        const label = JSON.stringify({ scenario, seconds: note.seconds });

        if (scenario === "duplicate" || scenario === "swapped") {
          // The same id twice at once, or once more from another account.
          const first = outcome(transcribeCryptoVoiceNote(env, admission()));
          const second = outcome(transcribeCryptoVoiceNote(env, admission(scenario === "swapped" ? [`account:${uuid(draw)}`] : principals)));
          await vi.waitFor(() => expect(ledgerCalls.filter((body) => body.op === "reserve")).toHaveLength(2));
          release();
          const results = [await first, await second].sort((a, b) => a.status - b.status);
          expect(results.map((result) => result.status), label).toEqual([200, 409]);
          expect(results[0].body, label).toEqual({ text: QUESTION });
          expect(results[1].body.reason, label).toBe("voice-note-in-progress");
          expect(Number(results[1].retry), label).toBeGreaterThan(0);
          const again = await outcome(transcribeCryptoVoiceNote(env, admission()));
          expect(again, label).toMatchObject({ status: 409, body: { reason: "voice-note-used" } });
          expect(runs, label).toHaveLength(1);
          expect(booked(db, month) - before, label).toBe(1);
          expect(meter.booked(), label).toBe(1);
          db.raw.close();
          continue;
        }

        const result = await outcome(transcribeCryptoVoiceNote(env, admission()));
        const called = !["refused-room", "no-ledger", "no-binding", "no-note", "budget", "operating-cap"].includes(scenario);
        expect(runs, label).toHaveLength(called ? 1 : 0);
        // Every model call is booked once in the desk's month and once under
        // Templ's operating cap, whatever it answered; nothing else is.
        expect(booked(db, month) - before, label).toBe(called ? 1 : 0);
        expect(meter.booked(), label).toBe(called ? 1 : 0);
        expect(Object.keys(spendRow(db, month)?.reservations ?? {}), label).toEqual([]);
        expect(ledgerCalls.map((body) => body.op), label).toEqual(
          called ? ["reserve", "settle"]
            : scenario === "budget" ? ["reserve"]
              : scenario === "operating-cap" ? ["reserve", "release"] : [],
        );
        expect(meterCalls.map((body) => body.op), label).toEqual(
          called ? ["reserve", "settle"] : scenario === "operating-cap" ? ["reserve"] : [],
        );
        for (const body of ledgerCalls)
          expect(body, label).toEqual({ room: DESK_ROOM, op: body.op, clientId: note.clientId, seconds: note.seconds, principals, network: digest });
        if (called) {
          const [model, input, options] = runs[0] as [string, Record<string, unknown>, { signal: AbortSignal; gateway: Record<string, unknown> }];
          expect(model, label).toBe(CRYPTO_VOICE_MODEL);
          expect(model, label).toBe("@cf/openai/whisper-large-v3-turbo");
          // The language is left to the model; nothing is translated.
          expect(Object.keys(input).sort(), label).toEqual(["audio", "condition_on_previous_text", "task", "vad_filter"]);
          expect(input, label).toMatchObject({ task: "transcribe", vad_filter: true, condition_on_previous_text: false });
          expect(Buffer.from(input.audio as string, "base64").equals(Buffer.from(bytes)), label).toBe(true);
          expect(options.gateway, label).toMatchObject({ id: "templ-support", collectLog: false, skipCache: true, retries: { maxAttempts: 1 } });
          expect(options.signal, label).toBeInstanceOf(AbortSignal);
        }
        const text = JSON.stringify(result.body);
        if (scenario === "spoken" || scenario === "untidy") {
          expect(result, label).toMatchObject({ status: 200, body: { text: QUESTION } });
          expect(Object.keys(result.body), label).toEqual(["text"]);
        } else if (scenario === "short-speech") {
          expect(result, label).toMatchObject({ status: 200, body: { text: (reply as { text: string }).text } });
        } else if (scenario === "mixed-segments")
          expect(result, label).toMatchObject({ status: 200, body: { text: "My transfer is pending. What should I check?" } });
        else if (scenario === "vad-empty" || scenario === "ghost")
          expect(result, label).toMatchObject({ status: 422, body: { reason: "voice-note-silent" } });
        else if (scenario === "shapeless" || scenario === "throws" || scenario === "no-ledger")
          expect(result, label).toMatchObject({ status: 503, body: { reason: "voice-note-unavailable" } });
        else if (scenario === "phrase" || scenario === "spoken-phrase") {
          expect(result, label).toMatchObject({ status: 422, body: { reason: "secret-refused" } });
          expect(/sausage|yellow/i.test(text), label).toBe(false);
        } else if (scenario === "long")
          expect(result, label).toMatchObject({ status: 422, body: { reason: "voice-note-too-long" } });
        else if (scenario === "budget" || scenario === "operating-cap")
          expect(result, label).toMatchObject({ status: 503, body: { reason: "voice-note-budget" } });
        else expect(result.status, label).toBe(404);
        if (result.status !== 200) expect("text" in result.body, label).toBe(false);
        // The ledger keeps no word of the note.
        for (const row of voiceRows(db))
          expect(/transfer|pending|sausage|confirmation/i.test(row.key + row.value), label).toBe(false);
        db.raw.close();
      }
      // A failure logs its fixed name: no words, audio or account.
      expect(logged.mock.calls).toContainEqual(["TEMPL_CRYPTO_VOICE_FAILURE"]);
      for (const args of [...logged.mock.calls, ...printed.mock.calls])
        expect(/transfer|pending|sausage|yellow|confirmation|UklGR|account:/i.test(JSON.stringify(args))).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      logged.mockRestore();
      printed.mockRestore();
    }
  }, { timeout: 120_000 });
});
