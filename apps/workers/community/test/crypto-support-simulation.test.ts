import { expect, vi } from "vitest";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_SUPPORT_WORKSPACE } from "../src/crypto-support";
import { researchCryptoDocs } from "../src/crypto-research";
import { ensureSchema, readMeta } from "../src/support-knowledge-schema";
import { knowledgeTestDb } from "./knowledge-sqlite";

// Self-hosting starts without a sponsored desk. Give this isolated simulation
// its own workspace and replace every DNS and HTTP call with its local fixture.
vi.mock("../src/crypto-support", () => ({
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
