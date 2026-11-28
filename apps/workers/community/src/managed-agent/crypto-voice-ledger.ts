/** The crypto desk's voice-note ledger, in the desk's knowledge object beside
 * the sponsored month its answers already spend from (`managed.spend:<month>`).
 * One synchronous transaction checks the request id, the visitor's and the
 * network's rolling day, the desk's day and that shared month, then holds the
 * cost. A second call books it, or lets it go when the model was never
 * called. An id is admitted once: a retry, a copy still in flight or the same
 * id from another account never holds again.
 *
 * Rows keep day-salted digests, times and cents. They never hold audio, text,
 * an account id or a network address, and rows from before yesterday are
 * deleted on every call. All of it goes with the workspace's knowledge on
 * deletion (`purgeAll`). */
import {
  CRYPTO_MONTHLY_BUDGET_CENTS,
  CRYPTO_SUPPORT_WORKSPACE,
} from "@templ/chat/support-models";
import {
  KnowledgeError,
  readMetaJson,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "../support-knowledge-schema";
import {
  RESERVATION_MS,
  releaseSpend,
  reserveSpend,
  saveWorkspaceSpend,
  settleSpend,
  workspaceSpend,
} from "./store";

const DESK_ROOM = "room:" + CRYPTO_SUPPORT_WORKSPACE;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PREFIX = "managed.voice.";
const FAMILIES = ["id", "who", "net", "desk"] as const;
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL = /^[!-~]{1,128}$/;
/** Workers AI lists whisper-large-v3-turbo at $0.000513 per audio minute. */
const USD_NANOS_PER_AUDIO_MINUTE = 513_000;

export const CRYPTO_VOICE_LIMITS = {
  maxSeconds: 120,
  visitorPerMinute: 2,
  visitorDailyCents: 20,
  networkPerMinute: 12,
  networkDailyCents: 96,
  /** Voice notes may use this much of the shared month in one UTC day. */
  deskDailyCents: 300,
} as const;

export type CryptoVoiceRefusal =
  | "voice-note-in-progress"
  | "voice-note-used"
  | "voice-note-limit"
  | "voice-note-daily-limit"
  | "voice-note-network-limit"
  | "voice-note-budget";
export type CryptoVoiceResult =
  | { ok: true }
  | { ok: false; reason: CryptoVoiceRefusal; retryAfter?: number };
export type CryptoVoiceInput = {
  room: string;
  op: "reserve" | "settle" | "release";
  clientId: string;
  seconds: number;
  principals: string[];
  network: string | null;
};
type Entry = [at: number, cents: number];
type Window = { v: 1; at: Entry[]; held?: { id: string; until: number } };
type Attempt = {
  v: 1;
  who: string;
  at: number;
  month: string;
  cents: number;
  hold: string;
  done?: true;
};

/** Billed by the started audio minute, then up to a whole cent. */
export function cryptoVoiceCents(seconds: number): number {
  return Math.max(
    1,
    Math.ceil((Math.ceil(seconds / 60) * USD_NANOS_PER_AUDIO_MINUTE) / 10_000_000),
  );
}

/** A ledger call's body. Only the desk's own room is answered. */
export function cryptoVoiceInput(body: Record<string, unknown>): CryptoVoiceInput {
  if (body.room !== DESK_ROOM)
    throw new KnowledgeError(404, "crypto-voice", "Not found.");
  const { op, clientId, seconds, principals, network } = body;
  if (
    (op !== "reserve" && op !== "settle" && op !== "release") ||
    typeof clientId !== "string" ||
    !CLIENT_ID.test(clientId) ||
    !Number.isSafeInteger(seconds) ||
    (seconds as number) < 1 ||
    (seconds as number) > CRYPTO_VOICE_LIMITS.maxSeconds ||
    !Array.isArray(principals) ||
    !principals.length ||
    principals.length > 32 ||
    principals.some((id) => typeof id !== "string" || !PRINCIPAL.test(id)) ||
    !(
      network === null ||
      network === undefined ||
      (typeof network === "string" && /^[a-f0-9]{64}$/.test(network))
    )
  )
    throw new KnowledgeError(400, "crypto-voice", "Invalid voice note request.");
  return {
    room: DESK_ROOM,
    op,
    clientId,
    seconds: seconds as number,
    principals: [...new Set(principals as string[])],
    network: (network as string | null | undefined) ?? null,
  };
}

const pad = (period: number) => String(period).padStart(6, "0");
const key = (family: (typeof FAMILIES)[number], period: number, id?: string) =>
  `${PREFIX}${family}:${pad(period)}${id === undefined ? "" : ":" + id}`;
const digest = async (period: number, kind: string, value: string) =>
  (await sha256Hex(`${period}/voice-${kind}/${value}`)).slice(0, 32);
const wait = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** Voice rows from before yesterday go. */
export function pruneCryptoVoice(db: KnowledgeDb, now: number) {
  const keep = pad(Math.floor(now / DAY) - 1);
  for (const family of FAMILIES)
    db.sql.exec(
      "DELETE FROM meta WHERE key >= ? AND key < ?",
      `${PREFIX}${family}:`,
      `${PREFIX}${family}:${keep}`,
    );
}

function readWindow(db: KnowledgeDb, name: string): Window | null {
  const row = readMetaJson<Window>(db, name);
  if (row?.v !== 1 || !Array.isArray(row.at)) return null;
  return {
    v: 1,
    at: row.at.filter(
      (entry) =>
        Array.isArray(entry) &&
        Number.isSafeInteger(entry[0]) &&
        Number.isSafeInteger(entry[1]) &&
        entry[1] >= 0,
    ),
    ...(row.held &&
    typeof row.held.id === "string" &&
    Number.isSafeInteger(row.held.until)
      ? { held: row.held }
      : {}),
  };
}
function readAttempt(db: KnowledgeDb, name: string): Attempt | null {
  const row = readMetaJson<Attempt>(db, name);
  if (!row) return null;
  // An unreadable row still marks its id as used.
  return row.v === 1 &&
    typeof row.who === "string" &&
    Number.isSafeInteger(row.at) &&
    /^\d{4}-\d{2}$/.test(String(row.month)) &&
    Number.isSafeInteger(row.cents) &&
    row.cents >= 0 &&
    typeof row.hold === "string"
    ? row
    : { v: 1, who: "", at: 0, month: "", cents: 0, hold: "", done: true };
}

/** The last day's attempts across every row the caller's identities map to. */
function rolling(db: KnowledgeDb, names: string[], now: number) {
  const rows = names.flatMap((name) => readWindow(db, name) ?? []);
  return {
    heldUntil: Math.max(0, ...rows.map((row) => row.held?.until ?? 0)),
    recent: rows
      .flatMap((row) => row.at)
      .filter(([at]) => at > now - DAY)
      .sort((a, b) => a[0] - b[0]),
  };
}
function refusal(
  recent: Entry[],
  limit: { perMinute: number; dailyCents: number },
  cents: number,
  now: number,
  reasons: [burst: CryptoVoiceRefusal, daily: CryptoVoiceRefusal],
): CryptoVoiceResult | null {
  const nextMinute = (recent.at(-limit.perMinute)?.[0] ?? -Infinity) + MINUTE;
  if (nextMinute > now)
    return { ok: false, reason: reasons[0], retryAfter: wait(nextMinute - now) };
  let spent = recent.reduce((sum, entry) => sum + entry[1], 0);
  if (spent + cents <= limit.dailyCents) return null;
  for (const [at, held] of recent) {
    spent -= held;
    if (spent + cents <= limit.dailyCents)
      return { ok: false, reason: reasons[1], retryAfter: wait(at + DAY - now) };
  }
  return { ok: false, reason: reasons[1], retryAfter: DAY / 1000 };
}
function append(
  db: KnowledgeDb,
  name: string,
  entry: Entry,
  held?: Window["held"],
) {
  const row = readWindow(db, name);
  writeMeta(
    db,
    name,
    JSON.stringify({
      v: 1,
      at: [...(row?.at ?? []), entry],
      ...(held ? { held } : {}),
    } satisfies Window),
  );
}

/** One reserve, settle or release. A refusal writes nothing but the expiry cleanup. */
export async function cryptoVoiceLedger(
  db: KnowledgeDb,
  input: CryptoVoiceInput,
  now: number,
): Promise<CryptoVoiceResult> {
  const today = Math.floor(now / DAY);
  const periods = [today, today - 1];
  // Every identity the session acts as counts as one visitor; the first is
  // the row this attempt is written under.
  const who = new Map<number, string[]>();
  const net = new Map<number, string>();
  for (const period of periods) {
    who.set(
      period,
      await Promise.all(input.principals.map((id) => digest(period, "who", id))),
    );
    if (input.network) net.set(period, await digest(period, "net", input.network));
  }
  const cents = cryptoVoiceCents(input.seconds);
  return db.transaction((): CryptoVoiceResult => {
    pruneCryptoVoice(db, now);
    for (const period of periods) {
      const name = key("id", period, input.clientId);
      const attempt = readAttempt(db, name);
      if (!attempt) continue;
      const open = !attempt.done && now < attempt.at + RESERVATION_MS;
      if (input.op === "reserve")
        return open
          ? {
              ok: false,
              reason: "voice-note-in-progress",
              retryAfter: wait(attempt.at + RESERVATION_MS - now),
            }
          : { ok: false, reason: "voice-note-used" };
      if (!who.get(period)!.includes(attempt.who))
        return { ok: false, reason: "voice-note-used" };
      if (attempt.done) return { ok: true };
      const { record } = workspaceSpend(
        db,
        Date.parse(attempt.month + "-01T00:00:00Z"),
      );
      // A hold that outlived its window was already booked in full. A release
      // is for a model call that never started: its hold goes with nothing
      // booked and the desk's day gets the cents back.
      if (record.reservations[attempt.hold]) {
        if (input.op === "release") {
          releaseSpend(record, attempt.hold);
          const desk = readMetaJson<{ cents?: number }>(db, key("desk", period));
          writeMeta(
            db,
            key("desk", period),
            JSON.stringify({
              v: 1,
              cents: Math.max(0, (Number(desk?.cents) || 0) - attempt.cents),
            }),
          );
        } else settleSpend(record, attempt.hold, attempt.cents);
        saveWorkspaceSpend(db, attempt.month, record);
      }
      writeMeta(db, name, JSON.stringify({ ...attempt, done: true } satisfies Attempt));
      const row = readWindow(db, key("who", period, attempt.who));
      if (row?.held?.id === input.clientId)
        writeMeta(
          db,
          key("who", period, attempt.who),
          JSON.stringify({ v: 1, at: row.at } satisfies Window),
        );
      return { ok: true };
    }
    if (input.op !== "reserve") return { ok: false, reason: "voice-note-used" };

    const visitor = rolling(
      db,
      periods.flatMap((period) =>
        who.get(period)!.map((id) => key("who", period, id)),
      ),
      now,
    );
    if (visitor.heldUntil > now)
      return {
        ok: false,
        reason: "voice-note-in-progress",
        retryAfter: wait(visitor.heldUntil - now),
      };
    const refused =
      refusal(
        visitor.recent,
        {
          perMinute: CRYPTO_VOICE_LIMITS.visitorPerMinute,
          dailyCents: CRYPTO_VOICE_LIMITS.visitorDailyCents,
        },
        cents,
        now,
        ["voice-note-limit", "voice-note-daily-limit"],
      ) ??
      (input.network
        ? refusal(
            rolling(
              db,
              periods.map((period) => key("net", period, net.get(period)!)),
              now,
            ).recent,
            {
              perMinute: CRYPTO_VOICE_LIMITS.networkPerMinute,
              dailyCents: CRYPTO_VOICE_LIMITS.networkDailyCents,
            },
            cents,
            now,
            ["voice-note-network-limit", "voice-note-network-limit"],
          )
        : null);
    if (refused) return refused;
    const desk = readMetaJson<{ cents?: number }>(db, key("desk", today));
    const deskCents =
      Number.isSafeInteger(desk?.cents) && desk!.cents! >= 0 ? desk!.cents! : 0;
    const spend = workspaceSpend(db, now);
    const hold = crypto.randomUUID();
    // The same sponsored month and ceiling the desk's answers hold against.
    if (
      deskCents + cents > CRYPTO_VOICE_LIMITS.deskDailyCents ||
      !reserveSpend(spend.record, {
        id: hold,
        cents,
        cap: CRYPTO_MONTHLY_BUDGET_CENTS,
        now,
        sponsored: true,
      })
    )
      return { ok: false, reason: "voice-note-budget" };
    saveWorkspaceSpend(db, spend.month, spend.record);
    const primary = who.get(today)![0];
    append(db, key("who", today, primary), [now, cents], {
      id: input.clientId,
      until: now + RESERVATION_MS,
    });
    if (input.network) append(db, key("net", today, net.get(today)!), [now, cents]);
    writeMeta(
      db,
      key("desk", today),
      JSON.stringify({ v: 1, cents: deskCents + cents }),
    );
    writeMeta(
      db,
      key("id", today, input.clientId),
      JSON.stringify({
        v: 1,
        who: primary,
        at: now,
        month: spend.month,
        cents,
        hold,
      } satisfies Attempt),
    );
    return { ok: true };
  });
}
