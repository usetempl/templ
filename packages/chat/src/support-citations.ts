/** Citation markers in a registered AI agent's reply, such as [ev:3] or [ev:3,5]. The worker strips well-formed markers before it stores the reply; person replies, member messages and notes are never parsed.
 *
 * `checkCitations` finds the figures a reply states (amounts, percentages,
 * prices, anything with a decimal point or four or more digits) and checks
 * that each one cites an evidence row of the case right after it, that the
 * rows it cites exist and still stand, and that a reply mixing products,
 * metrics or time windows names each one. It never reads a chain and never
 * changes a reply's meaning: it only reports problems and advice.
 *
 * Pure functions with no imports, so the agent client inlines them and the
 * shared test vectors (`test-vectors/citations.json`) hold every client to
 * the same answers. */

/** Marker kinds: `ev` cites evidence rows of the case, as [ev:3]; `dx`
 * cites a stored transaction check of the thread, as [dx:dx-0123456789abcdef].
 * A check states facts; a reply that cites one restates them. */
export const SUPPORT_CITATION_KINDS = ["ev", "dx"] as const;
export type SupportCitationKind = (typeof SUPPORT_CITATION_KINDS)[number];

export const SUPPORT_CITATION_LIMITS = {
  /** Markers in one reply; more is the problem `too-many-citations`. */
  markers: 40,
  /** Ids in one marker. */
  idsPerMarker: 8,
} as const;

type Tag = { key: string; label?: string };
/** What the check reads of each evidence row of the case. */
export type CitationRow = {
  n: number;
  product: Tag;
  metric: Tag;
  window: Tag;
  value: { text: string; number?: string; unit?: string };
  withdrawn: boolean;
  supersededBy: number | null;
};
export type CitationDimension = "product" | "metric" | "window";
export type CitationProblem =
  | { kind: "uncited-figure"; figure: string; sentence: number }
  | { kind: "unknown-evidence"; evidence: number }
  | { kind: "withdrawn-evidence"; evidence: number }
  | { kind: "superseded-evidence"; evidence: number; by: number }
  | {
      kind: "unlabeled-mix";
      sentence: number;
      dimension: CitationDimension;
      evidence: number[];
    }
  | {
      kind: "unlabeled-comparison";
      dimension: "product" | "window";
      evidence: number[];
    }
  | { kind: "too-many-citations" }
  | { kind: "no-case" }
  | { kind: "evidence-unreadable" }
  /** A [dx:<id>] marker names no stored check of this thread. */
  | { kind: "unknown-diagnosis"; diagnosis: string }
  /** A figure cites checks, and none of them states it. */
  | {
      kind: "diagnosis-figure-not-in-check";
      figure: string;
      sentence: number;
      diagnoses: string[];
    };
export type CitationProblemKind = CitationProblem["kind"];
export const CITATION_PROBLEM_KINDS: readonly CitationProblemKind[] = [
  "uncited-figure",
  "unknown-evidence",
  "withdrawn-evidence",
  "superseded-evidence",
  "unlabeled-mix",
  "unlabeled-comparison",
  "too-many-citations",
  "no-case",
  "evidence-unreadable",
  "unknown-diagnosis",
  "diagnosis-figure-not-in-check",
];
/** Never holds a reply; shown to the team. */
export type CitationAdvice = {
  kind: "value-mismatch";
  figure: string;
  evidence: number;
  value: string;
};
/** One marker: the 1-based sentence it sits in and the rows it names. */
export type Citation = { sentence: number; evidence: number[] };
/** A stored check a [dx:…] marker may cite: its id and the numbers it
 * states (the numbers of its claim set). */
export type CitableDiagnosis = { id: string; numbers: readonly string[] };
/** One [dx:…] marker: the sentence it sits in and the checks it names. */
export type DiagnosisCitation = { sentence: number; diagnoses: string[] };
export type CitationCheck = {
  /** No problems. */
  ok: boolean;
  /** The reply with markers removed. */
  text: string;
  citations: Citation[];
  /** [dx:…] markers; absent when the reply has none. */
  diagnosisCitations?: DiagnosisCitation[];
  figures: number;
  problems: CitationProblem[];
  advice: CitationAdvice[];
};
type Marker = { at: number; ids: number[]; dx?: string[] };

const MARKER =
  /[ \t]?\[(?:ev:(\d{1,4}(?:,\d{1,4}){0,7})|dx:(dx-[0-9a-f]{16}(?:,dx-[0-9a-f]{16}){0,7}))\]/g;

/** Removes every well-formed marker (and one space or tab before it) and
 * records where each was, as an offset in the returned text. A malformed
 * marker such as [ev:x] stays as text. */
export function stripCitationMarkers(text: string): {
  text: string;
  markers: Marker[];
} {
  const markers: Marker[] = [];
  let out = "";
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const start = match.index!;
    // A marker at the start of a line keeps the line's own text intact.
    const lead = match[0].startsWith("[") ? "" : match[0][0];
    const leadIsLineStart =
      lead !== "" && (start === 0 || text[start - 1] === "\n");
    out += text.slice(last, start) + (leadIsLineStart ? lead : "");
    markers.push(
      match[1] !== undefined
        ? { at: out.length, ids: match[1].split(",").map(Number) }
        : { at: out.length, ids: [], dx: [...new Set(match[2].split(","))] },
    );
    last = start + match[0].length;
  }
  out += text.slice(last);
  return { text: out, markers };
}
/** The reply has at least one well-formed marker. */
export function hasCitationMarkers(text: string): boolean {
  MARKER.lastIndex = 0;
  const found = MARKER.test(text);
  MARKER.lastIndex = 0;
  return found;
}

/* Figures                                                                 */

/** Spans that look like numbers but are not figures, masked in this order. */
const MASKS: RegExp[] = [
  /https?:\/\/[^\s<>()[\]]+/g,
  /0x[0-9a-fA-F]+/g,
  /(?:…|\.\.\.)[0-9a-fA-F]{2,}\b/g,
  /eip155:\d+/g,
  /[1-9A-HJ-NP-Za-km-z]{26,}/g,
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /\b(?:ERC|EIP|BIP|CAIP|SLIP)-?\d+\b/gi,
  /\bv?\d+(?:\.\d+){2,}\b/g,
  /^[ \t]*\d{1,2}[.)](?=\s)/gm,
  /(?<![\d.,$€£])(?:19|20)\d{2}(?![\d.,%])(?!\s?(?:bps\b|[kKmMbB]\b|[a-z]{0,3}[A-Z]))/g,
];
const CANDIDATE =
  /(?<![A-Za-z0-9_.])(?:[$€£]\s?)?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?(?:%|bps\b|[kKmMbB](?![A-Za-z])|x(?![A-Za-z])))?/g;
const TICKER = /^\s?[a-z]{0,3}[A-Z][A-Za-z0-9]{1,11}\b/;

function mask(text: string): string {
  let masked = text;
  for (const pattern of MASKS)
    masked = masked.replace(pattern, (found) => " ".repeat(found.length));
  return masked;
}
type Figure = { start: number; end: number; text: string };
/** The figures a text states, in order. */
export function findFigures(text: string): Figure[] {
  const masked = mask(text);
  const figures: Figure[] = [];
  for (const match of masked.matchAll(CANDIDATE)) {
    const found = match[0];
    const start = match.index!;
    const end = start + found.length;
    const digits = found.replace(/[^\d]/g, "");
    const integer = found.replace(/^[$€£]\s?/, "").split(".")[0];
    const figure =
      /^[$€£]/.test(found) ||
      /(%|bps|[kKmMbB]|x)$/.test(found) ||
      found.includes(".") ||
      found.includes(",") ||
      integer.replace(/,/g, "").length >= 4 ||
      digits.length >= 4 ||
      TICKER.test(masked.slice(end));
    if (figure) figures.push({ start, end, text: found });
  }
  return figures;
}

/* Sentences                                                               */

type Sentence = { start: number; end: number; text: string };
/** Sentences split at whitespace after . ! ? and at line breaks. */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const breaks = /(?<=[.!?])\s+|\n+/g;
  let start = 0;
  for (const match of text.matchAll(breaks)) {
    out.push({
      start,
      end: match.index!,
      text: text.slice(start, match.index!),
    });
    start = match.index! + match[0].length;
  }
  out.push({ start, end: text.length, text: text.slice(start) });
  return out;
}
/** The index of the sentence a position falls in. A position in a gap
 * between sentences belongs to the one before it. */
function sentenceAt(list: Sentence[], at: number): number {
  for (let index = list.length - 1; index >= 0; index--)
    if (at >= list[index].start) {
      // A marker left alone in an empty sentence cites the one before it.
      if (!list[index].text.trim() && index > 0) return index - 1;
      return index;
    }
  return 0;
}

/* The check                                                               */

const label = (tag: Tag) => tag.label ?? tag.key;
const names = (sentence: string, tag: Tag) => {
  const text = label(tag);
  return (
    text.length >= 2 && sentence.toLowerCase().includes(text.toLowerCase())
  );
};
type UnitClass = "percent" | "bps" | "currency" | "k" | "m" | "b" | "plain";
function parseAmount(
  text: string,
): { value: number; unit: UnitClass; step: number } | null {
  const match =
    /([$€£])?\s?(-?\d(?:[\d,]*\d)?(?:\.(\d+))?)\s?(%|bps|[kKmMbB](?![A-Za-z]))?/.exec(
      text,
    );
  if (!match) return null;
  const value = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const suffix = match[4]?.toLowerCase();
  const unit: UnitClass = match[1]
    ? "currency"
    : suffix === "%"
      ? "percent"
      : suffix === "bps"
        ? "bps"
        : suffix === "k" || suffix === "m" || suffix === "b"
          ? suffix
          : "plain";
  return { value, unit, step: 10 ** -(match[3]?.length ?? 0) };
}
/** Advice only: the figure and the row's value have the same kind of unit
 * and differ by more than half a unit in the figure's last shown place. */
function mismatch(figure: string, row: CitationRow): boolean {
  const said = parseAmount(figure);
  const stored = parseAmount(
    row.value.number !== undefined
      ? `${row.value.number}${row.value.unit === "%" ? "%" : ""}`
      : row.value.text,
  );
  if (!said || !stored || said.unit !== stored.unit) return false;
  return Math.abs(said.value - stored.value) > said.step / 2 + 1e-12;
}
const SCALE: Partial<Record<UnitClass, number>> = { k: 1e3, m: 1e6, b: 1e9 };
/** A check states the figure: one of its numbers equals it within half a
 * unit in the figure's last shown place (so 1.25k states 1,250). */
function statedBy(figure: string, numbers: readonly string[]): boolean {
  const said = parseAmount(figure);
  if (!said) return false;
  const scale = SCALE[said.unit] ?? 1;
  const value = said.value * scale;
  const tolerance = (said.step * scale) / 2 + 1e-9;
  return numbers.some((number) => {
    const stored = Number(number.replace(/,/g, ""));
    return (
      /^\d/.test(number) &&
      Number.isFinite(stored) &&
      Math.abs(stored - value) <= tolerance
    );
  });
}

/** Checks a registered AI agent's reply against the evidence rows of the
 * case it answers. `rows` null means the reply answers no case.
 * `diagnoses` lists the checks a [dx:…] marker may name in this thread,
 * with the numbers each states; without it every dx marker is unknown. A
 * figure that cites checks must be one of their numbers. */
export function checkCitations(
  text: string,
  rows: readonly CitationRow[] | null,
  diagnoses?: readonly CitableDiagnosis[] | null,
): CitationCheck {
  const stripped = stripCitationMarkers(text);
  const body = stripped.text;
  const list = sentences(body);
  const figures = findFigures(body);
  const problems: CitationProblem[] = [];
  const advice: CitationAdvice[] = [];
  const evMarkers = stripped.markers.filter((marker) => !marker.dx);
  const citations: Citation[] = evMarkers.map((marker) => ({
    sentence: sentenceAt(list, marker.at) + 1,
    evidence: [...new Set(marker.ids)],
  }));
  const dxMarkers = stripped.markers.filter((marker) => marker.dx);
  const diagnosisCitations: DiagnosisCitation[] = dxMarkers.map((marker) => ({
    sentence: sentenceAt(list, marker.at) + 1,
    diagnoses: marker.dx!,
  }));
  const withDx = diagnosisCitations.length ? { diagnosisCitations } : {};
  if (!stripped.markers.length && !figures.length)
    return {
      ok: true,
      text: body,
      citations,
      ...withDx,
      figures: 0,
      problems,
      advice,
    };
  if (stripped.markers.length > SUPPORT_CITATION_LIMITS.markers)
    problems.push({ kind: "too-many-citations" });
  // A reply that cites only transaction checks may answer no case.
  if (rows === null && (evMarkers.length > 0 || dxMarkers.length === 0))
    problems.push({ kind: "no-case" });
  const known = new Map((diagnoses ?? []).map((item) => [item.id, item]));
  const seenDx = new Set<string>();
  for (const marker of dxMarkers)
    for (const id of marker.dx!) {
      if (seenDx.has(id)) continue;
      seenDx.add(id);
      if (!known.has(id))
        problems.push({ kind: "unknown-diagnosis", diagnosis: id });
    }
  const byN = new Map((rows ?? []).map((row) => [row.n, row]));
  // Each id once, in the order first cited.
  const seen = new Set<number>();
  for (const citation of citations)
    for (const n of citation.evidence) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (rows === null) continue;
      const row = byN.get(n);
      if (!row) problems.push({ kind: "unknown-evidence", evidence: n });
      else if (row.withdrawn)
        problems.push({ kind: "withdrawn-evidence", evidence: n });
      else if (row.supersededBy !== null)
        problems.push({
          kind: "superseded-evidence",
          evidence: n,
          by: row.supersededBy,
        });
    }
  // Each figure takes the first marker at or after its end in the same
  // sentence, when no other figure starts before that marker.
  const markers = stripped.markers.map((marker) => ({
    ...marker,
    sentence: sentenceAt(list, marker.at),
  }));
  figures.forEach((figure, index) => {
    const sentence = sentenceAt(list, figure.start);
    const next = figures[index + 1];
    const marker = markers.find(
      (entry) =>
        entry.at >= figure.end &&
        entry.sentence === sentence &&
        !(
          next &&
          next.start < entry.at &&
          sentenceAt(list, next.start) === sentence
        ),
    );
    if (!marker) {
      problems.push({
        kind: "uncited-figure",
        figure: figure.text,
        sentence: sentence + 1,
      });
      return;
    }
    // A figure cited by a check restates a number the check states. An
    // unknown id is its own problem; a known one that doesn't state the
    // figure holds the reply like an uncited figure.
    if (marker.dx) {
      const cited = marker.dx
        .map((id) => known.get(id))
        .filter((item): item is CitableDiagnosis => item !== undefined);
      if (
        cited.length &&
        !cited.some((item) => statedBy(figure.text, item.numbers))
      )
        problems.push({
          kind: "diagnosis-figure-not-in-check",
          figure: figure.text,
          sentence: sentence + 1,
          diagnoses: cited.map((item) => item.id),
        });
      return;
    }
    for (const n of new Set(marker.ids)) {
      const row = byN.get(n);
      if (row && !row.withdrawn && mismatch(figure.text, row))
        advice.push({
          kind: "value-mismatch",
          figure: figure.text,
          evidence: n,
          value: row.value.text,
        });
    }
  });
  // Tags come from the cited rows, never from the wording.
  const cited = (sentence: number) =>
    [
      ...new Set(
        markers
          .filter((marker) => marker.sentence === sentence)
          .flatMap((marker) => marker.ids),
      ),
    ]
      .map((n) => byN.get(n))
      .filter((row): row is CitationRow => row !== undefined)
      .sort((a, b) => a.n - b.n);
  const mixed = new Set<string>();
  list.forEach((sentence, index) => {
    const rowsHere = cited(index);
    if (rowsHere.length < 2) return;
    for (const dimension of ["product", "metric", "window"] as const) {
      const keys = new Set(rowsHere.map((row) => row[dimension].key));
      if (keys.size < 2) continue;
      if (rowsHere.every((row) => names(sentence.text, row[dimension])))
        continue;
      mixed.add(`${index}:${dimension}`);
      problems.push({
        kind: "unlabeled-mix",
        sentence: index + 1,
        dimension,
        evidence: rowsHere.map((row) => row.n),
      });
    }
  });
  // Across the reply: two rows of one metric over different windows, or of
  // one metric and window for different products, are each named wherever
  // they are cited.
  const all = [...new Set(markers.flatMap((marker) => marker.ids))]
    .map((n) => byN.get(n))
    .filter((row): row is CitationRow => row !== undefined)
    .sort((a, b) => a.n - b.n);
  const reported = new Set<string>();
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.metric.key !== b.metric.key) continue;
      const dimension: "window" | "product" | null =
        a.window.key !== b.window.key
          ? "window"
          : a.product.key !== b.product.key
            ? "product"
            : null;
      if (!dimension) continue;
      const unlabeled = list.some((sentence, index) => {
        if (mixed.has(`${index}:${dimension}`)) return false;
        const here = cited(index);
        return [a, b].some(
          (row) =>
            here.some((entry) => entry.n === row.n) &&
            !names(sentence.text, row[dimension]),
        );
      });
      const key = `${dimension}:${a.n},${b.n}`;
      if (unlabeled && !reported.has(key)) {
        reported.add(key);
        problems.push({
          kind: "unlabeled-comparison",
          dimension,
          evidence: [a.n, b.n],
        });
      }
    }
  return {
    ok: problems.length === 0,
    text: body,
    citations,
    ...withDx,
    figures: figures.length,
    problems,
    advice,
  };
}
