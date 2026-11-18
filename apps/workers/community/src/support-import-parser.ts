import { detectStoredSecret } from "./secret-guard";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { KNOWLEDGE_LIMITS } from "@templ/chat/protocol-profile";
import {
  asksForSecret,
  screenTeamText,
} from "@templ/chat/support-safety";
import { HttpError } from "./common";

export type ImportRow = {
  row: number;
  title: string;
  body: string;
  url?: string;
  shortcut?: string;
};
type ImportKind = "knowledge" | "saved-replies";
type ImportRefusal = "secret-refused" | "unsafe-ask" | "invalid-row";
import {
  IMPORT_REASON,
  type ImportPreviewRow,
} from "@templ/chat/support-imports";
export { IMPORT_REASON, type ImportPreviewRow };

/** The complete file is parsed in memory and never kept as an upload. */
export function parseSupportImport(
  filename: unknown,
  content: unknown,
  kind: ImportKind,
): ImportRow[] {
  if (typeof filename !== "string" || typeof content !== "string")
    throw new HttpError(
      400,
      "Choose a Markdown or CSV file.",
      undefined,
      "import-file",
    );
  if (new TextEncoder().encode(content).byteLength > KNOWLEDGE_LIMITS.pageBytes)
    throw new HttpError(
      413,
      "This file is too large. Split it into smaller files.",
      undefined,
      "import-size",
    );
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let rows: ImportRow[];
  if (/\.csv$/i.test(filename)) {
    const records = parseCsv(text);
    const header =
      records.shift()?.map((field) => field.trim().toLowerCase()) ?? [];
    const optional = kind === "knowledge" ? "url" : "shortcut";
    if (
      header.length < 2 ||
      header.length > 3 ||
      header[0] !== "title" ||
      header[1] !== "body" ||
      (header.length === 3 && header[2] !== optional)
    )
      throw new HttpError(
        400,
        `Use CSV columns title,body,${optional}. The last column is optional.`,
        undefined,
        "import-columns",
      );
    rows = records.map((fields, index) => {
      if (fields.length !== header.length)
        throw new HttpError(
          400,
          "Each CSV row must match its column headings.",
          undefined,
          "import-columns",
        );
      return {
        row: index + 1,
        title: fields[0].trim(),
        body: fields[1].trim(),
        ...(fields[2]?.trim() ? { [optional]: fields[2].trim() } : {}),
      };
    });
  } else if (/\.md$/i.test(filename)) {
    const sections = [...text.matchAll(/^##[ \t]+([^\n]+)\n/gm)];
    if (kind === "saved-replies" && !sections.length)
      throw new HttpError(
        400,
        "Start each saved reply with a ## heading.",
        undefined,
        "import-headings",
      );
    rows = sections.length
      ? sections.map((match, index) => ({
          row: index + 1,
          title: match[1].trim(),
          body: text
            .slice(
              match.index! + match[0].length,
              sections[index + 1]?.index ?? text.length,
            )
            .trim(),
        }))
      : [
          {
            row: 1,
            title:
              /^#[ \t]+([^\n]+)/m.exec(text)?.[1]?.trim() ||
              filename.replace(/\.md$/i, ""),
            body: text.trim(),
          },
        ];
  } else
    throw new HttpError(
      400,
      "Choose a Markdown or CSV file.",
      undefined,
      "import-file",
    );
  const limit =
    kind === "knowledge"
      ? FEATURE_LIMITS.knowledgeImportRowsPerFile
      : FEATURE_LIMITS.savedReplyImportRowsPerFile;
  if (!rows.length || rows.length > limit)
    throw new HttpError(
      400,
      `Choose a file with 1 to ${limit} entries.`,
      undefined,
      "import-count",
    );
  return rows;
}

/** CSV quotes may contain commas, newlines and escaped double quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    endedQuote = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    endedQuote = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        endedQuote = true;
      } else cell += char;
    } else if (char === ",") endCell();
    else if (char === "\n") endRow();
    else if (char === '"' && cell === "" && !endedQuote) quoted = true;
    else if (char === '"' || endedQuote)
      throw new HttpError(
        400,
        "Check the quotes in the CSV file.",
        undefined,
        "import-csv",
      );
    else cell += char;
  }
  if (quoted)
    throw new HttpError(
      400,
      "Close the quoted field in the CSV file.",
      undefined,
      "import-csv",
    );
  if (cell || row.length || endedQuote) endRow();
  return rows;
}

export async function importRowRefusal(
  row: ImportRow,
  kind: ImportKind,
): Promise<ImportRefusal | null> {
  const values = [row.title, row.body, row.url ?? "", row.shortcut ?? ""];
  if ((await Promise.all(values.map((value) => detectStoredSecret(value)))).some(Boolean)) return "secret-refused";
  // Knowledge is reference text ("Approve USDC, then click Deposit"); AI
  // replies built from it are screened before sending. Saved replies are
  // sent as written, so they get the full team-text screen.
  if (values.some((value) => asksForSecret(value) || (kind === "saved-replies" && screenTeamText(value))))
    return "unsafe-ask";
  if (
    !row.title ||
    !row.body ||
    row.title.length >
      (kind === "knowledge" ? KNOWLEDGE_LIMITS.titleChars : 100) ||
    (kind === "saved-replies" &&
      (row.body.length > KNOWLEDGE_LIMITS.faqChars ||
        (row.shortcut && !/^\/?[a-z0-9_-]{1,40}$/i.test(row.shortcut))))
  )
    return "invalid-row";
  return null;
}

/** JSON escaping can expand a file; its decoded bytes have the page cap. */
export function supportImportBodyBytes(path: string): number {
  return /^\/conversations\/(?:knowledge|saved-replies)\/import$/.test(path)
    ? KNOWLEDGE_LIMITS.pageBytes * 6 + 2048
    : 24_000;
}
