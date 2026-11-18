/** Words for Templ's de-identified copies: the Settings and Plan cards, the
 * thread panel and the Activity line. A copy is de-identified, never
 * called anonymous. */
import type { CorpusPurpose } from "@templ/chat/support-corpus";

export const CORPUS_COPY = {
  title: "Templ's de-identified copies",
  description:
    "Templ keeps eligible finished cases as de-identified copies to improve support. Its rules replace wallets, hashes, contacts and names they find.",
  kept: "Copies kept",
  readLastMonth: "Read by Templ last month",
  privacy: "How Templ uses these copies",
  /** Leaving the copy out takes a custom contract; the link opens Talk to us. */
  contract: "Want a contract without this? Talk to us",
  contractLabel: "Talk to us about a contract without Templ's de-identified copies",
  panelTitle: "Templ's copy of this case",
  panelHint: "Use these when the user asks to delete their data or objects to the copy.",
  deleteLabel: "Delete for a privacy request",
  deleteConfirm: "Delete every copy of this user's cases? Templ won't copy these cases again.",
  objectLabel: "Record an objection",
  objectConfirm:
    "Delete every copy of this user's cases? Templ won't copy their cases again.",
  confirm: "Delete copies",
  cancel: "Cancel",
  error: "The copies couldn't be deleted. Try again.",
} as const;

export const CORPUS_PURPOSE_TEXT: Record<CorpusPurpose, string> = {
  "eval-build": "testing AI answers",
  "rule-calibration": "checking resolution rules",
  "resolution-audit": "reviewing a disputed charge",
  "gap-analysis": "finding knowledge gaps",
  "leak-sample": "checking for details the rules missed",
};

const count = (value: number) => new Intl.NumberFormat("en-US").format(value);
/** "September 2026" for "2026-09". */
export const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** After a deletion: how many copies went. */
export const deletedText = (deleted: number, action: "delete" | "object") =>
  `${deleted === 1 ? "1 copy" : `${count(deleted)} copies`} deleted. Templ won't copy ${action === "delete" ? "these cases" : "this user's cases"} again.`;

/** The Activity page's monthly line. */
export function readsLine(month: string, rows: number, purposes: CorpusPurpose[]) {
  if (rows === 0) return `Templ read no copies of this workspace's cases in ${monthName(month)}.`;
  const why = purposes.map((purpose) => CORPUS_PURPOSE_TEXT[purpose]);
  const list =
    why.length <= 1 ? (why[0] ?? "") : `${why.slice(0, -1).join(", ")} and ${why.at(-1)}`;
  return `Templ read ${rows === 1 ? "1 de-identified copy" : `${count(rows)} de-identified copies`} of this workspace's cases in ${monthName(month)}${list ? `, for ${list}` : ""}.`;
}
export const keptText = count;
