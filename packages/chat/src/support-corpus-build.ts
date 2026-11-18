/** Builds one `templ-corpus/1` row from a finished request, inside the
 * workspace's room object. Server-only: it loads the recovery-phrase word
 * list (support-safety.ts).
 *
 * Order, for every text the row keeps:
 * 1. A recovery phrase (one misspelled word allowed), key bytes or an
 *    extended private key anywhere in the request withholds all its text;
 *    the row keeps metadata only.
 * 2. The eval rules (`deidentifyText`, one placeholder map per request):
 *    links, emails, ENS and SNS names, hashes and signatures, addresses,
 *    handles, phones, IPs, dates, times, block numbers, known display names,
 *    rounded amounts.
 * 3. The strict pass: numbers of five or more digits become `<NUM>`; long
 *    ids the eval rules only flag (unrecognised base58 runs, short hex
 *    values, long letter-and-digit tokens) become `<ID>`.
 * 4. Names found by cue ("my name is X", "I'm X", "this is X from",
 *    "call me X", greetings and sign-offs) become `<NAME>`. Regexes can't
 *    find every name; the rules replace the names they find.
 * 5. The gate: a text that still holds anything steps 2-4 would replace is
 *    dropped (a turn keeps its role with no text). More than
 *    `CORPUS_LIMITS.droppedTurnsMax` dropped turns withholds all the text.
 * 6. The fit: a row over `CORPUS_LIMITS.rowBytes` shortens its longest turn
 *    texts at a word boundary; a row that still doesn't fit keeps no text.
 *
 * Nothing here reads notes, files, member or staff ids, the wallet, the
 * website or IP data: the caller passes message texts with the writers'
 * pseudonyms, the case metadata, the frame and evidence, and the team's
 * labels. */
import { base58Decode } from "./solana";
import { CORPUS_LIMITS } from "./plans";
import type { SupportCase } from "./support";
import {
  CORPUS_PLACEHOLDER,
  CORPUS_RULES,
  CORPUS_SCHEMA,
  corpusNetwork,
  corpusRowBytes,
  durationBucket,
  isoWeek,
  shadowLabel,
  type CorpusAccess,
  type CorpusCase,
  type CorpusTurn,
} from "./support-corpus";
import {
  EVAL_LIMITS,
  caseCleaner,
  deidentifyCaseParts,
  residualIdentifiers,
  type DeidOptions,
  type EvalEvidence,
  type EvalFrame,
} from "./support-eval";
import type { SupportCaseFrame, SupportEvidence } from "./support-evidence";
import type { ReplyLabel } from "./support-quality";
import { findRecoveryPhrases, redactForModel, hideAmbiguousHex } from "./support-safety";

const B58 = "1-9A-HJ-NP-Za-km-z";
const LONG_NUMBER = /(?<![\w.,])\d{5,}(?!\w)/g;
const BASE58_RUN = new RegExp(`(?<![0-9A-Za-z<_])[${B58}]{32,88}(?![0-9A-Za-z>])`, "g");
const HEX_ID = /(?<![0-9A-Za-z<_])0x[0-9a-fA-F]{8,}(?![0-9A-Za-z>])/g;
/** A long token mixing letters and digits: an order id, API key or
 * session id. */
const MIXED_TOKEN = /(?<![\w<-])(?=[\w-]{20,}(?![\w>-]))(?=(?:[\w-]*\d){2})(?=(?:[\w-]*[A-Za-z]){2})[\w-]{20,}(?![\w>-])/g;
const HEX_64 = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
const BASE58_64 = new RegExp(`(?<![0-9A-Za-z])[${B58}]{86,88}(?![0-9A-Za-z])`, "g");

const decodes = (value: string) => {
  try {
    return base58Decode(value).length;
  } catch {
    return 0;
  }
};

/* Names by cue ------------------------------------------------------------ */

/** A cue phrase, case-insensitive, as a pattern. */
const cue = (phrase: string) =>
  phrase.replace(/[a-z]/g, (ch) => `[${ch}${ch.toUpperCase()}]`).replace(/ /g, "\\s+");
const NAME = "\\p{Lu}[\\p{Ll}'’-]{1,30}(?:[ \\t]+\\p{Lu}[\\p{Ll}'’-]{1,30})?";
/** Capitalised words that follow a cue and are not names. */
const NOT_NAMES = new Set(
  (
    "I A An The This That It Is In On At From To My Your You We They He She Not " +
    "Just Still Also So Very Really Here There All Everyone Everybody Team Guys " +
    "Folks Support Admin Admins Mod Mods Devs Staff Help Please Thanks Thank Sorry " +
    "Sure Ok Okay Good Fine New Back Again Anon Ser Fren Frens Gm Mate Bro Sir " +
    "Madam Unable Stuck Confused Worried Trying Using Having Getting Looking " +
    "Wondering Waiting Asking Writing Contacting Reaching Following Checking"
  ).split(" "),
);
const notName = (value: string) => {
  const first = value.split(/\s+/)[0];
  return NOT_NAMES.has(first) || /(?:ing|ed)$/.test(first);
};
/** Each cue captures what comes before the name, then the name. */
const NAME_CUES: RegExp[] = [
  new RegExp(
    `(\\b(?:${["my name is", "my name's", "name's", "call me", "i am", "i'm", "i’m"].map(cue).join("|")})\\s+)(${NAME})`,
    "gu",
  ),
  new RegExp(`(\\b${cue("this is")}\\s+)(${NAME})(?=\\s+(?:${["from", "here", "at", "with"].map(cue).join("|")})\\b)`, "gu"),
  new RegExp(
    `((?:^|\\n)[ \\t]*(?:${["hi", "hello", "hey", "dear", "gm", "yo", "thanks", "thank you"].map(cue).join("|")})[ \\t]*,?[ \\t]+)(${NAME})(?=[ \\t]*[,!.:\\n]|$)`,
    "gu",
  ),
  new RegExp(
    `((?:${["thanks", "thank you", "thx", "regards", "best regards", "kind regards", "best", "cheers", "sincerely"].map(cue).join("|")})[ \\t]*[,!.–—-]?[ \\t]*\\n?[ \\t]*)(${NAME})([ \\t]*[.!]?[ \\t]*)$`,
    "gu",
  ),
  new RegExp(`(\\n[ \\t]*[-–—][ \\t]*)(${NAME})([ \\t]*)$`, "gu"),
];

/** Replaces names found by cue with `<NAME>`. */
export function replaceCuedNames(text: string): string {
  let out = text;
  for (const pattern of NAME_CUES)
    out = out.replace(pattern, (whole: string, before: string, name: string, after: unknown) =>
      notName(name)
        ? whole
        : `${before}${CORPUS_PLACEHOLDER.name}${typeof after === "string" ? after : ""}`,
    );
  return out;
}

/** The strict pass after the eval rules: long numbers and ids. */
export function strictPass(text: string): string {
  return text
    .replace(LONG_NUMBER, CORPUS_PLACEHOLDER.number)
    .replace(BASE58_RUN, (run) =>
      // Accounts and signatures were replaced by the eval rules unless kept.
      decodes(run) === 32 ? run : CORPUS_PLACEHOLDER.id,
    )
    .replace(HEX_ID, (value) => (/^0x[0-9a-fA-F]{40}$/.test(value) ? value : CORPUS_PLACEHOLDER.id))
    .replace(MIXED_TOKEN, (token) =>
      // A kept EVM address or Solana account stays.
      /^0x[0-9a-fA-F]{40}$/.test(token) || decodes(token) === 32
        ? token
        : CORPUS_PLACEHOLDER.id,
    );
}

export const CORPUS_RESIDUAL_KINDS = ["number", "id", "name"] as const;
/** Everything the eval rules, the strict pass or the name cues would still
 * replace. Empty for a text the gate accepts. */
export function corpusResiduals(
  text: string,
  options: Pick<DeidOptions, "keepAddresses" | "keepHosts">,
): string[] {
  const found = new Set<string>(residualIdentifiers(text, options));
  if ((text.match(LONG_NUMBER) ?? []).length) found.add("number");
  const numbered = text.replace(LONG_NUMBER, CORPUS_PLACEHOLDER.number);
  if (strictPass(numbered) !== numbered) found.add("id");
  if (replaceCuedNames(text) !== text) found.add("name");
  return [...found].sort();
}

/** Words that name a key right before its value. */
const KEY_CUE = /(?:\b(?:private|secret|priv)[\s_-]*key|\bpk|\bseed|\bkey\s*pair|\bkeypair)\b[^0-9A-Za-z]{0,12}(?:is|was|=|:)?[^0-9A-Za-z]{0,6}$/i;
/** A 64-hex or 64-byte base58 value right after a key cue ("my private
 * key is 0x…"): a key, not a hash or signature. */
const cuedKey = (text: string) =>
  [...text.matchAll(HEX_64), ...text.matchAll(BASE58_64)].some((match) =>
    KEY_CUE.test(text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0)),
  );

/** Recovery phrases and key material, found without tripping on a
 * transaction hash or signature (those are replaced as `<TX_n>`). A hash-
 * shaped value named as a key counts as key material. */
export function holdsSecret(text: string): boolean {
  if (findRecoveryPhrases(text, { misses: 1 }).length) return true;
  if (cuedKey(text)) return true;
  const shared = {
    evmHashes: text.match(HEX_64) ?? [],
    solanaSignatures: text.match(BASE58_64) ?? [],
  };
  return redactForModel(text, shared).found.length > 0;
}

/* The row ----------------------------------------------------------------- */

export type CorpusSource = {
  /** `ws_` and 16 hex. */
  workspace: string;
  case: SupportCase;
  state: CorpusCase["state"];
  /** The request's member, person and agent messages, oldest first, with
   * their current text and the writer's pseudonym. Never notes. */
  turns: { role: CorpusTurn["role"]; speaker: string; text: string }[];
  frame: SupportCaseFrame | null;
  /** Current rows only (not withdrawn or replaced). */
  evidence: readonly SupportEvidence[];
  category: string | null;
  tags: readonly string[];
  labels: readonly ReplyLabel[];
  diagnosisRules: readonly string[];
  /** Addresses and hosts that stay, known names, token symbols. */
  options: Omit<DeidOptions, "baseDate">;
  /** The member wrote the request's last message. */
  memberLast: boolean;
};

const ACCESS: Record<string, CorpusAccess> = {
  anonymous: "guest",
  connected: "connected",
  signed: "signed-in",
  app: "app",
};
const role = (closer: SupportCase["resolvedBy"]): CorpusCase["resolvedBy"] =>
  closer === "bot" ? "agent" : closer;

export type CorpusBuild = { row: CorpusCase; residualKinds: string[] };

/** The row for one finished request. Pure: the same source builds the same
 * row. */
export function buildCorpusCase(source: CorpusSource): CorpusBuild {
  const c = source.case;
  const keep = { keepAddresses: source.options.keepAddresses, keepHosts: source.options.keepHosts };
  const all = [
    ...source.turns.map((turn) => turn.text),
    source.frame?.reported?.value ?? "",
    source.frame?.question?.text ?? "",
    ...source.evidence.map((row) => `${row.value.text} ${row.note ?? ""}`),
    ...source.tags,
    source.category ?? "",
  ];
  const secret = all.some(holdsSecret);
  const cleaner = caseCleaner({
    ...source.options,
    baseDate: new Date(c.openedAt).toISOString().slice(0, 10),
  });
  const dropped = new Set<string>();
  /** The text through every step, or null when the gate refuses it. */
  const finish = (text: string): string | null => {
    const out = replaceCuedNames(strictPass(cleaner.clean(hideAmbiguousHex(text))));
    const left = corpusResiduals(out, keep);
    if (!left.length) return out;
    for (const kind of left) dropped.add(kind);
    return null;
  };
  let turns: CorpusTurn[] = source.turns
    .slice(0, CORPUS_LIMITS.turns)
    .map((turn) => ({
      role: turn.role,
      speaker: turn.speaker,
      text: secret ? null : (finish(turn.text)?.slice(0, EVAL_LIMITS.turnChars) ?? null),
    }));
  const turnsDropped = secret ? 0 : turns.filter((turn) => turn.text === null).length;
  const textWithheld = secret || turnsDropped > CORPUS_LIMITS.droppedTurnsMax;
  if (textWithheld) turns = turns.map((turn) => ({ ...turn, text: null }));
  let frame: EvalFrame | null = null;
  let evidence: EvalEvidence[] = [];
  let tags: string[] = [];
  let category: string | null = null;
  if (!textWithheld) {
    const parts = deidentifyCaseParts(
      { frame: source.frame, evidence: source.evidence },
      cleaner,
    );
    const field = (value: string | null) => (value === null ? null : finish(value));
    if (parts.frame) {
      const f = parts.frame;
      const product = f.product
        ? { ...f.product, label: field(f.product.label), address: f.product.address ? field(f.product.address) : null }
        : null;
      const window = f.window
        ? { ...f.window, label: field(f.window.label) }
        : null;
      const reported = f.reported ? field(f.reported.value) : null;
      frame = {
        product,
        metric: f.metric ? { ...f.metric, label: field(f.metric.label) } : null,
        window,
        reported: f.reported && reported !== null ? { value: reported, where: f.reported.where } : null,
      };
    }
    evidence = parts.evidence.flatMap((row) => {
      const label = finish(row.label);
      const value = finish(row.value);
      return label === null || value === null ? [] : [{ ...row, label, value }];
    });
    tags = source.tags.flatMap((tag) => {
      const out = finish(tag);
      return out === null || !out.trim() ? [] : [out.slice(0, 60)];
    }).slice(0, EVAL_LIMITS.tags);
    category = source.category ? finish(source.category)?.slice(0, 60) || null : null;
  }
  const networks = new Set<string>();
  const network = source.frame?.network?.value ?? source.frame?.product?.network;
  if (network) networks.add(corpusNetwork(network));
  for (const row of source.evidence)
    if (row.product.network) networks.add(corpusNetwork(row.product.network));
  const handoff = c.handoffReason
    ? { reason: c.handoffReason, by: c.handoffBy ?? null }
    : null;
  const row: CorpusCase = {
    schema: CORPUS_SCHEMA,
    rules: CORPUS_RULES,
    workspace: source.workspace,
    opened: isoWeek(c.openedAt),
    durations: {
      firstReply: durationBucket(c.firstReplyAt === null ? null : c.firstReplyAt - c.openedAt),
      firstHumanReply: durationBucket(
        c.firstHumanReplyAt === null ? null : c.firstHumanReplyAt - c.openedAt,
      ),
      resolve: durationBucket(c.resolvedAt === null ? null : c.resolvedAt - c.openedAt),
    },
    networks: [...networks].sort().slice(0, 8),
    access: { first: ACCESS[c.access] ?? "guest", close: ACCESS[c.verification] ?? "guest" },
    state: source.state,
    reopens: c.reopens,
    resolvedBy: source.state === "resolved" ? role(c.resolvedBy) : null,
    confirmation: c.confirmation,
    handoff,
    aiMode: c.ai?.mode ?? null,
    category,
    tags,
    labels: [...new Set(source.labels)].slice(0, 16),
    diagnosisRules: [...new Set(source.diagnosisRules)].slice(0, 16),
    counts: {
      memberMessages: c.counts.memberMessages,
      humanReplies: c.counts.humanReplies,
      agentReplies: c.counts.botReplies,
      notes: c.counts.notes,
    },
    turns,
    frame,
    evidence,
    shadow: shadowLabel({
      state: source.state,
      confirmation: c.confirmation,
      resolvedBy: role(c.resolvedBy),
      reopens: c.reopens,
      memberLast: source.memberLast,
      teamReplies: c.counts.humanReplies + c.counts.botReplies,
    }),
    flags: {
      secretWithheld: secret,
      turnsDropped,
      droppedKinds: [...dropped].sort().slice(0, 16),
      turnsCut: 0,
      textWithheld,
    },
  };
  return { row: fitted(row), residualKinds: [...dropped].sort() };
}

/** Turn texts are not shortened below this many characters. */
const CUT_FLOOR = 200;
/** The text up to about half its length, ending at a word boundary. */
function shortened(text: string) {
  const half = text.slice(0, Math.max(CUT_FLOOR, Math.floor(text.length / 2)));
  const space = half.search(/\s\S*$/);
  return `${space > CUT_FLOOR / 2 ? half.slice(0, space) : half}…`;
}
/** The row within `CORPUS_LIMITS.rowBytes`: the longest turn texts are
 * shortened first, and a row that still doesn't fit keeps no text. */
function fitted(row: CorpusCase): CorpusCase {
  if (corpusRowBytes(row) <= CORPUS_LIMITS.rowBytes) return row;
  const turns = row.turns.map((turn) => ({ ...turn }));
  const cut = new Set<number>();
  const next = () => ({ ...row, turns, flags: { ...row.flags, turnsCut: cut.size } });
  while (corpusRowBytes(next()) > CORPUS_LIMITS.rowBytes) {
    let longest = -1;
    turns.forEach((turn, index) => {
      if ((turn.text?.length ?? 0) > CUT_FLOOR + 1 && (longest < 0 || turn.text!.length > turns[longest].text!.length))
        longest = index;
    });
    if (longest < 0)
      return {
        ...row,
        category: null,
        tags: [],
        turns: row.turns.map((turn) => ({ ...turn, text: null })),
        frame: null,
        evidence: [],
        flags: { ...row.flags, turnsCut: 0, textWithheld: true },
      };
    turns[longest].text = shortened(turns[longest].text!);
    cut.add(longest);
  }
  return next();
}
