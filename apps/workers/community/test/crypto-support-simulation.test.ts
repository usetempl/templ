import { DEFAULT_SUPPORT_MODEL, CRYPTO_SUPPORT_MODEL } from "@templ/chat/support-models";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { WORKSPACE_FLAG_KEYS, type WorkspaceFeatures } from "@templ/chat/workspace-flags";
import { workspaceFeatureEnvFromValues } from "../src/workspace-flags";
import { addSource } from "../src/support-knowledge-kb";
import { runManagedJobs, type JobOutcome, type RunnerDeps } from "../src/managed-agent/runner";
import { addJobs } from "../src/managed-agent/store";
import { verifyGroundedReceipt } from "../src/managed-agent/grounded";
import { CRYPTO_CLARIFY_REPLY, CRYPTO_READ_ONLY_REPLY, CRYPTO_REPLY_TRANSLATIONS, CRYPTO_SCAM_REPLY } from "../src/managed-agent/crypto-triage";
import type { ModelRequest, ModelResult } from "../src/managed-agent/anthropic";

vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000001",
}));
import { expect, it, vi } from "vitest";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_SUPPORT_WORKSPACE } from "../src/crypto-support";
import { researchCryptoDocs } from "../src/crypto-research";
import { ensureSchema, readMeta, writeMeta } from "../src/support-knowledge-schema";
import { knowledgeTestDb } from "./knowledge-sqlite";

// Self-hosting starts without a sponsored desk. Give this isolated simulation
// its own workspace and replace every DNS and HTTP call with its local fixture.
vi.mock("../src/crypto-support", async original => ({
  ...await original<typeof import("../src/crypto-support")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000001",
}));
const room = "room:" + CRYPTO_SUPPORT_WORKSPACE;
const now = Date.UTC(2026, 10, 27);

/** One desk lookup without a network: the addresses it requested, whether it
 * reserved research budget and the pages it saved. */
async function lookup(
  question: string,
  responses: Record<string, () => Response> = {},
) {
  const db = knowledgeTestDb();
  ensureSchema(db, now);
  const requested: string[] = [];
  try {
    const outcome = await researchCryptoDocs(db, room, question, now, {
      resolve: async () => ["93.184.216.34"],
      fetch: async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return (
          responses[String(input)]?.() ?? new Response(null, { status: 404 })
        );
      },
    }).then(
      () => "done",
      (error: { reason?: string }) => error.reason ?? String(error),
    );
    return {
      outcome,
      requested,
      reserved: readMeta(db, "crypto.research.hour") !== null,
      saved: db.sql
        .exec("SELECT url FROM kb_sources")
        .toArray()
        .map((row) => row.url),
    };
  } finally {
    db.raw.close();
  }
}

simulate("reads an official page only on a clear topic match, in any index order", async (draw) => {
  const optimism = "https://docs.optimism.io/llms.txt",
    arbitrum = "https://docs.arbitrum.io/llms.txt",
    bitcoin = "https://bitcoin.org/sitemap.xml",
    aave = "https://aave.com/sitemap.xml",
    ethereum = "https://ethereum.org/llms.txt";
  // Entries from the official indexes on 2026-11-27.
  const indexes: Record<string, string[]> = {
    [optimism]: [
      "- [Deploy a Custom Gas Token chain](https://docs.optimism.io/chain-operators/guides/features/custom-gas-token-guide.md)",
      "- [Transaction Fees 101](https://docs.optimism.io/chain-operators/guides/management/transaction-fees-101.md)",
      "- [First steps](https://docs.optimism.io/app-developers/tutorials/development/supersim/first-steps.md)",
      "- [Estimating transaction fees on OP Mainnet](https://docs.optimism.io/app-developers/guides/transactions/estimates.md)",
      "- [Transaction fees on OP Mainnet](https://docs.optimism.io/op-stack/transactions/fees.md)",
      "- [Withdrawal flow](https://docs.optimism.io/op-stack/bridging/withdrawal-flow.md)",
      "- [Isthmus](https://docs.optimism.io/op-stack/protocol/hardforks/isthmus.md)",
    ],
    [arbitrum]: [
      "- [Arbitrum bridge](/arbitrum-bridge.md)",
      "- [Quickstart: Arbitrum bridge](/arbitrum-bridge/quickstart.md)",
      "- [My bridged funds have not arrived](/arbitrum-bridge/funds-not-arrived.md)",
      "- [Enable fast withdrawals on your Arbitrum chain](/launch-arbitrum-chain/chain-config/validation/fast-withdrawals.md)",
    ],
    [bitcoin]: [
      "choose-your-wallet",
      "secure-your-wallet",
      "faq",
      "vocabulary",
      "wallets/mobile/android/electrum/",
    ].map((path) => `<url><loc>https://bitcoin.org/en/${path}</loc></url>`),
    [aave]: [
      "supplying/toggle-collateral-status",
      "supplying/supply-tokens",
      "borrowing/borrow-tokens",
      "borrowing/liquidations",
    ].map((path) => `<url><loc>https://aave.com/help/${path}</loc></url>`),
    [ethereum]: [
      "- [Get a wallet](https://ethereum.org/wallets/find-wallet/)",
      "- [Network fees](https://ethereum.org/gas/)",
      "- [Payments](https://ethereum.org/payments/)",
      "- [Reports](https://ethereum.org/reports/)",
      "- [Trillion dollar security project](https://ethereum.org/reports/trillion-dollar-security/)",
    ],
  };
  const cases: [string, string, string?][] = [
    // Named visitor guidance and unrelated lexical matches.
    [optimism, "Why did my OP Mainnet transfer cost more than the gas it used times its gas price? Was the rest a priority tip or something Isthmus added?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [optimism, "The first receipt for my OP Mainnet withdrawal says initiated, and Ethereum shows nothing. Has it arrived there?", "https://docs.optimism.io/op-stack/bridging/withdrawal-flow.md"],
    [aave, "My Aave health factor fell below 1. Does that mean all of my collateral was already sold?", "https://aave.com/help/borrowing/liquidations"],
    [bitcoin, "My Bitcoin wallet still lists the payment as unconfirmed and the shop wants three confirmations. Has the payment failed?", "https://bitcoin.org/en/faq"],
    [bitcoin, "I paid 0.03 BTC from a 0.08 BTC coin and the explorer shows 0.0498 BTC going to an unfamiliar address in my wallet. Did I lose that as a fee?"],
    [ethereum, "My Ethereum wallet says the transaction was submitted, but I see no receipt yet. Did it succeed?"],
    [ethereum, "My Ethereum receipt reports a successful payment of the right amount to the shop, but the order still shows unpaid. Who can check it?"],
    // Equal matches, or none, choose nothing.
    [bitcoin, "Can you help with my Bitcoin wallet?"],
    [bitcoin, "Why does my Lightning invoice say expired?"],
    // A clear match still reads one page, never one for operators or developers.
    [arbitrum, "A friend says every bridge out of Arbitrum takes seven days. I moved my funds to Ethereum with a fast bridge. Which wait applies to me?", "https://docs.arbitrum.io/arbitrum-bridge/funds-not-arrived.md"],
    [optimism, "What are OP Mainnet transaction fees?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [bitcoin, "How do I secure my Bitcoin wallet?", "https://bitcoin.org/en/secure-your-wallet"],
    [aave, "How do Aave liquidations work?", "https://aave.com/help/borrowing/liquidations"],
    // The same guides in Portuguese and Spanish.
    [optimism, "Na Optimism, por que o custo inclui a publicação dos dados e a execução?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [optimism, "En OP Mainnet, ¿la tarifa incluye ejecución y el coste de datos en Ethereum?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [optimism, "Na rede Optimism, por que a taxa tem uma parte de L1?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [optimism, "Como é calculada a taxa da minha transação na OP Mainnet?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [optimism, "¿Qué es la tarifa de datos de L1 que pagué en OP Mainnet?", "https://docs.optimism.io/op-stack/transactions/fees.md"],
    [optimism, "Meu saque da OP Mainnet para a Ethereum pede para provar e depois finalizar. Por quê?", "https://docs.optimism.io/op-stack/bridging/withdrawal-flow.md"],
    [optimism, "Ya probé mi retiro de Optimism a Ethereum. ¿Cuándo puedo finalizarlo?", "https://docs.optimism.io/op-stack/bridging/withdrawal-flow.md"],
    [bitcoin, "Como saber quantas confirmações tenho na rede Bitcoin?", "https://bitcoin.org/en/faq"],
    [bitcoin, "¿Dónde veo las confirmaciones de mi transferencia bitcoin?", "https://bitcoin.org/en/faq"],
    [bitcoin, "Minha carteira de Bitcoin mostra o pagamento como não confirmado há duas horas. Ele falhou?", "https://bitcoin.org/en/faq"],
    [bitcoin, "Mi pago en BTC sigue sin confirmar. ¿Cuánto falta?", "https://bitcoin.org/en/faq"],
    [aave, "En Aave, ¿qué significa que mi factor de salud esté cerca de 1?", "https://aave.com/help/borrowing/liquidations"],
    [aave, "No Aave, meu fator de saúde caiu para 1,05. O que isso quer dizer?", "https://aave.com/help/borrowing/liquidations"],
    // Rates, savings, cash-outs, other topics, operators, developers and
    // third-party routes choose nothing.
    [optimism, "Na Optimism, a taxa de rendimento das minhas economias é maior do que na L1?"],
    [aave, "¿Me conviene dejar mis ahorros en Aave por la tasa de interés?"],
    [bitcoin, "Devo colocar minhas economias em Bitcoin agora?"],
    [optimism, "¿Cómo hago un retiro de OP Mainnet a mi cuenta bancaria?"],
    [optimism, "Na Optimism, qual parte da L1 garante a segurança?"],
    [aave, "En Aave, ¿cómo voto una propuesta de gobernanza?"],
    [bitcoin, "Como confirmo meu e-mail na corretora antes de comprar bitcoin?"],
    [optimism, "¿Cómo cambio la tarifa de datos de L1 en mi propia cadena OP Stack?"],
    [optimism, "Sou operador de uma rede derivada da Optimism. Como finalizo os saques dos usuários?"],
    [aave, "Soy desarrollador: ¿cómo leo el factor de salud de una cuenta de Aave desde mi contrato?"],
    [optimism, "Hice un retiro rápido de OP Mainnet con otra app. ¿Tengo que finalizarlo?"],
    [optimism, "Saquei da Optimism por uma ponte de terceiros. Preciso provar o saque?"],
    [bitcoin, "Mi factura Lightning de bitcoin no muestra confirmaciones. ¿Es normal?"],
  ];
  for (const [directory, question, page] of draw.shuffle(cases)) {
    const index = draw.shuffle(indexes[directory]).join("\n");
    const responses: Record<string, () => Response> = {
      [directory]: () => new Response(index),
    };
    if (page)
      responses[page] = () =>
        new Response("# Official page\nThe page text.", {
          headers: { "content-type": "text/markdown" },
        });
    expect(await lookup(question, responses), question).toEqual({
      outcome: "done",
      requested: page ? [directory, page] : [directory],
      reserved: true,
      saved: page ? [page] : [],
    });
  }
  // A topic without a source name requests nothing, in any language.
  for (const question of draw.shuffle([
    "Por que a taxa tem uma parte de L1?",
    "¿Qué significa que mi factor de salud esté cerca de 1?",
    "Quantas confirmações minha transferência precisa?",
    "¿Cuándo puedo finalizar mi retiro?",
  ]))
    expect(await lookup(question), question).toEqual({
      outcome: "done",
      requested: [],
      reserved: false,
      saved: [],
    });
});

const T = Date.UTC(2026, 10, 27);
const thread = `tc-${"c".repeat(32)}`;
const bot = ("0x" + "2".repeat(40)) as ChatPrincipalId;
const NORMAL_ROOM = "room:01990000-0000-7000-8000-00000000000a";
/** Where the desk's own answer ends before anyone could be paged. */
const PATHS = ["answered", "partial", "rejected", "failed", "handoff", "person", "late"] as const;
/** What the classification call returns. */
const VERDICTS = ["technical", "scam", "investing", "other", "failed", "garbage", "wrong-model", "low", "throws"] as const;
const ASKED = {
  technical: "My bridge transfer to Polygon is stuck with error 4001. How do I fix it?",
  scam: "My funds were stolen after I clicked a link in a message.",
  investing: "Should I put my savings into this new token?",
  other: "Write me a poem about the moon.",
};
const SOURCES = {
  scam: "Contact your wallet provider's official support team to report stolen funds.",
  other: "A pending bridge transfer usually finishes after the source network confirms it.",
};
type Case = {
  path: (typeof PATHS)[number];
  verdict: (typeof VERDICTS)[number] | "purchase" | "howto" | "operation";
  asked: keyof typeof ASKED;
  /** The first page fails; the retry finds the same thread or a newer message. */
  retry: "none" | "same" | "newer";
  procedure?: {
    question: string;
    passage: string;
    reply: string;
    language: "en" | "pt-BR" | "fr";
    priorClarification?: boolean;
    draft: "answered" | "handoff" | "clarified" | "rejected" | "invalid-schema" | "unlisted-citation" | "blocked-authorization" | "unsafe-incident" | "provider-refusal" | "no-funding";
    revision?: "unapproved-url" | "unknown-source" | "unsupported" | "detail-question" | "unsourced-claim" | "late" | "newer";
  };
  readOnlyFaq?: "accept" | "reject" | "unknown-source" | "superseded" | "late-revision";

};

/** One member message through the real runner and retry queue. The room
 * keeps the thread, refuses stale writes and admits managed replies only
 * with their current source-check receipt. */
async function runDesk(room: string, c: Case) {
  const desk = room === "room:" + CRYPTO_SUPPORT_WORKSPACE;
  const model = desk ? CRYPTO_SUPPORT_MODEL : DEFAULT_SUPPORT_MODEL;
  const db = knowledgeTestDb();
  ensureSchema(db, T);
  writeMeta(db, "room", room);
  const report = addSource(db, { kind: "faq", title: "Stolen funds", text: SOURCES.scam }, T);
  const pending = addSource(db, { kind: "faq", title: "Pending transfers", text: SOURCES.other }, T);
  const base = c.readOnlyFaq ? addSource(db, { kind: "faq", title: "ETH withdrawn on Base", text: "Check your ETH balance on Base. Ethereum Mainnet shows a separate balance." }, T) : null;
  const procedure = c.procedure;
  const guide = procedure && addSource(db, { kind: "faq", title: "Public help guide", text: procedure.passage }, T);
  let now = T + 1_000;
  const messages = [{
    id: "1", revision: 1, author: "member", createdAt: new Date(T).toISOString(),
    text: (procedure?.question ?? (c.readOnlyFaq ? "I withdrew ETH on Base. My wallet shows no ETH on Ethereum Mainnet. What should I check?" : ASKED[c.asked])) + (c.path === "person" ? " I need to talk to a human." : ""),
  }];
  if (procedure?.priorClarification) {
    const previous = CRYPTO_REPLY_TRANSLATIONS.get(procedure.language)?.get(CRYPTO_CLARIFY_REPLY) ?? CRYPTO_CLARIFY_REPLY;
    const current = messages[0];
    messages.splice(0, 1,
      { ...current, text: procedure.language === "pt-BR" ? "como eu compro bitcoin?" : procedure.question },
      { ...current, id: "2", author: bot, text: previous },
      { ...current, id: "3" },
    );
  }
  const latest = () => messages.at(-1)!;
  const stale = (value: unknown) => {
    const bound = value as { id: string; revision: number } | undefined;
    return bound !== undefined && (bound.id !== latest().id || bound.revision !== latest().revision);
  };
  const calls: string[] = [], replies: string[] = [], drafts: string[] = [];
  const pages: Record<string, unknown>[] = [], tries: Record<string, unknown>[] = [];
  let reserved = 0, failPage = c.retry !== "none";
  const client = {
    async get(path: string) {
      if (!path.includes("managed/state"))
        return { status: 200, body: { messages: structuredClone(messages) } };
      return { status: 200, body: {
        prepaid: true, prepaidModel: "gpt-6.1-terra", sponsoredResearch: desk, readinessPolicy: "grounded_v1",
        enabled: true, onTeam: true, grant: true, thread, member: "member", state: "open",
        mode: "answers", caseSeq: 1, caseOpenedAt: T, caseMemberMessages: 1,
        ...(procedure ? { cryptoLanguage: { latest: { id: latest().id, revision: 1 }, code: procedure.language } } : {}),
        evidence: [], memberEvidence: [], storageGrant: null,
      } };
    },
    async post(path: string, body: Record<string, unknown>) {
      if (body.action === "handoff") {
        tries.push(body);
        if (stale(body.ifLatest)) return { status: 409, body: { reason: "stale" } };
        if (failPage) {
          failPage = false;
          return { status: 503, body: {} };
        }
        pages.push(body);
        return { status: 200, body: {} };
      }
      if (body.action === "draft") {
        drafts.push(String(body.text));
        return { status: 201, body: {} };
      }
      if (!path.endsWith("/messages")) return { status: 400, body: {} };
      if (stale(body.ifLatest)) return { status: 409, body: { reason: "stale" } };
      const managed = body.managed as { grounded: string; clarifying: boolean };
      const provenance = body.provenance as { sources: { id: string }[]; grounding: unknown };
      const checked = await verifyGroundedReceipt(db, {
        receipt: managed.grounded, grounding: provenance.grounding, thread, case: 1,
        latest: { id: latest().id, revision: latest().revision }, text: body.text,
        sourceIds: provenance.sources.map((source) => source.id), sources: provenance.sources,
        storageGrant: null,
      }, now);
      if (!checked.ok || checked.clarifying !== managed.clarifying)
        return { status: 409, body: { reason: "grounded-answer-unverified" } };
      const message = {
        id: String(messages.length + 1), revision: 1, author: bot,
        text: String(body.text), createdAt: new Date(now).toISOString(),
      };
      messages.push(message);
      replies.push(message.text);
      return { status: 201, body: { message } };
    },
  };
  const value = (text: string, extra: object = {}) => ({
    action: "reply", text, confidence: "high", handoffReason: null,
    sources: [], facts: [], claims: [], comparisons: [], summary: "", ...extra,
  });
  const answer = (body: object, id = model): ModelResult => ({ kind: "answer", model: id, usage: {}, value: body });
  const provider = async ({ system, user }: ModelRequest): Promise<ModelResult> => {
    const kind = system.startsWith("Classify an unresolved")
      ? "triage"
      : system.startsWith("You independently check") ? "verify" : "answer";
    if (procedure && system.includes("Decline the requested wallet operation")) {
      calls.push("operation");
      expect(JSON.parse(user).passages).toEqual([]);
      return answer(value(procedure.reply));
    }
    if (procedure && guide && system.includes("Answer the current how-to question directly")) {
      calls.push("revision");
      const { question, messages: history, passages, verifierNote } = JSON.parse(user);
      if (procedure.draft === "blocked-authorization")
        expect(verifierNote).toContain("Omit that action entirely");
      else expect(verifierNote).toBe(procedure.draft === "rejected" ? "The guide does not mention insurance." : undefined);
      expect(question).toBe(procedure.question);
      expect(history.some((turn: { role: string }) => turn.role === "ai")).toBe(Boolean(procedure.priorClarification));
      expect(system).toContain(`(${procedure.language})`);
      const source = passages.find((hit: { excerpt: string }) => hit.excerpt.includes(procedure.passage));
      expect(source).toBeDefined();
      if (procedure.revision === "detail-question") return answer(value(procedure.reply, { action: "clarify" }));
      if (procedure.revision === "unsourced-claim") return answer(value(procedure.reply));
      if (procedure.revision === "newer") messages.push({ ...latest(), id: "4", text: "I found it." });
      if (procedure.revision === "late") now += 91_000;
      return answer(value(procedure.revision === "unapproved-url" ? "Use https://unreviewed.example/btc" : procedure.reply,
        { sources: [procedure.revision === "unknown-source" ? "kb:unknown-1" : source.sourceId] }));
    }
    if (system.includes("using only the supplied FAQs")) {
      calls.push("faq");
      const passages = JSON.parse(user).passages as { sourceId: string; kind: string }[];
      expect(passages.every((p) => p.kind === "faq")).toBe(true);
      expect(user).not.toContain("sign anything");
      if (c.readOnlyFaq === "late-revision") now += 91_000;
      if (c.readOnlyFaq === "superseded") messages.push({
        id: "2", revision: 1, author: "member", text: "I found the balance.", createdAt: new Date(now).toISOString(),
      });
      const text = c.readOnlyFaq === "reject" ? "Please sign this message." : base ? "Check your ETH balance on Base." : SOURCES.other;
      return answer(value(text, { sources: [c.readOnlyFaq === "unknown-source" ? "unknown" : passages[0].sourceId] }));
    }
    calls.push(kind);
    if (kind === "triage") {
      if (c.verdict === "failed") return { kind: "failed", reason: "provider", usage: null };
      if (c.verdict === "throws") throw new Error("The provider failed.");
      if (c.verdict === "garbage") return answer(value("technical issue"));
      if (c.verdict === "wrong-model") return answer(value("technical"), DEFAULT_SUPPORT_MODEL);
      if (c.verdict === "low") return answer(value("technical", { confidence: "low" }));
      return answer(value(c.verdict));
    }
    if (kind === "verify" && procedure?.draft === "unsafe-incident") {
      expect(system).toContain("Reject a reply that omits the immediate protective action or suggests continuing contact");
      return answer(value("", { action: "handoff", confidence: "low", handoffReason: "safety" }));
    }
    if (kind === "verify")
      return (c.path === "rejected" || (procedure?.draft === "rejected" && !calls.includes("revision")) ||
        (procedure?.revision === "unsupported" && calls.includes("revision")))
        ? answer(value("", { action: "handoff", confidence: "low", handoffReason: "unsure", summary: "The guide does not mention insurance." }))
        : answer(value("Supported.", {
            sources: (JSON.parse(user).passages as { sourceId: string }[]).map((passage) => passage.sourceId),
          }));
    if (procedure && guide) {
      if (procedure.draft === "unsafe-incident")
        return answer(value("Give that person your public address instead.", { sources: [`kb:${guide.id}-1`] }));
      if (procedure.draft === "blocked-authorization")
        return answer(value("Use the wallet to approve payments.", { sources: [`kb:${guide.id}-1`] }));
      if (procedure.draft === "invalid-schema") return { kind: "failed", reason: "invalid-answer", usage: {} };
      if (procedure.draft === "unlisted-citation") return answer(value("An unverified first draft.", { sources: ["not-in-this-workspace"] }));
      if (procedure.draft === "provider-refusal") return { kind: "refusal", usage: {} };
      if (procedure.draft === "no-funding") return { kind: "failed", reason: "prepaid-admission-refused", usage: null, providerAttempted: false };
      if (procedure.draft === "handoff") return answer(value("", { action: "handoff", confidence: "low", handoffReason: "unsure" }));
      if (procedure.draft === "clarified") return answer(value(CRYPTO_CLARIFY_REPLY, { action: "clarify" }));
      return answer(value(procedure.draft === "rejected" ? "The preview includes insurance." : procedure.reply, { sources: [`kb:${guide.id}-1`] }));
    }
    if (base) return answer(value("You don’t need to connect your wallet or sign anything to check.", { sources: [`kb:${base.id}-1`] }));
    if (c.path === "failed") return { kind: "failed", reason: "provider", usage: null };
    if (c.path === "handoff")
      return answer(value("", { action: "handoff", confidence: "low", handoffReason: "bug" }));
    return answer(value(SOURCES[c.asked === "scam" ? "scam" : "other"], {
      sources: [`kb:${(c.asked === "scam" ? report : pending).id}-1`],
      ...(c.path === "partial" ? { action: "handoff", confidence: "medium", handoffReason: "bug" } : {}),
    }));
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
    // Every call goes through the room's own funded caller.
    prepaidModel: (_billing, sponsored) => {
      if (Boolean(sponsored) !== desk) throw new Error("The call used another funding path.");
      return provider;
    },
    now: () => now,
    templMeter: { reserve: async () => (reserved++, true), settle: async () => {}, release: async () => {} },
  };
  if (procedure) {
    const features = Object.fromEntries(WORKSPACE_FLAG_KEYS.map(key =>
      [key, key === "managedAgent" || (desk && key === "cryptoChatLanguage")])) as WorkspaceFeatures;
    deps.env = workspaceFeatureEnvFromValues(deps.env, features, room.slice(5));
  }
  addJobs(db, [{
    id: crypto.randomUUID(), kind: "member-message", thread, request: null, manager: bot,
    at: now - (c.path === "late" ? 91_000 : 500), due: now, attempts: 0,
  }]);
  const first = await runManagedJobs(deps);
  let again: JobOutcome[] = [];
  if (first[0] === "retry") {
    now += 30_000;
    if (c.retry === "newer")
      messages.push({
        id: String(messages.length + 1), revision: 1, author: "member",
        text: "It went through now.", createdAt: new Date(now).toISOString(),
      });
    again = await runManagedJobs(deps);
  }
  db.raw.close();
  return { first, again, calls, replies, drafts, pages, tries, reserved };
}

/** The desk's contract: one classification only where a page could follow,
 * a page only for a technical verdict, and a reply for everything else. */

  it("answers documented purchases and recovers a repeated educational clarification in the current language", async () => {
    const generic = { question: "como eu compro bitcoin?", passage: "A prévia mostra o valor e as taxas antes da compra.",
      reply: "Confira o valor e as taxas na prévia da compra.", language: "pt-BR", draft: "handoff" } as const;
    const pix = { ...generic, question: "eu só quero comprar bitcoin com pix", priorClarification: true, draft: "clarified",
      passage: "A prévia da compra em reais mostra o valor e as taxas para Pix.", reply: "Com Pix, confira o valor em reais e as taxas na prévia." } as const;
    const english = { question: "How can I pay for BTC with Brazilian reais?", passage: pix.passage,
      reply: "The order preview shows the amount in reais and the fees for Pix.", language: "en", draft: "rejected" } as const;
    const education = { question: "Comment marche la garde personnelle ?", passage: "In self-custody, you keep your wallet keys yourself.",
      reply: "Vous gardez vous-même les clés de votre portefeuille.", language: "fr", draft: "handoff", priorClarification: true } as const;
    const seed = { path: "answered", retry: "none", asked: "other" } as const;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    try {
      for (const procedure of [generic, pix, english, education, { ...generic, draft: "answered" as const },
        { ...generic, draft: "invalid-schema" as const }, { ...pix, draft: "unlisted-citation" as const }]) {
        const run = await runDesk(room, { ...seed, procedure, verdict: procedure === education ? "howto" : "purchase" });
        expect(run.first, procedure.question).toEqual(["answered"]);
        expect(run.replies).toEqual([procedure.reply]);
        expect(run.calls).toEqual(procedure.draft === "answered" ? ["answer", "verify"] :
          ["answer", ...(procedure.draft === "rejected" ? ["verify"] : []), "triage", "revision", "verify"]);
        expect(run.reserved).toBe(run.calls.length);
        expect(run.pages).toHaveLength(0);
      }
      for (const revision of ["unapproved-url", "unknown-source", "unsupported", "late", "newer"] as const) {
        const run = await runDesk(room, { ...seed, procedure: { ...pix, revision }, verdict: "purchase" });
        expect(run.replies).not.toContain(pix.reply);
        expect(run.replies.join("")).not.toContain("unreviewed");
        expect(run.calls.filter(call => call === "revision")).toHaveLength(1);
        expect(run.calls.includes("verify")).toBe(revision === "unsupported" || revision === "newer");
        expect(run.pages).toHaveLength(0);
      }
      for (const verdict of ["scam", "investing", "other", "failed"] as const) {
        const run = await runDesk(room, { ...seed, procedure: { ...pix, draft: "handoff" }, verdict });
        expect(run.calls).toEqual(["answer", "triage"]);
        expect(run.pages).toHaveLength(0);
      }
      for (const draft of ["provider-refusal", "no-funding"] as const) {
        const run = await runDesk(room, { ...seed, procedure: { ...pix, draft }, verdict: "purchase" });
        expect(run.calls).toEqual(["answer", "triage"]);
        expect(run.replies).not.toContain(pix.reply);
      }
      const firstEducation = await runDesk(room, { ...seed, procedure: { ...education, priorClarification: false }, verdict: "howto" });
      expect(firstEducation.calls).toEqual(["answer", "triage", "revision", "verify"]);
      expect(firstEducation.replies).toEqual([education.reply]);
      const fee = { question: "Por que preciso de SOL para USDC?", passage: "On Solana, the network fee is charged in SOL.",
        reply: "Na Solana, a taxa de rede é cobrada em SOL.", language: "pt-BR", draft: "blocked-authorization" } as const;
      const revised = await runDesk(room, { ...seed, procedure: fee, verdict: "howto" });
      expect(revised.calls).toEqual(["answer", "triage", "revision", "verify"]);
      expect(revised.replies).toEqual([fee.reply]);
      const unsupported = await runDesk(room, { ...seed, procedure: { ...fee, revision: "unsupported" }, verdict: "howto" });
      expect(unsupported.replies).not.toContain(fee.reply);
      const missing = { ...generic, question: "Esse recurso existe no meu dispositivo?", reply: "Você tem uma descrição pública desse recurso?", revision: "detail-question" as const };
      const detail = await runDesk(room, { ...seed, procedure: missing, verdict: "howto" });
      expect(detail.replies).toEqual([missing.reply]);
      expect(detail.calls).toEqual(["answer", "triage", "revision", "verify"]);
      const ungrounded = await runDesk(room, { ...seed, procedure: { ...missing, revision: "unsourced-claim", reply: "O dispositivo aceita a operação." }, verdict: "howto" });
      expect(ungrounded.replies).not.toContain("O dispositivo aceita a operação.");
      const request = { ...generic, question: "Please sign for me.", reply: "I have no access to your wallet.", language: "en" as const };
      const declined = await runDesk(room, { ...seed, procedure: request, verdict: "operation" });
      expect(declined.calls).toEqual(["answer", "triage", "verify"]);
      expect(declined.replies).toEqual([CRYPTO_READ_ONLY_REPLY]);
      const localized = await runDesk(room, { ...seed, procedure: { ...request, language: "pt-BR", reply: "Não tenho acesso à sua carteira." }, verdict: "operation" });
      expect(localized.calls).toEqual(["answer", "triage", "operation", "verify"]);
      expect(localized.replies).toEqual(["Não tenho acesso à sua carteira."]);
      expect(declined.pages).toEqual([]);
      const incident = { ...generic, question: "Uma pessoa me pediu as palavras de recuperação pelo Telegram.", draft: "unsafe-incident" as const };
      const protectedReply = await runDesk(room, { ...seed, procedure: incident, verdict: "scam" });
      expect(protectedReply.calls).toEqual(["answer", "verify", "triage"]);
      expect(protectedReply.replies).toEqual([CRYPTO_REPLY_TRANSLATIONS.get("pt-BR")?.get(CRYPTO_SCAM_REPLY)]);
      expect(protectedReply.pages).toEqual([]);
      const neighbor = await runDesk(NORMAL_ROOM, { ...seed, procedure: generic, verdict: "purchase" });
      expect(neighbor.calls).toEqual(["answer"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
