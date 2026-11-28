import { CRYPTO_PROVIDER_PAGES } from "@templ/chat/crypto-help-links";
import { cryptoLinkProblem } from "../src/crypto-links";
import { describe, expect, vi } from "vitest";
import {
  CRYPTO_SUPPORT_MODEL,
  CRYPTO_SUPPORT_WORKSPACE,
  DEFAULT_SUPPORT_MODEL,
} from "@templ/chat/support-models";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { base58Encode } from "@templ/chat/solana";
import { WORKSPACE_FLAG_KEYS, type WorkspaceFeatures } from "@templ/chat/workspace-flags";
import { knowledgeTestDb } from "./knowledge-sqlite";
import { ensureSchema, writeMeta } from "../src/support-knowledge-schema";
import { addSource } from "../src/support-knowledge-kb";
import { addJobs } from "../src/managed-agent/store";
import { runManagedJobs, type JobOutcome, type RunnerDeps } from "../src/managed-agent/runner";
import { verifyGroundedReceipt } from "../src/managed-agent/grounded";
import { chainLookupMatches, cryptoLookupState } from "../src/managed-agent/room";
import { CRYPTO_CLARIFY_REPLY } from "../src/managed-agent/crypto-triage";
import {
  CRYPTO_CHAIN_LIMITS,
  CRYPTO_LOOKUP_REPLIES,
  reserveChainRead,
  type CryptoChainReader,
  type CryptoChainReading,
  type CryptoChainTarget,
} from "../src/managed-agent/crypto-chain-facts";
import { hideAmbiguousPayload } from "../src/support-secret-sinks";
import { workspaceFeatureEnvFromValues } from "../src/workspace-flags";
import type { TeamConversationRecord } from "../src/team-conversations";
import type { ModelRequest, ModelResult } from "../src/managed-agent/anthropic";

// The self-hosted desk is unconfigured until the operator chooses a workspace.
vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000001",
}));

const DESK = "room:" + CRYPTO_SUPPORT_WORKSPACE;
const OTHER = "room:01990000-0000-7000-8000-00000000000b";
const thread = `tc-${"e".repeat(32)}`;
const member = "account:desk-visitor" as ChatPrincipalId;
const bot = ("0x" + "3".repeat(40)) as ChatPrincipalId;
const T = Date.UTC(2026, 10, 27, 12);
const BECH32 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const UNIT = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL" } as const;
const NAME = { bitcoin: "Bitcoin", ethereum: "Ethereum", solana: "Solana" } as const;
type Chain = keyof typeof UNIT;

const SCENARIOS = [
  "verified-address", "pasted-address", "pasted-transaction", "follow-up",
  "choose-wallet", "need-address", "need-explorer",
  "unavailable", "not-found", "refused", "timeout", "busy",
  "unlinked", "revoked", "newer", "edited", "repeats-target", "unsupported-figure",
  "flag-off", "other-room",
] as const;
type Scenario = (typeof SCENARIOS)[number];

const hex = (draw: Rng, length: number) =>
  draw.pick([..."123456789abcdef"]) + draw.text("0123456789abcdef", length - 1);
const base58 = (draw: Rng, bytes: number) =>
  base58Encode(Uint8Array.from({ length: bytes }, () => draw.int(1, 255)));
function address(draw: Rng, chain: Chain) {
  if (chain === "ethereum") return "0x" + hex(draw, 40);
  if (chain === "solana") return base58(draw, 32);
  return BECH32;
}
function permalink(draw: Rng, chain: Chain) {
  if (chain === "ethereum") {
    const value = "0x" + hex(draw, 64);
    return { value, url: `https://${draw.pick(["etherscan.io", "eth.blockscout.com"])}/tx/${value}` };
  }
  if (chain === "bitcoin") {
    const value = hex(draw, 64);
    return { value, url: `https://${draw.pick(["mempool.space", "blockstream.info"])}/tx/${value}` };
  }
  const value = base58(draw, 64);
  return { value, url: `https://${draw.pick(["solscan.io", "explorer.solana.com"])}/tx/${value}` };
}
function wallets(list: { chain: Chain; address: string }[]) {
  const widget = list.filter((wallet) => wallet.chain !== "bitcoin").map((wallet) =>
    wallet.chain === "ethereum"
      ? { network: "evm", address: wallet.address, chainId: 1 }
      : { network: "solana", address: wallet.address });
  const bitcoin = list.filter((wallet) => wallet.chain === "bitcoin").map((wallet) => wallet.address);
  return {
    ...(widget.length ? { sharedVerifiedWallet: widget[0], sharedVerifiedWallets: widget } : {}),
    ...(bitcoin.length ? { sharedVerifiedBitcoinWallets: bitcoin } : {}),
  };
}
type Message = { id: string; revision: number; author: string; text: string; createdAt: string };
const ask = (id: number, text: string, author: string = member): Message =>
  ({ id: String(id), revision: 1, author, text, createdAt: new Date(T + id).toISOString() });
const answer = (body: object, model: string): ModelResult => ({ kind: "answer", model, usage: {}, value: body });
const value = (text: string, extra: object = {}) => ({
  action: "reply", text, confidence: "high", handoffReason: null,
  sources: [], facts: [], claims: [], comparisons: [], summary: "", ...extra,
});

/** One desk member message through the real runner, the room's own target
 * selection and its write-time recheck. The fake room serves the bot view and
 * admits a managed reply only with a current receipt. Nothing reaches a network. */
async function runDesk(draw: Rng, scenario: Scenario) {
  const desk = scenario !== "other-room";
  const room = desk ? DESK : OTHER;
  const model = desk ? CRYPTO_SUPPORT_MODEL : DEFAULT_SUPPORT_MODEL;
  // The room reads its audited flag on every request; the runner keeps its run's snapshot.
  let flagOn = scenario !== "flag-off";
  const chain = draw.pick(["bitcoin", "ethereum", "solana"] as const);
  const db = knowledgeTestDb();
  ensureSchema(db, T);
  writeMeta(db, "room", room);
  const faq = addSource(db, { kind: "faq", title: "Wallet activity", text: "Share the public address and the network you used." }, T);
  const sourcesBefore = db.sql.exec("SELECT COUNT(*) AS n FROM kb_sources").toArray()[0].n;

  let verified: { chain: Chain; address: string }[] = [];
  let target: string | null = null;
  const messages: Message[] = [];
  if (scenario === "pasted-address" || scenario === "repeats-target") {
    target = address(draw, chain);
    messages.push(ask(1, `What arrived at ${target}? It is on ${NAME[chain]}.`));
  } else if (scenario === "pasted-transaction") {
    const link = permalink(draw, chain);
    target = link.value;
    messages.push(ask(1, draw.pick([`Did this go through? ${link.url}`, `${link.url} still shows nothing in my wallet.`])));
  } else if (scenario === "follow-up") {
    target = address(draw, "ethereum");
    messages.push(
      ask(1, `What arrived at ${target}?`),
      ask(2, CRYPTO_LOOKUP_REPLIES["choose-network"], bot),
      ask(3, draw.pick(["Ethereum", "on ethereum", "Ethereum mainnet"])),
    );
  } else if (scenario === "choose-wallet") {
    verified = draw.shuffle(["bitcoin", "ethereum", "solana"] as const).slice(0, 2).map((item) => ({ chain: item, address: address(draw, item) }));
    messages.push(ask(1, "Can you check my wallet activity?"));
  } else if (scenario === "need-address") {
    messages.push(ask(1, draw.pick(["Can you check my wallet activity?", "Check my wallet balance please."])));
  } else if (scenario === "need-explorer") {
    messages.push(ask(1, `Why is ${draw.chance(0.5) ? "0x" : ""}${hex(draw, 64)} still pending?`));
  } else {
    const selected: Chain = scenario === "unsupported-figure" ? "ethereum" : chain;
    verified = [{ chain: selected, address: address(draw, selected) }];
    target = verified[0].address;
    messages.push(ask(1, "Can you check my wallet activity?"));
  }
  const record = {
    id: thread, room, member, formerMembers: [], ...wallets(verified),
  } as unknown as TeamConversationRecord;
  const memberMessages = () => messages.filter((message) => message.author === member).length;
  const storage = {
    list: async ({ limit }: { limit?: number }) => new Map(
      [...messages].reverse().slice(0, limit).map((message) =>
        [`channel-message:${thread}:${message.id.padStart(16, "0")}`, structuredClone(message)]),
    ),
  } as never;
  const lookupNow = () => desk && flagOn
    ? cryptoLookupState(storage, record, { openedAt: T, memberMessages: memberMessages() })
    : Promise.resolve(null);
  if (scenario === "busy") {
    const other = draw.chance(0.5);
    for (let i = 0; i < (other ? CRYPTO_CHAIN_LIMITS.perHour : CRYPTO_CHAIN_LIMITS.perCase); i++)
      await reserveChainRead(db, other ? `tc-${String(i).padStart(32, "0")}` : thread, 1, T);
  }

  const now = T + 1_000;
  const calls: { kind: string; system: string; user: string }[] = [];
  const reads: { target: CryptoChainTarget; options: Record<string, unknown> }[] = [];
  const replies: string[] = [], refused: Record<string, unknown>[] = [], posts: string[] = [];
  const evidence: Record<string, unknown>[] = [];
  let newerSent = false;
  const client = {
    async get(path: string) {
      if (path.includes("managed/state")) {
        const lookup = await lookupNow();
        // Another room's state can never start a read, even if it names a target.
        const forged = !desk && { latest: { id: "1", revision: 1 }, selection: { kind: "lookup", chain: "ethereum", subject: "address", from: "pasted", target: "0x" + "1".repeat(40) } };
        return { status: 200, body: hideAmbiguousPayload({
          prepaid: true, prepaidModel: DEFAULT_SUPPORT_MODEL, sponsoredResearch: desk, readinessPolicy: "grounded_v1",
          enabled: true, onTeam: true, grant: true, thread, member, state: "open", mode: "answers",
          caseSeq: 1, caseOpenedAt: T, caseMemberMessages: memberMessages(), evidence: [], memberEvidence: [], storageGrant: null,
          ...(lookup ? { cryptoLookup: lookup } : forged ? { cryptoLookup: forged } : {}),
        }) };
      }
      if ((scenario === "newer" || scenario === "edited") && !newerSent) {
        newerSent = true;
        if (scenario === "newer") messages.push(ask(messages.length + 1, "Any news?"));
        else messages[messages.length - 1] = { ...messages.at(-1)!, revision: 2, text: "Can you check my wallet activity today?" };
      }
      return { status: 200, body: hideAmbiguousPayload({ messages: structuredClone(messages) }) };
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push(path.endsWith("/resolve") ? "resolve" : String(body.action ?? "message"));
      if (body.action === "handoff" || body.action === "draft") return { status: 201, body: {} };
      if (body.action === "evidence") {
        const rows = body.rows as Record<string, unknown>[];
        evidence.push(...rows);
        return { status: 201, body: { evidence: rows.map((_, index) => ({ n: index + 1 })) } };
      }
      if (!path.endsWith("/messages")) return { status: 400, body: {} };
      const latest = messages.at(-1)!;
      const ifLatest = body.ifLatest as { id: string; revision: number };
      if (ifLatest.id !== latest.id || ifLatest.revision !== latest.revision)
        return { status: 409, body: { reason: "stale" } };
      const managed = body.managed as { grounded: string; clarifying: boolean };
      const provenance = body.provenance as { sources: { id: string }[]; grounding: unknown };
      const checked = await verifyGroundedReceipt(db, {
        receipt: managed.grounded, grounding: provenance.grounding, thread, case: 1,
        latest: { id: latest.id, revision: latest.revision }, text: body.text,
        sourceIds: provenance.sources.map((source) => source.id), sources: provenance.sources, storageGrant: null,
      }, now) as { ok: boolean; clarifying?: boolean; chain?: { from: string; targetSha256: string } };
      const current = checked.chain
        ? desk && flagOn && await chainLookupMatches(await lookupNow(), thread, 1, latest.id, checked.chain)
        : true;
      if (!checked.ok || checked.clarifying !== managed.clarifying || !current) {
        refused.push(body);
        return { status: 409, body: { reason: "grounded-answer-unverified" } };
      }
      messages.push({ id: String(messages.length + 1), revision: 1, author: bot, text: String(body.text), createdAt: new Date(now).toISOString() });
      replies.push(String(body.text));
      return { status: 201, body: { message: messages.at(-1) } };
    },
  };
  const figure = `0.${draw.int(1, 9)}${draw.int(1, 9)}`;
  const counterparty = "0x" + hex(draw, 40);
  const provider = async ({ system, user }: ModelRequest): Promise<ModelResult> => {
    const kind = system.startsWith("Classify an unresolved") ? "triage"
      : system.startsWith("You independently check") ? "verify"
        : system.includes("using only the supplied FAQs") ? "faq" : "answer";
    calls.push({ kind, system, user });
    if (kind === "triage") return answer(value("other"), model);
    if (kind === "faq") return { kind: "failed", reason: "provider", usage: null };
    if (kind === "verify")
      return answer(value("Supported.", {
        sources: (JSON.parse(user).passages as { sourceId: string }[]).map((passage) => passage.sourceId),
      }), model);
    const facts = (JSON.parse(user).networkFacts as { sourceId: string }[] | undefined)?.[0];
    if (!facts) return answer(value("Share the public address and the network you used.", { sources: [`kb:${faq.id}-1`] }), model);
    const text = scenario === "repeats-target" ? `${target} received ${figure} ${UNIT[chain]}.`
      : scenario === "unsupported-figure" ? "The read shows 7.5 ETH moved."
        : `The network read shows ${figure} ${UNIT[chain]} moved. It was read at 12:00 UTC.`;
    return answer(value(text, {
      action: draw.pick(["reply", "resolve"]),
      sources: draw.chance(0.5) ? [facts.sourceId] : [facts.sourceId, `kb:${faq.id}-1`],
    }), model);
  };
  const observed = {
    bitcoin: ["mempool.space", "blockstream.info"], ethereum: ["publicnode", "drpc"], solana: ["publicnode-solana", "solana-foundation"],
  } as const;
  const providerCount = draw.int(1, 2);
  const chainRead: CryptoChainReader = async (read, options) => {
    reads.push({ target: read, options: { ...options } });
    if (scenario === "revoked") flagOn = false;
    if (scenario === "unlinked") {
      delete record.sharedVerifiedWallet;
      delete record.sharedVerifiedWallets;
      delete record.sharedVerifiedBitcoinWallets;
    }
    if (scenario === "timeout") return new Promise<CryptoChainReading>(() => {});
    if (scenario === "unavailable" || scenario === "not-found" || scenario === "refused")
      return { ok: false, reason: scenario };
    return {
      ok: true,
      observedAt: now,
      answeredProviders: observed[read.chain].slice(0, providerCount),
      facts: [
        { label: "Status", value: draw.pick(["confirmed", "succeeded"]) },
        { label: "Transaction", value: `in, ${new Date(now).toISOString()}, ${figure} ${UNIT[chain]}` },
        { label: "From", value: counterparty },
      ],
    };
  };
  const features = Object.fromEntries(WORKSPACE_FLAG_KEYS.map((key) => [key, false])) as WorkspaceFeatures;
  features.managedAgent = true;
  features.cryptoDeskChainFacts = flagOn;
  const deps: RunnerDeps = {
    db, room, principal: bot,
    env: workspaceFeatureEnvFromValues({
      MANAGED_AGENT_ENABLED: "true", MANAGED_AGENT_SPEND_CAP_USD_CENTS: "10000", MANAGED_AGENT_GATEWAY_ID: "templ-support",
      AI: { run: async () => ({}) } as unknown as Pick<Ai, "run">,
    }, features, room.slice(5)),
    roomClient: () => client,
    model: null,
    prepaidModel: (_billing, sponsored) => {
      if (Boolean(sponsored) !== desk) throw new Error("The call used another funding path.");
      return provider;
    },
    // A misrouted reader in another workspace must still never run.
    chainRead,
    now: () => now,
    templMeter: { reserve: async () => true, settle: async () => {}, release: async () => {} },
  };
  const timeout = scenario === "timeout";
  addJobs(db, [{
    id: crypto.randomUUID(), kind: "member-message", thread, request: null, manager: bot,
    at: now - (timeout ? 90_000 - CRYPTO_CHAIN_LIMITS.answerReserveMs - 30 : 500), due: now, attempts: 0,
  }]);
  const started = Date.now();
  const first: JobOutcome[] = await runManagedJobs(deps);
  const elapsed = Date.now() - started;
  const sourcesAfter = db.sql.exec("SELECT COUNT(*) AS n FROM kb_sources").toArray()[0].n;
  db.raw.close();
  return { chain, providers: reads.length ? observed[reads[0].target.chain].slice(0, providerCount) : [], target, verified, first, elapsed, calls, reads, replies, refused, posts, evidence, sourcesBefore, sourcesAfter, counterparty, figure };
}

describe("crypto desk network facts", () => {
  simulate("reads one selected case target and grounds only fresh facts for that turn", async (draw) => {
    // Desk research may ask for its fixed indexes. No request may carry a case target.
    const network = vi.fn(async (_input: RequestInfo | URL) => {
      throw new Error("The simulation has no network.");
    });
    vi.stubGlobal("fetch", network);
    try {
      for (const scenario of draw.shuffle(SCENARIOS)) {
        const requested = network.mock.calls.length;
        const run = await runDesk(draw, scenario);
        const label = JSON.stringify({ scenario, chain: run.chain });
        for (const [input] of network.mock.calls.slice(requested))
          for (const value of [run.target, ...run.verified.map((wallet) => wallet.address)])
            if (value) expect(String(input).toLowerCase(), label).not.toContain(value.toLowerCase());
        const answered = ["verified-address", "pasted-address", "pasted-transaction", "follow-up"].includes(scenario);
        const fixed: Partial<Record<Scenario, string>> = {
          "choose-wallet": CRYPTO_LOOKUP_REPLIES["choose-wallet"],
          "need-address": CRYPTO_LOOKUP_REPLIES["need-address"],
          "need-explorer": CRYPTO_LOOKUP_REPLIES["need-explorer"],
          unavailable: CRYPTO_LOOKUP_REPLIES.unavailable,
          "not-found": CRYPTO_LOOKUP_REPLIES["not-found"],
          refused: CRYPTO_LOOKUP_REPLIES[run.verified.length ? "need-address" : "need-explorer"],
          timeout: CRYPTO_LOOKUP_REPLIES.unavailable,
          busy: CRYPTO_LOOKUP_REPLIES.busy,
        };

        // The reader receives the selected identifier and nothing about the case.
        const readsExpected = answered || ["unavailable", "not-found", "refused", "timeout", "unlinked", "revoked", "repeats-target", "unsupported-figure"].includes(scenario);
        expect(run.reads.length, label).toBe(readsExpected ? 1 : 0);
        for (const { target, options } of run.reads) {
          expect(Object.keys(target).sort(), label).toEqual(
            target.subject === "transaction" && target.chain !== "solana"
              ? ["chain", "permalink", "subject", "value"] : ["chain", "subject", "value"]);
          expect(target.value, label).toBe(run.target);
          expect(Object.keys(options).sort(), label).toEqual(["deadlineMs", "signal"]);
          expect(options.deadlineMs as number, label).toBeLessThanOrEqual(CRYPTO_CHAIN_LIMITS.readMs);
          if (target.permalink) expect(target.permalink.toLowerCase(), label).toContain(target.value.toLowerCase());
        }

        // The model sees shortened derived facts, never the target or a full counterparty.
        for (const call of run.calls) {
          if (run.target) expect(call.user.toLowerCase(), label).not.toContain(run.target.toLowerCase());
          for (const wallet of run.verified) expect(call.user, label).not.toContain(wallet.address);
          expect(call.user, label).not.toContain(run.counterparty);
        }
        const withFacts = run.calls.filter((call) => call.kind === "answer" && call.user.includes("networkFacts"));
        expect(withFacts.length, label).toBe(answered || ["unlinked", "revoked", "repeats-target", "unsupported-figure"].includes(scenario) ? 1 : 0);

        if (answered) {
          expect(run.first, label).toEqual(["answered"]);
          // The figure cites its new evidence row; the read time is not a figure.
          const pages = run.providers.map(provider => CRYPTO_PROVIDER_PAGES[provider]);
          const sourceLines = pages.map(page => `[${page.label}](${page.url})`).join("\n");
          expect(run.replies, label).toEqual([`The network read shows ${run.figure}[ev:1] ${UNIT[run.chain]} moved. It was read at 12:00 UTC.\n\nSources:\n${sourceLines}`]);
          for (const call of withFacts) {
            const networkFacts = JSON.parse(call.user).networkFacts;
            for (const page of pages) expect(JSON.stringify(networkFacts), label).not.toContain(page.url);
          }
          expect(cryptoLinkProblem(run.replies[0], 7, true), label).toBeNull();
          expect(cryptoLinkProblem(run.replies[0]), label).toBe("unreviewed link");
          // Chain figures become team evidence for this case, with the read time and no link.
          expect(run.evidence, label).toHaveLength(1);
          expect(run.evidence[0], label).toMatchObject({ source: "chain", product: { key: "network-read" }, value: { text: run.figure } });
          expect(run.evidence[0], label).not.toHaveProperty("link");
          // A chain answer keeps the case open, even when the model chose resolve.
          expect(run.posts, label).not.toContain("resolve");
        } else if (fixed[scenario]) {
          expect(run.first, label).toEqual(["clarified"]);
          expect(run.replies, label).toEqual([fixed[scenario]]);
          // Clarifications and honest failures use no model call.
          expect(run.calls, label).toEqual([]);
          if (scenario === "timeout") expect(run.elapsed, label).toBeLessThan(2_000);
        } else if (scenario === "unlinked" || scenario === "revoked") {
          // The wallet left the case or the flag ended before the reply: the room refuses it.
          expect(run.refused, label).toHaveLength(1);
          expect(run.replies, label).toEqual([CRYPTO_CLARIFY_REPLY]);
        } else if (scenario === "repeats-target" || scenario === "unsupported-figure") {
          expect(run.refused, label).toEqual([]);
          expect(run.replies, label).toEqual([CRYPTO_CLARIFY_REPLY]);
          expect(run.evidence, label).toEqual([]);
        } else if (scenario === "newer" || scenario === "edited") {
          // A target chosen for an older message or revision is never read for a newer one.
          expect(run.first, label).toEqual(["retry"]);
          expect(run.calls, label).toEqual([]);
        } else {
          // Off flags and other workspaces keep their normal answer.
          expect(run.first, label).toEqual(["answered"]);
          expect(run.replies, label).toEqual(["Share the public address and the network you used."]);
        }
        // Facts stay out of every knowledge source.
        expect(run.sourcesAfter, label).toBe(run.sourcesBefore);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }, { timeout: 60_000 });
});
