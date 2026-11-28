import {
  CRYPTO_READ_NOTES,
  readCryptoAddressActivity,
  readCryptoTransaction,
  type CryptoAddressRead,
  type CryptoChainReadDeps,
  type CryptoTxRead,
} from "../crypto-chain-read";
import type { CryptoChainReader, CryptoChainReading } from "./crypto-chain-facts";

type Fact = { label: string; value: string };
/** Item lists come after the caveats, so the fact limit drops items first. */
type Facts = { core: Fact[]; items: Fact[] };
type Read = Extract<CryptoTxRead | CryptoAddressRead, { kind: "read" }>;
type TxFacts = Extract<NonNullable<Extract<CryptoTxRead, { kind: "read" }>["result"]>, { found: true }>["tx"];
type Activity = NonNullable<Extract<CryptoAddressRead, { kind: "read" }>["activity"]>;

const fact = (label: string, value: unknown): Fact[] =>
  value === null || value === undefined || value === "" ? [] : [{ label, value: String(value) }];
const token = (amount: string | null, raw: string, label: string | null) =>
  label && amount !== null ? `${amount} ${label}` : `${raw} raw units of an unreviewed token`;
const shown = (history: { shown: number; complete: boolean }) =>
  `${history.shown} transactions${history.complete ? "" : ", not complete"}`;
function btc(sats: string) {
  if (!/^-?\d{1,20}$/.test(sats)) return null;
  const digits = sats.replace("-", "").padStart(9, "0");
  const fraction = digits.slice(-8).replace(/0+$/, "");
  return `${sats.startsWith("-") ? "-" : ""}${digits.slice(0, -8).replace(/^0+(?=\d)/, "")}${fraction ? "." + fraction : ""} BTC`;
}

function txFacts(tx: TxFacts): Facts {
  if (tx.chain === "bitcoin")
    return {
      core: [
        ...fact("Status", tx.state), ...fact("Confirmations", tx.confirmations),
        ...fact("Block", tx.blockHeight), ...fact("Block time", tx.blockTime),
        ...fact("Fee", `${tx.feeBtc} BTC`), ...fact("Total output", `${tx.totalOutBtc} BTC`),
      ],
      items: tx.outputs.slice(0, 4).flatMap((output) =>
        fact("Output", `${btc(output.valueSats)} to ${output.address ?? "no address"}`)),
    };
  if (tx.chain === "ethereum")
    return {
      core: [
        ...fact("Status", tx.state), ...fact("Confirmations", tx.confirmations),
        ...fact("Block", tx.blockNumber), ...fact("Block time", tx.blockTime),
        ...fact("ETH moved", tx.valueMoved ? `${tx.valueEth} ETH` : "none"),
        ...fact("Fee", tx.feeEth === null ? null : `${tx.feeEth} ETH`),
        ...fact("From", tx.from), ...fact("To", tx.to ?? (tx.contractCreated ? "a new contract" : null)),
      ],
      items: tx.tokenTransfers.slice(0, 4).flatMap((transfer) =>
        fact("Token transfer", `${token(transfer.amount, transfer.amountRaw, transfer.label)} from ${transfer.from} to ${transfer.to}`)),
    };
  return {
    core: [
      ...fact("Status", tx.state), ...fact("Commitment", tx.commitment),
      ...fact("Slot", tx.slot), ...fact("Block time", tx.blockTime),
      ...fact("Fee", tx.feeSol === null ? null : `${tx.feeSol} SOL`), ...fact("Error", tx.error?.kind),
    ],
    items: [
      ...tx.solChanges.slice(0, 3).flatMap((change) => fact("SOL change", `${change.changeSol} SOL for ${change.account}`)),
      ...tx.tokenChanges.slice(0, 3).flatMap((change) =>
        fact("Token change", `${token(change.change, change.changeRaw, change.label)} for ${change.owner ?? change.account}`)),
    ],
  };
}

function activityFacts(activity: Activity): Facts {
  if (activity.chain === "bitcoin")
    return {
      core: fact("History shown", shown(activity.history)),
      items: activity.items.slice(0, 5).flatMap((item) =>
        fact("Transaction", `${item.state}, ${item.blockTime ?? "no block yet"}, net ${item.netBtc} BTC for this address`)),
    };
  if (activity.chain === "ethereum")
    return {
      core: [
        ...fact("Transactions shown", shown(activity.history.transactions)),
        ...fact("Token transfers shown", shown(activity.history.tokenTransfers)),
      ],
      items: [
        ...activity.transactions.slice(0, 4).flatMap((tx) =>
          fact("Transaction", `${tx.direction}, ${tx.state}, ${tx.time ?? "no block yet"}, ${tx.valueMoved ? `${tx.valueEth} ETH` : "no ETH moved"}`)),
        ...activity.tokenTransfers.slice(0, 3).flatMap((transfer) =>
          fact("Token transfer", `${transfer.direction}, ${transfer.time ?? "no block yet"}, ${token(transfer.amount, transfer.amountRaw, transfer.label)}`)),
      ],
    };
  return {
    core: fact("History shown", shown(activity.history)),
    items: activity.items.slice(0, 5).flatMap((item) =>
      fact("Transaction", `${item.state}, ${item.blockTime ?? "no block time"}, ${item.change
        ? [`${item.change.solChange} SOL`, ...item.change.tokens.map((change) => token(change.change, change.changeRaw, change.label))].join(", ")
        : "change not read"}`)),
  };
}

function reading(read: Read, { core, items }: Facts): CryptoChainReading {
  return {
    ok: true,
    observedAt: Date.parse(read.checkedAt),
    facts: [
      ...core,
      ...fact("Sources", read.agreement === "agreed" ? "two independent providers agreed" :
        read.agreement === "conflict" ? "the providers disagree" : "only one provider confirmed these details"),
      ...read.notes.flatMap((note) => fact("Note", CRYPTO_READ_NOTES[note])),
      ...items,
    ],
  };
}

/** The desk's reader over the fixed public providers. Bad input and provider
 * trouble come back as a refusal or an unavailable read, never as a guess. */
export function cryptoChainReader(deps: Omit<CryptoChainReadDeps, "deadlineMs"> = {}): CryptoChainReader {
  return async (target, { deadlineMs }) => {
    const options = { ...deps, deadlineMs };
    if (target.subject === "address") {
      const read = await readCryptoAddressActivity({ chain: target.chain, address: target.value }, options);
      if (read.kind === "refused") return { ok: false, reason: "refused" };
      return read.activity ? reading(read, activityFacts(read.activity)) : { ok: false, reason: "unavailable" };
    }
    const read = target.chain === "solana"
      ? await readCryptoTransaction({ chain: "solana", signature: target.value }, options)
      : target.permalink
        ? await readCryptoTransaction(
            target.chain === "bitcoin"
              ? { chain: "bitcoin", txid: target.value, evidence: { kind: "permalink", url: target.permalink } }
              : { chain: "ethereum", hash: target.value, evidence: { kind: "permalink", url: target.permalink } },
            options,
          )
        : null;
    if (!read || read.kind === "refused") return { ok: false, reason: "refused" };
    if (!read.result) return { ok: false, reason: "unavailable" };
    if (!read.result.found) return { ok: false, reason: "not-found" };
    return reading(read, txFacts(read.result.tx));
  };
}
