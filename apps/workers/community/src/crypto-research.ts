import { REDACTION_MARKERS } from "@templ/chat/support-safety";
import { CRYPTO_SUPPORT_WORKSPACE } from "./crypto-support";
import { fetchPage, type IngestDependencies } from "./knowledge-ingest";
import { safeFetch } from "./safe-fetch";
import { addSource, recordFetch } from "./support-knowledge-kb";
import {
  readMeta,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "./support-knowledge-schema";

// A source is read only when the question names it. Wallets, gas, staking and
// rollups exist on many chains, so those words name no source.
const directories: [RegExp, string][] = [
  [
    /\b(bitcoin|btc|satoshis?|sats|lightning (?:network|invoices?|channels?))\b/i,
    "https://bitcoin.org/sitemap.xml",
  ],
  // "Vault.sol" is a Solidity file.
  [/\b(solana|spl)\b|(?<!\.)\bsol\b/i, "https://solana.com/llms.txt"],
  [/\barbitrum\b/i, "https://docs.arbitrum.io/llms.txt"],
  [/\b(optimism|op (?:mainnet|stack))\b/i, "https://docs.optimism.io/llms.txt"],
  // "base fee", "base layer" and "base chain" are also generic terms, so Base
  // needs one of its own names or "Base" written as the chain's name.
  [
    /\bbase(?:\.org|scan| mainnet| sepolia| testnet)\b/i,
    "https://docs.base.org/llms.txt",
  ],
  [
    /\bBase (?:[Cc]hain|[Nn]etwork|L2)\b|\b(?:[Oo]n|[Tt]o|[Ff]rom|[Oo]nto|[Ii]nto|[Vv]ia|[Ff]or|[Ww]ith) Base\b(?! [Ff]ees?\b| [Ll]ayer\b)/,
    "https://docs.base.org/llms.txt",
  ],
  [/\baave\b/i, "https://aave.com/sitemap.xml"],
  [/\buniswap\b/i, "https://developers.uniswap.org/llms.txt"],
  [/\bmorpho\b/i, "https://docs.morpho.org/llms.txt"],
  [
    /\b(gnosis safe|safe multisig|safe smart account)\b/i,
    "https://docs.safe.global/llms.txt",
  ],
  // "a safe wallet" can be any wallet.
  [/\bSafe [Ww]allet\b/, "https://docs.safe.global/llms.txt"],
  [
    /\b(ethereum|ether|eth)\b/i,
    "https://ethereum.org/llms.txt",
  ],
];
const stop = new Set(
  "with does this that what which where when should would could need have from about can how for the and any are into more now latest current why you your get use".split(
    " ",
  ),
);
// Source names, generic chain words and the sources' shared page paths match
// across a whole index, so they never choose a page.
const generic = new Set(
  "bitcoin btc satoshi satoshis sats solana sol arbitrum optimism base aave uniswap morpho safe gnosis ethereum ether eth chain chains network networks blockchain mainnet crypto docs help".split(
    " ",
  ),
);

/** The question's topic words. Redaction markers are Templ's words, not the
 * visitor's. */
function topicTerms(question: string) {
  let text = question;
  for (const marker of Object.values(REDACTION_MARKERS))
    text = text.replaceAll(marker, " ");
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter(
    (term) => !stop.has(term) && !generic.has(term),
  );
}

// These first-party pages explain visitor terminology that does not appear in
// their titles. A guide is eligible only while its own index still lists it.
const supportGuides: Record<string, [RegExp, string][]> = {
  "bitcoin.org": [[/\b(?:confirmations?|unconfirmed)\b/i, "/en/faq"]],
  "aave.com": [[/\b(?:health factor|liquidat(?:ion|ions|ed))\b/i, "/help/borrowing/liquidations"]],
  "docs.optimism.io": [
    [/\b(?:transaction fees?|execution (?:fee|gas)|l1 data fee|operator fee|gas price)\b/i, "/op-stack/transactions/fees"],
    [/\bwithdrawals?\b/i, "/op-stack/bridging/withdrawal-flow"],
  ],
};

export function selectResearchPage(
  directory: string,
  index: string,
  question: string,
): string | undefined {
  const terms = topicTerms(question);
  // Past two topic words, one shared word is often incidental, so the page
  // must match two.
  const needed = terms.length > 2 ? 2 : 1;
  const base = new URL(directory);
  // Third-party routes and Lightning have their own settlement rules. The
  // native-chain guide is insufficient evidence for those cases.
  const guides = /\b(?:lightning|fast bridge|third[- ]party bridge)\b/i.test(question)
    ? []
    : (supportGuides[base.host] ?? []).filter(([topic]) => topic.test(question));
  const guide = guides.length === 1 ? guides[0][1] : undefined;
  let best: string | undefined,
    bestScore = 0,
    tied = false;
  const links = index.matchAll(
    /\[([^\]\n]{1,160})\]\(([^)\s]{1,500})\)|<loc>\s*([^<\s]{1,500})\s*<\/loc>/gi,
  );
  for (const match of links) {
    let url: URL;
    try {
      url = new URL(match[2] ?? match[3], base);
    } catch {
      continue;
    }
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[a-z0-9/_.%-]+$/i.test(url.pathname) ||
      /(?:audit|exploit|private-key|red-team|sitemap|llms|\/api\/|\.xml|\.json|\.txt)/i.test(
        url.pathname,
      )
    )
      continue;
    if (base.host === "aave.com" && !url.pathname.startsWith("/help/"))
      continue;
    // bitcoin.org prefixes every language. ethereum.org serves English at the
    // root and other languages under their codes.
    if (base.host === "bitcoin.org" && !url.pathname.startsWith("/en/"))
      continue;
    if (
      base.host === "ethereum.org" &&
      /^\/(?!en(?:\/|$))[a-z]{2}(?:-[a-z]{2,4})?(?:\/|$)/i.test(url.pathname)
    )
      continue;
    if (guide && url.pathname.replace(/(?:\.md|\/)$/, "") === guide) return url.href;
    // Sections written for operators and developers do not answer visitors.
    if (/\b(?:operators|developers)\b/i.test(url.pathname)) continue;
    const words = new Set(
      ((match[1] ?? "") + " " + url.pathname)
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g),
    );
    const score = terms.reduce((n, term) => n + Number(words.has(term)), 0);
    if (score > bestScore) {
      bestScore = score;
      best = url.href;
      tied = false;
    } else if (score === bestScore && url.href !== best) tied = true;
  }
  // Pages that match equally well leave the answer open, so none is chosen.
  return bestScore >= needed && !tied ? best : undefined;
}

export async function researchCryptoDocs(
  db: KnowledgeDb,
  room: string,
  question: string,
  now: number,
  dependencies: IngestDependencies = {},
) {
  if (room !== "room:" + CRYPTO_SUPPORT_WORKSPACE) return;
  const directory = directories.find(([pattern]) =>
    pattern.test(question),
  )?.[1];
  // Without a topic word no page can match, so nothing is reserved or fetched.
  if (!directory || !topicTerms(question).length) return;
  const hour = Math.floor(now / 3_600_000);
  const key = "crypto.research.hour";
  const reserved = db.transaction(() => {
    const stored = JSON.parse(readMeta(db, key) ?? "null") as {
      hour: number;
      count: number;
    } | null;
    const count = stored?.hour === hour ? stored.count : 0;
    if (count >= 20) return false;
    writeMeta(db, key, JSON.stringify({ hour, count: count + 1 }));
    return true;
  });
  if (!reserved) return;
  const index = await safeFetch(
    directory,
    {
      maxBytes: 750_000,
      timeoutMs: 3500,
      maxRedirects: 1,
      sameHost: true,
      allowQuery: false,
    },
    dependencies,
  );
  if (index.status !== 200) return;
  const url = selectResearchPage(
    directory,
    new TextDecoder().decode(index.body),
    question,
  );
  if (!url) return;
  const existing = () =>
    db.sql.exec("SELECT id FROM kb_sources WHERE url = ?", url).toArray()[0];
  // Existing pages follow their owner's visibility, edits and refresh schedule.
  if (existing()) return;
  const page = await fetchPage(url, null, dependencies, false, false, true);
  if (page.kind !== "text") return;
  const sha256 = await sha256Hex(page.text);
  db.transaction(() => {
    if (existing()) return;
    const source = addSource(db, { kind: "doc", url }, now);
    recordFetch(db, source.id, { ...page, sha256 }, now);
  });
}
