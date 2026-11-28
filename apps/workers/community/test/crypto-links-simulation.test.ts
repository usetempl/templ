import { describe, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CRYPTO_SUPPORT_MODEL,
  CRYPTO_SUPPORT_WORKSPACE,
  DEFAULT_SUPPORT_MODEL,
} from "@templ/chat/support-models";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { checkAgentReply } from "@templ/chat/support-safety";
import { simulate } from "@templ/chat/simulation.test.helpers";
import {
  CRYPTO_LINKS,
  CRYPTO_LINK_HOSTS,
  CRYPTO_LINK_LIMITS,
  CRYPTO_OFFERED_LINKS,
  CRYPTO_WALLET_BASICS,
  cryptoLinkProblem,
  withCryptoSources,
} from "../src/crypto-links";
import { researchCryptoDocs } from "../src/crypto-research";
import {
  CRYPTO_GROUNDED_SYSTEM,
  CRYPTO_GROUNDED_VERIFIER_SYSTEM,
  GROUNDED_SYSTEM,
  GROUNDED_VERIFIER_SYSTEM,
  groundedSafeText,
  verifyGroundedReceipt,
} from "../src/managed-agent/grounded";
import {
  CRYPTO_CLARIFY_REPLY,
  CRYPTO_SCAM_REPLY,
  INVESTMENT_REFUSAL,
} from "../src/managed-agent/crypto-triage";
import { runManagedJobs, type RunnerDeps } from "../src/managed-agent/runner";
import { addJobs } from "../src/managed-agent/store";
import type { ModelRequest, ModelResult } from "../src/managed-agent/anthropic";
import { addSource, recordFetch, type KnowledgeHitRow } from "../src/support-knowledge-kb";
import { ensureSchema, readMeta, sha256Hex, writeMeta } from "../src/support-knowledge-schema";
import { memberSources } from "../src/support-widget-member";
import type { TeamConversationRecord } from "../src/team-conversations";
import { knowledgeTestDb } from "./knowledge-sqlite";

const T = Date.UTC(2026, 10, 27);
const DESK = "room:" + CRYPTO_SUPPORT_WORKSPACE;
const OTHER = "room:01990000-0000-7000-8000-00000000000a";
const thread = `tc-${"d".repeat(32)}`;
const bot = ("0x" + "3".repeat(40)) as ChatPrincipalId;
const NETWORKS = ["bitcoin", "ethereum", "base", "op-mainnet", "arbitrum", "solana"] as const;
const REPLY_LINKS = CRYPTO_LINK_LIMITS.inline + CRYPTO_LINK_LIMITS.sources;
const char = (code: number) => String.fromCodePoint(code);
const fullwidth = (text: string) =>
  [...text].map((letter) => char(letter.codePointAt(0)! + 0xfee0)).join("");
const pair = (label: string) => {
  const link = CRYPTO_LINKS.find((item) => item.label === label)!;
  return `[${link.label}](${link.url})`;
};

/** Text a reply may hold. Code names, ENS names, other scripts, emoji and
 * reviewed site names are not links. */
const SAFE = [
  "Your receive address is public.",
  "Anyone with your recovery phrase can take your funds.",
  "Use window.ethereum to read the account.",
  "Vault.sol, web3.js and name.eth are not websites.",
  "The fee was 0.0002 BTC, e.g. on Bitcoin.",
  "Bitcoin: the first network.",
  "**Solana:** fees are paid in SOL.",
  "Compare wallets on bitcoin.org or ethereum.org.",
  `می${char(0x200c)}خواهم یک کیف پول بسازم.`,
  "Faça uma pequena transferência de teste primeiro.",
  "我想创建一个钱包。下一步是备份。",
  `${char(0x2705)}${char(0xfe0f)} Done.`,
  "Etherscan and Solscan show public activity.",
  CRYPTO_SCAM_REPLY,
  INVESTMENT_REFUSAL,
];
/** Each one is refused wherever it appears: label mismatches, changed
 * addresses, saved or discovered pages, naked addresses and schemes,
 * redirects, lookalike letters and hidden characters. */
const UNSAFE = [
  "[BlueWallet](https://phantom.com/download)",
  "[Phantom](https://phantom.com/download?ref=templ)",
  "[Phantom](https://phantom.com/download#install)",
  "[Phantom](http://phantom.com/download)",
  "[Phantom](https://PHANTOM.com/download)",
  "[Phantom](https://phantom.com/download/)",
  "[Phantom](https://phantom.com.example.net/download)",
  "[Phantom](https://phantom.com@example.net/download)",
  `[Phantom](https://ph${char(0x430)}ntom.com/download)`,
  "[https://phantom.com/download](https://phantom.com/download)",
  "[Phantom](/download)",
  "[Phantom](javascript:alert(1))",
  "[Bridge guide](https://docs.base.org/bridge)",
  "https://bluewallet.io/",
  "<https://bluewallet.io/>",
  '<a href="https://bluewallet.io/">BlueWallet</a>',
  "https://t.co/abc",
  `${fullwidth("https://")}phantom.com`,
  "phantom-wallet.app",
  "www.metamask.com",
  "metamask.com/download",
  "//phantom.com",
  "support@metamask-help.com",
  `evil${char(0x3002)}com`,
  "xn--phntom-6ve.com",
  `bitcoin.${char(0x43e)}rg`,
  "bitcoin:bc1qexampleaddress",
  "wc:abc123@2?relay-protocol=irn",
  "ethereum:pay-0xabc",
  `Phantom${char(0x202e)}moc.ppa`,
  `blue${char(0x200b)}wallet.io`,
  `blue${char(0xad)}wallet.io`,
  `blue${char(0x200d)}wallet`,
  `BlueWallet${char(0xe0041)}`,
];

describe("crypto desk links", () => {
  simulate("renders the official sources for each public Crypto Help Desk FAQ", (draw) => {
    const file = new URL("../../../../packages/chat/knowledge/crypto-help-desk.json", import.meta.url);
    const pack = JSON.parse(readFileSync(file, "utf8")) as {
      faqs: { question: string; answer: string; references: string[] }[];
    };
    expect(new Set(pack.faqs.map(faq => faq.question)).size).toBe(pack.faqs.length);
    const db = knowledgeTestDb();
    try {
      ensureSchema(db, T);
      for (const faq of draw.shuffle(pack.faqs)) {
        expect(faq.question.length).toBeLessThanOrEqual(120);
        expect(faq.references.length).toBeGreaterThan(0);
        const excerpt = [faq.answer, ...faq.references.map(url => "Reference: " + url)].join(" ");
        addSource(db, { kind: "faq", title: faq.question, text: excerpt, era: "current", visibility: "member-safe" }, T);
        const shown = withCryptoSources(faq.answer, [{ kind: "faq", visibility: "member-safe", excerpt }]);
        for (const url of faq.references) {
          const source = CRYPTO_LINKS.find(link => link.url === url);
          expect(source, faq.question).toBeDefined();
          expect(shown, faq.question).toContain(`[${source!.label}](${url})`);
        }
      }
    } finally {
      db.raw.close();
    }
  });

  simulate("offers one reviewed wallet, its network guide and one app list per network", (draw) => {
    const offered = CRYPTO_LINKS.filter((link) => link.offer);
    for (const network of draw.shuffle(NETWORKS)) {
      const mine = offered.filter((link) => link.networks.includes(network));
      expect(mine.filter((link) => link.kind === "wallet"), network).toHaveLength(1);
      expect(mine.some((link) => link.kind === "guide"), network).toBe(true);
      expect(mine.filter((link) => link.kind === "apps").map((link) => link.url)).toEqual([
        `https://defillama.com/chain/${network}`,
      ]);
    }
    expect(offered.filter((link) => link.kind === "emergency").map((link) => link.url)).toEqual([
      "https://securityalliance.org/sos",
    ]);
    // Every reviewed address is exact: HTTPS with no query, fragment, account or port.
    for (const link of CRYPTO_LINKS)
      for (const url of [link.url, ...(link.copies ?? [])]) {
        const parsed = new URL(url);
        expect(
          [parsed.protocol, parsed.search, parsed.hash, parsed.username, parsed.password, parsed.port],
          url,
        ).toEqual(["https:", "", "", "", "", ""]);
        expect(/^[!-~]+$/.test(url), url).toBe(true);
      }
    for (const link of CRYPTO_LINKS)
      expect(/^[ -~]+$/.test(link.label) && !/[[\]()]/.test(link.label), link.label).toBe(true);
    expect(new Set(CRYPTO_LINKS.map((link) => link.url)).size).toBe(CRYPTO_LINKS.length);
    // Only the desk's prompt and verifier read the basics and the links.
    expect(CRYPTO_GROUNDED_SYSTEM).toContain(CRYPTO_WALLET_BASICS);
    expect(CRYPTO_GROUNDED_SYSTEM).toContain(CRYPTO_OFFERED_LINKS);
    expect(CRYPTO_GROUNDED_VERIFIER_SYSTEM.startsWith(GROUNDED_VERIFIER_SYSTEM)).toBe(true);
    expect(CRYPTO_GROUNDED_VERIFIER_SYSTEM).toContain(CRYPTO_WALLET_BASICS);
    expect(CRYPTO_GROUNDED_VERIFIER_SYSTEM).toContain(CRYPTO_OFFERED_LINKS);
    expect(GROUNDED_SYSTEM).not.toContain(CRYPTO_WALLET_BASICS);
    expect(GROUNDED_VERIFIER_SYSTEM).not.toContain(CRYPTO_OFFERED_LINKS);
  });

  simulate("keeps every reviewed wallet basic sendable, alone or together", (draw) => {
    const sentences = CRYPTO_WALLET_BASICS.split("\n").flatMap((line) =>
      line.slice(2).split(/(?<=[.!?])\s+/),
    );
    for (let round = 0; round < 12; round++) {
      const text = draw.shuffle(sentences).slice(0, draw.int(1, sentences.length)).join(" ");
      expect(checkAgentReply(text, { allowedHosts: CRYPTO_LINK_HOSTS, maxBytes: 3500 }), text).toBeNull();
      expect(cryptoLinkProblem(text), text).toBeNull();
    }
  });

  simulate("links only to exact reviewed pages with their own labels, in any mix of text", (draw) => {
    for (let round = 0; round < 40; round++) {
      const links = draw.shuffle(CRYPTO_LINKS).slice(0, draw.int(0, 6));
      const unsafe = draw.chance(0.5) ? draw.shuffle(UNSAFE).slice(0, draw.int(1, 2)) : [];
      const parts = draw.shuffle([
        ...draw.shuffle(SAFE).slice(0, draw.int(0, 5)),
        ...links.map((link) => `[${link.label}](${link.url})`),
        ...unsafe,
      ]);
      const text = parts.join(draw.pick([" ", "\n", "\n\n"])) || "Hello.";
      const refused = unsafe.length > 0 || links.length > CRYPTO_LINK_LIMITS.inline;
      expect(cryptoLinkProblem(text) !== null, text).toBe(refused);
      if (refused) expect(groundedSafeText(text, [], true), text).toBe(false);
    }
    for (const text of UNSAFE) expect(cryptoLinkProblem(text), text).not.toBeNull();
    for (const text of SAFE) expect(cryptoLinkProblem(text), text).toBeNull();
  });

  simulate("gives saved and discovered pages no link authority on the desk only", (draw) => {
    // Pages on reviewed and unreviewed sites alike, as research or the team saved them.
    const saved = [
      "https://docs.base.org/bridge", "https://docs.optimism.io/op-stack/protocol/hardforks/isthmus.md",
      "https://bitcoin.org/en/vocabulary/", "https://docs.example.org/fees", "https://support.metamask.io/start/",
    ];
    for (const url of draw.shuffle(saved)) {
      const page: KnowledgeHitRow = {
        sourceId: "kb:kb-0123456789abcdef-1", kind: "doc", title: "Saved page", excerpt: "The page text.",
        url, era: "current", visibility: "member-safe", updatedAt: new Date(T).toISOString(),
      };
      const text = draw.pick([`Read ${url} for details.`, `Read [Saved page](${url}).`, `Read <${url}>.`]);
      expect(groundedSafeText(text, [page], true), text).toBe(false);
      // Other workspaces keep links to the sites their own sources name.
      expect(groundedSafeText(text, [page], false), text).toBe(true);
      const wallet = `Install ${pair(draw.pick(["Phantom", "MetaMask", "BlueWallet"]))}.`;
      expect(groundedSafeText(wallet, [page], true), wallet).toBe(true);
      expect(groundedSafeText(wallet, [page], false), wallet).toBe(false);
    }
  });

  simulate("lists only reviewed guide pages as sources, never a saved address, wallet or app list", (draw) => {
    const guides = CRYPTO_LINKS.filter((link) => link.kind === "guide" || link.kind === "emergency");
    const others = CRYPTO_LINKS.filter((link) => link.kind === "wallet" || link.kind === "apps");
    const unreviewed = [
      "https://docs.base.org/bridge", "https://example.net/guide", "http://bitcoin.org/en/faq",
      "https://bitcoin.org/en/faq?ref=templ", "https://user@bitcoin.org/en/faq", undefined,
    ];
    const reviewed = (url: string | undefined) =>
      guides.find((link) => link.url === url || (url !== undefined && link.copies?.includes(url)));
    for (let round = 0; round < 20; round++) {
      const hits = draw.shuffle([
        ...draw.shuffle(guides).slice(0, draw.int(0, 5)).map((link) => ({
          url: link.copies?.length && draw.chance(0.4) ? draw.pick(link.copies) : link.url,
        })),
        ...draw.shuffle(others).slice(0, draw.int(0, 3)).map((link) => ({ url: link.url })),
        ...draw.shuffle(unreviewed).slice(0, draw.int(0, 3)).map((url) => ({ url })),
      ]);
      // A long answer leaves no room for the shortest source line.
      const answer = draw.pick(["Short answer.", "x".repeat(3_990)]);
      const text = withCryptoSources(answer, hits);
      expect(text.startsWith(answer)).toBe(true);
      const tail = text.slice(answer.length);
      const listed = tail ? tail.split("\n").slice(3) : [];
      if (tail) expect(tail.split("\n").slice(0, 3)).toEqual(["", "", "Sources:"]);
      const expected = [
        ...new Set(hits.flatMap((hit) => {
          const link = reviewed(hit.url);
          return link ? [`[${link.label}](${link.url})`] : [];
        })),
      ];
      expect(listed).toEqual(answer === "Short answer." ? expected.slice(0, CRYPTO_LINK_LIMITS.sources) : []);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4_000);
      expect(cryptoLinkProblem(text, REPLY_LINKS), text).toBeNull();
      for (const hit of hits)
        if (hit.url && !reviewed(hit.url)) expect(listed.join("\n")).not.toContain(`(${hit.url})`);
    }
  });
});

type Kind = "answer" | "verify" | "triage";
/** One visitor question through the real runner. `pages` are the
 * workspace's saved official pages. The answer model writes `reply` and
 * cites every page unless `cite` is false, the verifier accepts what it is
 * shown and triage finds no technical issue. The room keeps only replies
 * whose receipt verifies, and the network is never reached. */
async function ask(
  room: string,
  question: string,
  pages: { url: string; text: string }[],
  reply: string,
  cite = true,
) {
  const desk = room === DESK;
  const model = desk ? CRYPTO_SUPPORT_MODEL : DEFAULT_SUPPORT_MODEL;
  const db = knowledgeTestDb();
  ensureSchema(db, T);
  writeMeta(db, "room", room);
  const ids: string[] = [];
  for (const page of pages) {
    const source = addSource(db, { kind: "doc", url: page.url, title: "Official page" }, T);
    recordFetch(db, source.id, {
      kind: "text", title: "Official page", text: page.text, etag: null, sha256: await sha256Hex(page.text),
    }, T);
    ids.push(`kb:${source.id}-1`);
  }
  const messages = [{ id: "1", revision: 1, author: "member", text: question, createdAt: new Date(T).toISOString() }];
  const calls: { kind: Kind; system: string; user: string }[] = [];
  const replies: string[] = [], handoffs: unknown[] = [];
  const client = {
    async get(path: string) {
      if (!path.includes("managed/state"))
        return { status: 200, body: { messages: structuredClone(messages) } };
      return { status: 200, body: {
        prepaid: true, prepaidModel: DEFAULT_SUPPORT_MODEL, sponsoredResearch: desk, readinessPolicy: "grounded_v1",
        enabled: true, onTeam: true, grant: true, thread, member: "member", state: "open",
        mode: "answers", caseSeq: 1, caseOpenedAt: T, caseMemberMessages: 1,
        evidence: [], memberEvidence: [], storageGrant: null,
      } };
    },
    async post(path: string, body: Record<string, unknown>) {
      if (body.action === "handoff") {
        handoffs.push(body.reason);
        return { status: 200, body: {} };
      }
      if (body.action === "draft") return { status: 201, body: {} };
      if (!path.endsWith("/messages")) return { status: 400, body: {} };
      const managed = body.managed as { grounded: string };
      const provenance = body.provenance as { sources: { id: string }[]; grounding: unknown };
      const checked = await verifyGroundedReceipt(db, {
        receipt: managed.grounded, grounding: provenance.grounding, thread, case: 1,
        latest: { id: "1", revision: 1 }, text: body.text,
        sourceIds: provenance.sources.map((source) => source.id), sources: provenance.sources,
        storageGrant: null,
      }, T + 1_000);
      if (!checked.ok) return { status: 409, body: { reason: "grounded-answer-unverified" } };
      replies.push(String(body.text));
      return { status: 201, body: { message: { id: "2", revision: 1 } } };
    },
  };
  const provider = async ({ system, user }: ModelRequest): Promise<ModelResult> => {
    const kind: Kind = system.startsWith("Classify an unresolved")
      ? "triage"
      : system.startsWith("You independently check") ? "verify" : "answer";
    calls.push({ kind, system, user });
    const sources = kind === "verify"
      ? (JSON.parse(user).passages as { sourceId: string }[]).map((passage) => passage.sourceId)
      : kind === "answer" && cite ? ids : [];
    return { kind: "answer", model, usage: {}, value: {
      action: "reply", text: kind === "triage" ? "other" : kind === "verify" ? "Supported." : reply,
      confidence: "high", handoffReason: null, sources, facts: [], claims: [], comparisons: [], summary: "",
    } };
  };
  const deps: RunnerDeps = {
    db, room, principal: bot,
    env: {
      MANAGED_AGENT_ENABLED: "true", RELEASED_FEATURES: '["managedAgent"]',
      MANAGED_AGENT_SPEND_CAP_USD_CENTS: "10000", MANAGED_AGENT_GATEWAY_ID: "templ-support",
      AI: { run: async () => ({}) } as unknown as Pick<Ai, "run">,
    },
    roomClient: () => client,
    model: null,
    prepaidModel: (_billing, sponsored) => {
      if (Boolean(sponsored) !== desk) throw new Error("The call used another funding path.");
      return provider;
    },
    now: () => T + 1_000,
    templMeter: { reserve: async () => true, settle: async () => {}, release: async () => {} },
  };
  addJobs(db, [{
    id: crypto.randomUUID(), kind: "member-message", thread, request: null, manager: bot,
    at: T + 500, due: T + 1_000, attempts: 0,
  }]);
  try {
    const first = await runManagedJobs(deps);
    return { first, calls, replies, handoffs };
  } finally {
    db.raw.close();
  }
}

const sourcesFor = (...labels: string[]) => "\n\nSources:\n" + labels.map(pair).join("\n");
/** Beginner wallet questions in the visitor's language, each grounded on its
 * network's official wallet guide. */
const BEGINNERS = [
  {
    question: "I want to make my first Bitcoin wallet. Someone asked for my public key. Is that safe?",
    page: { url: "https://bitcoin.org/en/choose-your-wallet", text: "Choose your Bitcoin wallet. Compare wallets before you install one." },
    reply: `Your public key and receive address are public, so you can share them. Your recovery phrase is secret, so never share it. Install ${pair("BlueWallet")}, create a new wallet and write the recovery phrase on paper. Many people make a small test transfer first.`,
    guide: "Bitcoin wallet guide",
  },
  {
    question: "Como crio minha primeira carteira Solana? Posso compartilhar minha chave pública?",
    page: { url: "https://solana.com/learn/what-is-a-wallet", text: "A wallet holds your keys. Your public key is your address." },
    reply: `Sua chave pública é o seu endereço e pode ser compartilhada. Nunca compartilhe a frase de recuperação. Instale o ${pair("Phantom")}, crie a carteira e anote a frase no papel. Antes de um valor grande, muitas pessoas fazem uma pequena transferência de teste.`,
    guide: "Solana wallet guide",
  },
  {
    question: "¿Cómo creo una billetera para usar en Ethereum y Base?",
    page: { url: "https://ethereum.org/wallets/find-wallet/", text: "Find a wallet that supports the networks you use." },
    reply: `Una cuenta normal tiene la misma dirección en Ethereum y Base, con saldos separados. Instala ${pair("MetaMask")} y escribe la frase de recuperación en papel. Nunca la compartas.`,
    guide: "Ethereum wallet finder",
  },
  {
    question: "Why did my OP Mainnet transfer cost more than its execution gas?",
    page: { url: "https://docs.optimism.io/op-stack/transactions/fees.md", text: "OP Mainnet fees include execution and a data fee for Ethereum." },
    reply: "OP Mainnet fees include execution and a data fee for Ethereum.",
    guide: "OP Mainnet fees",
  },
];

describe("crypto desk replies", () => {
  simulate(
    "sends beginner wallet help with reviewed links, and only reviewed source pages, in the visitor's language",
    async (draw) => {
      const network = vi.fn(async () => {
        throw new Error("The simulation has no network.");
      });
      vi.stubGlobal("fetch", network);
      try {
        for (const c of draw.shuffle(BEGINNERS)) {
          const run = await ask(DESK, c.question, [c.page], c.reply);
          expect(run.first, c.question).toEqual(["answered"]);
          expect(run.replies, c.question).toEqual([c.reply + sourcesFor(c.guide)]);
          expect(run.calls.map((call) => call.kind)).toEqual(["answer", "verify"]);
          expect(run.calls[0].system).toBe(CRYPTO_GROUNDED_SYSTEM);
          expect(run.calls[1].system).toBe(CRYPTO_GROUNDED_VERIFIER_SYSTEM);
          expect(JSON.parse(run.calls[1].user)).toMatchObject({ question: c.question, answer: c.reply });
          // The room's own check admits the reply it would store.
          expect(cryptoLinkProblem(run.replies[0], REPLY_LINKS)).toBeNull();
          const listed = run.replies[0].slice(c.reply.length);
          for (const link of CRYPTO_LINKS.filter((item) => item.kind === "wallet" || item.kind === "apps"))
            expect(listed).not.toContain(link.url);
          // A saved Markdown copy is listed by its reviewed page address.
          if (c.page.url.endsWith(".md")) expect(listed).not.toContain(c.page.url);
        }
        // A discovered page with no reviewed address grounds the answer and adds no link.
        const bridge = { url: "https://docs.base.org/bridge", text: "Deposits arrive after the Ethereum transaction confirms." };
        const plain = await ask(DESK, "How long does a bridge to Base take?", [bridge], bridge.text);
        expect(plain.replies).toEqual([bridge.text]);
        // Wallet basics answer without a passage, and still pass the verifier.
        const basics = "Your receive address is public. Share it to receive funds. Your recovery phrase controls every account in the wallet. Never share it or type it into a website, chat or form.";
        const question = "What is the difference between my receive address and my recovery phrase?";
        const alone = await ask(DESK, question, [], basics, false);
        expect(alone.replies).toEqual([basics]);
        expect(JSON.parse(alone.calls[1].user).passages).toEqual([]);
        // An unreviewed link, from the model or from knowledge, never reaches the visitor.
        for (const link of draw.shuffle(UNSAFE).slice(0, 4)) {
          const refused = await ask(DESK, "Where do I get a wallet for Base?", [bridge], `Get it here: ${link}`);
          expect(refused.replies, link).toEqual([CRYPTO_CLARIFY_REPLY]);
          expect(refused.calls.map((call) => call.kind), link).toEqual(["answer", "triage"]);
        }
        const naked = await ask(DESK, "Where are the Base fee docs?", [bridge], `See ${bridge.url} for details.`);
        expect(naked.replies).toEqual([CRYPTO_CLARIFY_REPLY]);
        // Other workspaces keep their own source links, verifier and handoffs.
        const own = { url: "https://docs.example.org/fees", text: "Fees are paid in ETH." };
        const ordinary = await ask(OTHER, "Which token pays the fees?", [own], `Fees are paid in ETH. Read more at ${own.url}`);
        expect(ordinary.replies).toEqual([`Fees are paid in ETH. Read more at ${own.url}`]);
        expect(ordinary.calls[1].system).toBe(GROUNDED_VERIFIER_SYSTEM);
        expect(JSON.parse(ordinary.calls[1].user)).not.toHaveProperty("question");
        const unsourced = await ask(OTHER, question, [], basics, false);
        expect(unsourced).toMatchObject({ first: ["handed-off"], replies: [], calls: [] });
        const wallet = await ask(OTHER, "Which wallet should I use?", [own], `Install ${pair("Phantom")}.`);
        expect(wallet).toMatchObject({ first: ["handed-off"], replies: [] });
      } finally {
        vi.unstubAllGlobals();
      }
    },
    { timeout: 60_000 },
  );

  simulate("shows no saved source titles or links under a desk reply", async (draw) => {
    const storage = new Proxy({}, {
      get: () => {
        throw new Error("The desk read stored provenance.");
      },
    }) as unknown as DurableObjectTransaction;
    const record = { id: thread, room: DESK } as unknown as TeamConversationRecord;
    const ids = Array.from({ length: draw.int(1, 20) }, () => String(draw.int(1, 999)));
    expect(await memberSources(storage, record, ids)).toEqual({});
  });
});

/** One research lookup with fixed index and page responses. */
async function research(question: string, responses: Record<string, () => Response>) {
  const db = knowledgeTestDb();
  ensureSchema(db, T);
  const requested: string[] = [];
  try {
    await researchCryptoDocs(db, DESK, question, T, {
      resolve: async () => ["93.184.216.34"],
      fetch: async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return responses[String(input)]?.() ?? new Response(null, { status: 404 });
      },
    }).catch(() => undefined);
    return {
      requested,
      reserved: readMeta(db, "crypto.research.hour") !== null,
      saved: db.sql.exec("SELECT url FROM kb_sources").toArray().map((row) => row.url),
    };
  } finally {
    db.raw.close();
  }
}

simulate("starts a first wallet answer from the network's own wallet guide, in English, Portuguese or Spanish", async (draw) => {
  const bitcoin = "https://bitcoin.org/sitemap.xml",
    ethereum = "https://ethereum.org/llms.txt",
    solana = "https://solana.com/llms.txt";
  // Synthetic entries in each index's own format.
  const indexes: Record<string, string[]> = {
    [bitcoin]: ["choose-your-wallet", "secure-your-wallet", "faq", "vocabulary"].map(
      (path) => `<url><loc>https://bitcoin.org/en/${path}</loc></url>`,
    ),
    [ethereum]: [
      "- [Get a wallet](https://ethereum.org/wallets/find-wallet/)",
      "- [Ethereum wallets](https://ethereum.org/wallets/)",
      "- [Network fees](https://ethereum.org/gas/)",
    ],
    [solana]: [
      "- [What is a wallet?](https://solana.com/learn/what-is-a-wallet)",
      "- [Fees](https://solana.com/docs/core/fees)",
      "- [Wallets](https://solana.com/wallets)",
    ],
  };
  const cases: [string, string, string?][] = [
    [bitcoin, "How do I create a Bitcoin wallet?", "https://bitcoin.org/en/choose-your-wallet"],
    [bitcoin, "Qual é a melhor carteira de Bitcoin para começar?", "https://bitcoin.org/en/choose-your-wallet"],
    [bitcoin, "¿Cómo creo una billetera de Bitcoin?", "https://bitcoin.org/en/choose-your-wallet"],
    [ethereum, "Which Ethereum wallet should I set up first?", "https://ethereum.org/wallets/find-wallet/"],
    [ethereum, "Quero criar uma carteira Ethereum nova.", "https://ethereum.org/wallets/find-wallet/"],
    [solana, "How do I make a new Solana wallet?", "https://solana.com/learn/what-is-a-wallet"],
    [solana, "¿Qué billetera de Solana debo elegir?", "https://solana.com/learn/what-is-a-wallet"],
    // Other wallet questions keep their own page, or none.
    [bitcoin, "How do I secure my Bitcoin wallet?", "https://bitcoin.org/en/secure-your-wallet"],
    [ethereum, "Make sure my Ethereum wallet shows the right balance."],
    [bitcoin, "How do I create a Lightning wallet for bitcoin?"],
    [ethereum, "Sou desenvolvedor: como criar uma carteira Ethereum no meu app?"],
    [solana, "My Solana wallet shows a pending transfer."],
  ];
  for (const [directory, question, page] of draw.shuffle(cases)) {
    const responses: Record<string, () => Response> = {
      [directory]: () => new Response(draw.shuffle(indexes[directory]).join("\n")),
    };
    if (page)
      responses[page] = () =>
        new Response("# Official page\nThe page text.", { headers: { "content-type": "text/markdown" } });
    expect(await research(question, responses), question).toEqual({
      requested: page ? [directory, page] : [directory],
      reserved: true,
      saved: page ? [page] : [],
    });
  }
  // Without a network name nothing is requested, in any language.
  for (const question of ["How do I create a new wallet?", "Qual carteira devo escolher?", "¿Qué billetera debo elegir?"])
    expect(await research(question, {}), question).toEqual({ requested: [], reserved: false, saved: [] });
});
