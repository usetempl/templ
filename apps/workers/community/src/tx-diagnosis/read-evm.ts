import {
  codeKind,
  evmReceiptFact,
  evmReceiptView,
  evmTxFact,
  evmTxView,
  type EvmReceiptView,
  type EvmTxView,
} from "@templ/chat/diagnosis/evm-normalize";
import type {
  AgreedBlock,
  EvmAbiErrorItem,
  EvmCodeFact,
  EvmDiagnosisInput,
  EvmFound,
  EvmMethodFact,
  EvmNetwork,
  EvmPreviousSighting,
  EvmProbe,
  EvmRevertReplay,
  EvmTokenFact,
  Hex,
  ProtocolProfileFacts,
  ProviderRole,
  ProviderObservations,
  DiagnosisDisagreement,
  Quantity,
  VerifiedAbiSource,
} from "@templ/chat/diagnosis/types";
import {
  agreed,
  agreedValue,
  observePair,
  replayOutcome,
  type ReadProblem,
  type ReadFailure,
} from "./agree";
import { DIAGNOSIS_READ_LIMITS } from "./budgets";
import type { DiagnosisChain } from "./chains";
import {
  agreedBlockByNumber,
  agreedLatestHead,
  agreedTagHead,
  chainIdMatches,
  parentNumber,
} from "./heads";
import type { DiagnosisRunPlan } from "./plan";
import type { DiagnosisProfileSource } from "./profile";
import type { DiagnosisRpc, Pair } from "./rpc";

/** Optional enrichment from the kept decoder core and token reads. Each one
 * may fail on its own; the check then goes on without that fact. */
export type EvmEnrichment = {
  method?(input: {
    chain: DiagnosisChain;
    rpc: DiagnosisRpc;
    tx: EvmTxView;
    block: AgreedBlock;
  }): Promise<EvmMethodFact | null>;
  errorAbi?(input: {
    chain: DiagnosisChain;
    to: Hex;
  }): Promise<{ source: VerifiedAbiSource; items: EvmAbiErrorItem[] } | null>;
  tokens?(input: {
    chain: DiagnosisChain;
    rpc: DiagnosisRpc;
    block: AgreedBlock;
    receipt: EvmReceiptView;
    profile: ProtocolProfileFacts | null;
  }): Promise<EvmTokenFact[]>;
};

export type EvmReadDeps = {
  /** Enabled chains with their two-provider client, in probe order. */
  rpcs: ReadonlyMap<EvmNetwork, { chain: DiagnosisChain; rpc: DiagnosisRpc }>;
  profile: DiagnosisProfileSource;
  enrich?: EvmEnrichment;
};

const TX_VERDICT = [
  "hash",
  "from",
  "to",
  "value",
  "input",
  "nonce",
  "blockHash",
  "blockNumber",
  "transactionIndex",
  "gas",
] as const;
const TX_DISPLAY = [
  "type",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "chainId",
] as const;
const RECEIPT_VERDICT = [
  "transactionHash",
  "from",
  "to",
  "contractAddress",
  "status",
  "blockHash",
  "blockNumber",
  "transactionIndex",
  "gasUsed",
  "logs",
  "logsTotal",
  "logsTruncated",
] as const;
const RECEIPT_DISPLAY = [
  "cumulativeGasUsed",
  "effectiveGasPrice",
  "type",
] as const;

type Sighting =
  | {
      outcome: "found-mined";
      head: AgreedBlock;
      tx: EvmTxView;
      receipt: EvmReceiptView;
      confirmedNonceNow: EvmPreviousSighting["confirmedNonceNow"];
    }
  | {
      outcome: "found-pending";
      head: AgreedBlock;
      tx: EvmTxView;
      seenBy: ProviderRole[];
      confirmedNonceNow: EvmPreviousSighting["confirmedNonceNow"];
    }
  | {
      outcome: "not-found";
      head: AgreedBlock;
      confirmedNonceNow: EvmPreviousSighting["confirmedNonceNow"];
    }
  | ({ outcome: "unavailable" } & ReadProblem);

const pinned = (block: AgreedBlock) => ({
  blockHash: block.hash,
  requireCanonical: true,
});
const quantity = (raw: unknown): Quantity => {
  if (
    typeof raw !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(raw)
  )
    throw new Error("quantity");
  return raw.toLowerCase() as Quantity;
};
const above = (a: Quantity, b: Quantity) => BigInt(a) > BigInt(b);

async function readTxAndReceipt(rpc: DiagnosisRpc, hash: Hex) {
  const [tx, rc] = await Promise.all([
    rpc.both("eth_getTransactionByHash", [hash]),
    rpc.both("eth_getTransactionReceipt", [hash], {
      maxBytes: DIAGNOSIS_READ_LIMITS.receiptMaxBytes,
    }),
  ]);
  return { tx, rc };
}

/** Pending when the receipt is null on both and the transaction is present
 * on one or both, not mined, and equal where both have it. */
function pendingCopy(
  tx: Pair,
): { tx: EvmTxView; seenBy: ProviderRole[] } | null {
  const views: (EvmTxView | null)[] = [];
  for (const side of tx) {
    if (
      side.failed ||
      side.error ||
      side.result === null ||
      side.result === undefined
    ) {
      views.push(null);
      continue;
    }
    try {
      views.push(evmTxView(side.result));
    } catch {
      return null;
    }
  }
  const present = views
    .map((view, index) => ({
      view,
      role: (index === 0 ? "primary" : "confirmation") as ProviderRole,
    }))
    .filter((item) => item.view !== null);
  if (!present.length) return null;
  if (present.some((item) => item.view!.blockNumber !== null)) return null;
  if (present.length === 2) {
    const read = agreed(tx, evmTxView, TX_VERDICT, TX_DISPLAY);
    if (read.kind !== "agreed") return null;
    return { tx: read.value, seenBy: ["primary", "confirmation"] };
  }
  return { tx: present[0].view!, seenBy: [present[0].role] };
}

async function probeNetwork(
  chain: DiagnosisChain,
  rpc: DiagnosisRpc,
  plan: DiagnosisRunPlan,
  hash: Hex,
): Promise<Sighting> {
  const id = await chainIdMatches(rpc, chain.id);
  if (!id.ok) return { outcome: "unavailable", reason: id.reason };
  let head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
  if (!head.ok)
    return {
      outcome: "unavailable",
      reason: head.reason,
      observations: head.observations,
    };
  let confirmedNonceNow: EvmPreviousSighting["confirmedNonceNow"] = null;
  if (plan.previous && plan.previous.network === chain.network) {
    // Read before this network's probe head, so "replaced" is decided on a
    // nonce that was already final when the probe looked.
    const nonce = agreedValue(
      await rpc.both("eth_getTransactionCount", [
        plan.previous.from,
        pinned(head.block),
      ]),
      quantity,
    );
    if (nonce.kind === "agreed")
      confirmedNonceNow = { value: nonce.value, atBlock: head.block.number };
    head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
    if (!head.ok)
      return {
        outcome: "unavailable",
        reason: head.reason,
        observations: head.observations,
      };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const { tx, rc } = await readTxAndReceipt(rpc, hash);
    const txRead = agreed(tx, evmTxView, TX_VERDICT, TX_DISPLAY);
    const rcRead = agreed(rc, evmReceiptView, RECEIPT_VERDICT, RECEIPT_DISPLAY);
    if (txRead.kind === "unavailable" && txRead.reason === "budget")
      return { outcome: "unavailable", reason: "budget" };
    if (rcRead.kind === "unavailable" && rcRead.reason === "budget")
      return { outcome: "unavailable", reason: "budget" };
    if (txRead.kind === "both-null" && rcRead.kind === "both-null")
      return { outcome: "not-found", head: head.block, confirmedNonceNow };
    if (rcRead.kind === "agreed" && txRead.kind === "agreed") {
      const receipt = rcRead.value;
      const view = txRead.value;
      if (
        view.blockHash !== receipt.blockHash ||
        view.blockNumber !== receipt.blockNumber
      ) {
        if (attempt === 0) {
          await rpc.sleep(DIAGNOSIS_READ_LIMITS.retryWaitMs);
          continue;
        }
        return {
          outcome: "unavailable",
          reason: "provider-error",
        };
      }
      if (above(receipt.blockNumber, head.block.number)) {
        const again = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
        if (!again.ok)
          return {
            outcome: "unavailable",
            reason: again.reason,
            observations: again.observations,
          };
        if (above(receipt.blockNumber, again.block.number))
          return { outcome: "unavailable", reason: "stale-head" };
        head = again;
      }
      return {
        outcome: "found-mined",
        head: head.block,
        tx: view,
        receipt,
        confirmedNonceNow,
      };
    }
    if (rcRead.kind === "both-null") {
      const pending = pendingCopy(tx);
      if (pending)
        return {
          outcome: "found-pending",
          head: head.block,
          tx: pending.tx,
          seenBy: pending.seenBy,
          confirmedNonceNow,
        };
    }
    const split =
      rcRead.kind === "split" ||
      (rcRead.kind === "agreed" && txRead.kind !== "agreed");
    if (split && attempt === 0) {
      await rpc.sleep(DIAGNOSIS_READ_LIMITS.retryWaitMs);
      continue;
    }
    if (split && rpc.providerCount === 1)
      return { outcome: "unavailable", reason: "provider-error" };
    if (split)
      return {
        outcome: "unavailable",
        reason: "providers-disagree",
        observations: observePair(rc),
      };
    const reason: ReadFailure =
      rcRead.kind === "unavailable"
        ? rcRead.reason
        : txRead.kind === "unavailable"
          ? txRead.reason
          : rpc.providerCount === 1
            ? "provider-error"
            : "providers-disagree";
    return {
      outcome: "unavailable",
      reason,
      observations:
        reason === "providers-disagree"
          ? observePair(rcRead.kind === "both-null" ? tx : rc)
          : undefined,
    };
  }
  return { outcome: "unavailable", reason: "provider-error" };
}

async function codeAt(
  chain: DiagnosisChain,
  rpc: DiagnosisRpc,
  address: Hex,
  block: AgreedBlock,
): Promise<EvmCodeFact | null> {
  const read = agreedValue(
    await rpc.both("eth_getCode", [address, pinned(block)]),
    (raw) => {
      if (typeof raw !== "string") throw new Error("code");
      return codeKind(raw);
    },
  );
  return read.kind === "agreed"
    ? { network: chain.network, address, atBlock: block.number, ...read.value }
    : null;
}

type FoundParts = Omit<EvmFound, "network" | "tx" | "txAgreement"> & {
  profileRefs: string[];
  profile: ProtocolProfileFacts | null;
};

async function minedFacts(
  chain: DiagnosisChain,
  rpc: DiagnosisRpc,
  deps: EvmReadDeps,
  sighting: Extract<Sighting, { outcome: "found-mined" }>,
  others: { chain: DiagnosisChain; rpc: DiagnosisRpc }[],
): Promise<
  | FoundParts
  | "retry"
  | { unavailable: ReadFailure; observations?: ProviderObservations }
> {
  const { tx, receipt } = sighting;
  const block = await agreedBlockByNumber(rpc, receipt.blockNumber);
  if (!block.ok)
    return { unavailable: block.reason, observations: block.observations };
  if (
    block.block.hash !== receipt.blockHash ||
    block.block.hash !== tx.blockHash
  )
    return "retry";
  const inclusion = block.block;
  if (tx.to) rpc.allowCallTo(tx.to);
  const addresses = [
    ...new Set(
      [tx.to, ...receipt.logs.map((log) => log.address)].filter(
        (item): item is Hex => !!item,
      ),
    ),
  ].slice(0, 20);
  const [safe, finalized, toCode, profile, profileRefs] = await Promise.all([
    agreedTagHead(rpc, "safe"),
    agreedTagHead(rpc, "finalized"),
    tx.to ? codeAt(chain, rpc, tx.to, inclusion) : Promise.resolve(null),
    deps.profile.slice(chain.network, addresses),
    deps.profile.refs(chain.network, addresses),
  ]);
  const [method, tokens] = await Promise.all([
    deps.enrich
      ?.method?.({ chain, rpc, tx, block: inclusion })
      .catch(() => null) ?? Promise.resolve(null),
    deps.enrich
      ?.tokens?.({ chain, rpc, block: inclusion, receipt, profile })
      .catch(() => []) ?? Promise.resolve([]),
  ]);
  let revert: EvmRevertReplay | null = null;
  let errorAbi: EvmFound["errorAbi"] = null;
  if (receipt.status === "0x0" && tx.to) {
    const parent = await agreedBlockByNumber(
      rpc,
      parentNumber(receipt.blockNumber),
    );
    if (!parent.ok)
      revert =
        parent.reason === "providers-disagree" && parent.observations
          ? {
              outcome: "disagree",
              atBlock: null,
              observations: parent.observations,
            }
          : {
              outcome: "unavailable",
              atBlock: null,
              reason:
                parent.reason === "providers-disagree"
                  ? "provider-error"
                  : parent.reason,
            };
    else {
      const call = {
        from: tx.from,
        to: tx.to,
        data: tx.input,
        value: tx.value,
        gas: tx.gas,
      };
      const [replay, abi] = await Promise.all([
        rpc.both("eth_call", [call, pinned(parent.block)]),
        deps.enrich?.errorAbi?.({ chain, to: tx.to }).catch(() => null) ??
          Promise.resolve(null),
      ]);
      const outcome = replayOutcome(replay);
      revert =
        outcome.kind === "reverted"
          ? { outcome: "reverted", atBlock: parent.block, data: outcome.data }
          : outcome.kind === "succeeded"
            ? { outcome: "succeeded", atBlock: parent.block }
            : outcome.reason === "providers-disagree" && outcome.observations
              ? {
                  outcome: "disagree",
                  atBlock: parent.block,
                  observations: outcome.observations,
                }
              : {
                  outcome: "unavailable",
                  atBlock: parent.block,
                  reason:
                    outcome.reason === "providers-disagree"
                      ? "provider-error"
                      : outcome.reason,
                };
      errorAbi = abi;
    }
  }
  const code: EvmCodeFact[] = toCode ? [toCode] : [];
  const inputBytes = (tx.input.length - 2) / 2;
  if (tx.to && inputBytes > 0 && toCode?.kind === "none") {
    // Recipient code elsewhere: the member may have used the wrong network.
    const elsewhere = await Promise.all(
      others
        .slice(0, DIAGNOSIS_READ_LIMITS.otherCodeNetworks)
        .map(async (other) => {
          const head = await agreedLatestHead(
            other.rpc,
            other.chain.maxHeadAgeSeconds,
          );
          return head.ok
            ? codeAt(other.chain, other.rpc, tx.to!, head.block)
            : null;
        }),
    );
    for (const fact of elsewhere) if (fact) code.push(fact);
  }
  return {
    receipt: evmReceiptFact(receipt),
    receiptNullAt: null,
    block: inclusion,
    heads: { latest: sighting.head, safe, finalized },
    senderNonce: null,
    pendingNonce: null,
    code,
    revert,
    method,
    errorAbi,
    tokens,
    profileRefs,
    profile,
  };
}

async function pendingFacts(
  chain: DiagnosisChain,
  rpc: DiagnosisRpc,
  deps: EvmReadDeps,
  hash: Hex,
  tx: EvmTxView,
): Promise<
  | (FoundParts & { latest: AgreedBlock })
  | "mined"
  | { unavailable: ReadFailure; observations?: ProviderObservations }
> {
  const h1 = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
  if (!h1.ok) return { unavailable: h1.reason, observations: h1.observations };
  const nonce = agreedValue(
    await rpc.both("eth_getTransactionCount", [tx.from, pinned(h1.block)]),
    quantity,
  );
  // The receipt is read at a head read after the nonce, so "replaced" can be
  // decided from these two facts.
  const h2 = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
  if (!h2.ok) return { unavailable: h2.reason, observations: h2.observations };
  const rc = agreed(
    await rpc.both("eth_getTransactionReceipt", [hash], {
      maxBytes: DIAGNOSIS_READ_LIMITS.receiptMaxBytes,
    }),
    evmReceiptView,
    RECEIPT_VERDICT,
    RECEIPT_DISPLAY,
  );
  if (rc.kind === "agreed") return "mined";
  if (rc.kind === "unavailable")
    return { unavailable: rc.reason, observations: rc.observations };
  if (rc.kind === "split")
    return { unavailable: "providers-disagree", observations: rc.observations };
  const [primary, confirmation] = await Promise.all(
    (["primary", "confirmation"] as const).map(async (role) => {
      const side = await rpc.one(role, "eth_getTransactionCount", [
        tx.from,
        "pending",
      ]);
      try {
        return side.failed || side.error ? null : quantity(side.result);
      } catch {
        return null;
      }
    }),
  );
  const [toCode, method, profile, profileRefs] = await Promise.all([
    tx.to ? codeAt(chain, rpc, tx.to, h2.block) : Promise.resolve(null),
    deps.enrich
      ?.method?.({ chain, rpc, tx, block: h2.block })
      .catch(() => null) ?? Promise.resolve(null),
    deps.profile.slice(chain.network, tx.to ? [tx.to] : []),
    deps.profile.refs(chain.network, tx.to ? [tx.to] : []),
  ]);
  return {
    latest: h2.block,
    receipt: null,
    receiptNullAt: h2.block.number,
    block: null,
    heads: { latest: h2.block, safe: null, finalized: null },
    senderNonce:
      nonce.kind === "agreed"
        ? { confirmed: nonce.value, atBlock: h1.block.number }
        : null,
    pendingNonce: { primary, confirmation },
    code: toCode ? [toCode] : [],
    revert: null,
    method,
    errorAbi: null,
    tokens: [],
    profileRefs,
    profile,
  };
}

export type EvmReadOutcome = {
  input: EvmDiagnosisInput;
  profileRefs: string[];
};

/** R1-R4 of the read order: probe, then the found network's facts. The
 * value was already cleared by the key guard. Never throws for chain
 * trouble: a failed read becomes an unavailable fact. */
export async function readEvmInput(
  plan: DiagnosisRunPlan,
  deps: EvmReadDeps,
): Promise<EvmReadOutcome> {
  if (plan.subject.kind !== "evm") throw new Error("not an EVM subject");
  const hash = plan.subject.hash;
  const hint =
    plan.hint && plan.hint.network !== "solana"
      ? (plan.hint.network as EvmNetwork)
      : null;
  const networks = plan.networks
    .filter((network): network is EvmNetwork => network !== "solana")
    .slice(0, DIAGNOSIS_READ_LIMITS.probeNetworks);
  const results = new Map<EvmNetwork, Sighting>();
  const probe = async (network: EvmNetwork) => {
    const entry = deps.rpcs.get(network);
    results.set(
      network,
      entry
        ? await probeNetwork(entry.chain, entry.rpc, plan, hash)
        : { outcome: "unavailable", reason: "not-configured" },
    );
  };
  if (hint && networks.includes(hint)) {
    await probe(hint);
    // A transaction mined on the hinted network ends the search there.
    if (results.get(hint)?.outcome !== "found-mined")
      await Promise.all(networks.filter((n) => n !== hint).map(probe));
  } else await Promise.all(networks.map(probe));

  const probeFor = (network: EvmNetwork): EvmProbe => {
    const sighting = results.get(network)!;
    if (sighting.outcome === "unavailable")
      return sighting.reason === "providers-disagree" && sighting.observations
        ? { network, outcome: "disagree", observations: sighting.observations }
        : {
            network,
            outcome: "unavailable",
            reason:
              sighting.reason === "providers-disagree"
                ? "provider-error"
                : sighting.reason,
          };
    if (sighting.outcome === "found-pending")
      return {
        network,
        outcome: "found-pending",
        head: sighting.head,
        seenBy: sighting.seenBy,
      };
    return { network, outcome: sighting.outcome, head: sighting.head };
  };
  const probed = networks.filter((network) => results.has(network));
  let probes = probed.map(probeFor);
  // The engine's selection: mined before pending, the hint first.
  const pick = (kind: "found-mined" | "found-pending") =>
    probes.find((item) => item.outcome === kind && item.network === hint) ??
    probes.find((item) => item.outcome === kind);
  let chosen = pick("found-mined") ?? pick("found-pending") ?? null;

  let found: EvmFound | null = null;
  let profileRefs: string[] = [];
  let profile: ProtocolProfileFacts | null = null;
  let factsFailure: (ReadProblem & { network: EvmNetwork }) | null = null;
  let decidingFailure: {
    reason: ReadFailure;
    network: EvmNetwork;
    observations?: ProviderObservations;
  } | null = null;
  for (let round = 0; round < 2 && chosen; round++) {
    const network = chosen.network;
    const entry = deps.rpcs.get(network)!;
    const sighting = results.get(network)!;
    const others = [...deps.rpcs.values()].filter(
      (item) => item.chain.network !== network,
    );
    if (sighting.outcome === "found-mined") {
      const facts = await minedFacts(
        entry.chain,
        entry.rpc,
        deps,
        sighting,
        others,
      );
      if (facts === "retry") {
        if (round === 0) {
          await entry.rpc.sleep(DIAGNOSIS_READ_LIMITS.retryWaitMs);
          results.set(
            network,
            await probeNetwork(entry.chain, entry.rpc, plan, hash),
          );
          probes = probed.map(probeFor);
          chosen = pick("found-mined") ?? pick("found-pending") ?? null;
          continue;
        }
        results.set(network, {
          outcome: "unavailable",
          reason: "provider-error",
        });
        factsFailure = { reason: "provider-error", network };
      } else if ("unavailable" in facts) {
        results.set(network, {
          outcome: "unavailable",
          reason: facts.unavailable,
          observations: facts.observations,
        });
        factsFailure = {
          reason: facts.unavailable,
          network,
          observations: facts.observations,
        };
      } else {
        const { profileRefs: refs, profile: slice, ...parts } = facts;
        profileRefs = refs;
        profile = slice;
        found = {
          network,
          tx: evmTxFact(sighting.tx),
          txAgreement: { kind: "agreed" },
          ...parts,
        };
      }
    } else if (sighting.outcome === "found-pending") {
      const facts = await pendingFacts(
        entry.chain,
        entry.rpc,
        deps,
        hash,
        sighting.tx,
      );
      if (facts === "mined" && round === 0) {
        results.set(
          network,
          await probeNetwork(entry.chain, entry.rpc, plan, hash),
        );
        probes = probed.map(probeFor);
        chosen = pick("found-mined") ?? pick("found-pending") ?? null;
        continue;
      }
      if (facts === "mined") {
        results.set(network, {
          outcome: "unavailable",
          reason: "provider-error",
        });
        factsFailure = { reason: "provider-error", network };
      } else if ("unavailable" in facts) {
        results.set(network, {
          outcome: "unavailable",
          reason: facts.unavailable,
          observations: facts.observations,
        });
        factsFailure = {
          reason: facts.unavailable,
          network,
          observations: facts.observations,
        };
      } else {
        const { profileRefs: refs, profile: slice, latest, ...parts } = facts;
        profileRefs = refs;
        profile = slice;
        results.set(network, { ...sighting, head: latest });
        found = {
          network,
          tx: evmTxFact(sighting.tx),
          txAgreement: { kind: "seen", by: sighting.seenBy },
          ...parts,
        };
      }
    }
    break;
  }
  probes = probed.map(probeFor);
  if (!found) {
    // A sighting whose facts could not be read no longer counts as found.
    const failedFound = probes.find(
      (item) =>
        item.outcome === "found-mined" || item.outcome === "found-pending",
    );
    if (failedFound) {
      results.set(failedFound.network, {
        outcome: "unavailable",
        reason: "provider-error",
      });
      probes = probed.map(probeFor);
      factsFailure ??= {
        reason: "provider-error",
        network: failedFound.network,
      };
    }
    const hinted = hint ? probes.find((item) => item.network === hint) : null;
    if (factsFailure) decidingFailure = factsFailure;
    else if (hinted?.outcome === "disagree")
      decidingFailure = {
        reason: "providers-disagree",
        network: hinted.network,
        observations: hinted.observations,
      };
    else if (hinted?.outcome === "unavailable")
      decidingFailure = { reason: hinted.reason, network: hinted.network };
    else if (
      probes.length &&
      probes.every(
        (item) => item.outcome === "unavailable" || item.outcome === "disagree",
      )
    ) {
      const first =
        probes.find((item) => item.outcome === "disagree") ?? probes[0];
      if (first.outcome === "disagree")
        decidingFailure = {
          reason: "providers-disagree",
          network: first.network,
          observations: first.observations,
        };
      else if (first.outcome === "unavailable")
        decidingFailure = { reason: first.reason, network: first.network };
    }
  }
  const previous: EvmPreviousSighting | null = plan.previous
    ? {
        ...plan.previous,
        confirmedNonceNow: (() => {
          const sighting = results.get(plan.previous!.network);
          return sighting && "confirmedNonceNow" in sighting
            ? sighting.confirmedNonceNow
            : null;
        })(),
      }
    : null;
  const input: EvmDiagnosisInput = {
    v: 1,
    kind: "evm",
    checkedAt: plan.checkedAt,
    hint: plan.hint,
    wallet: plan.wallet,
    profile,
    unavailable:
      decidingFailure && decidingFailure.reason !== "providers-disagree"
        ? { reason: decidingFailure.reason, network: decidingFailure.network }
        : null,
    ...(decidingFailure?.reason === "providers-disagree" &&
    decidingFailure.observations
      ? {
          disagreement: {
            network: decidingFailure.network,
            observations: decidingFailure.observations,
          } satisfies DiagnosisDisagreement,
        }
      : {}),
    hash,
    probes: probes.length
      ? probes
      : [
          {
            network: hint ?? "eip155:1",
            outcome: "unavailable",
            reason: "not-configured",
          },
        ],
    found,
    previous,
  };
  return { input, profileRefs };
}
