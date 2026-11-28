import type {
  CryptoAgreement,
  CryptoProviderId,
  CryptoSourceReport,
} from "./crypto-chain-read-egress";

/** What a reply must keep in mind about a lookup. Codes are stable; the
 * lines are plain English for the model. */
export const CRYPTO_READ_NOTES = Object.freeze({
  "single-source":
    "Only one provider answered. Treat this as one observation, not a confirmed fact.",
  "providers-conflict":
    "The providers do not agree. The data may be changing right now. Check again in a few minutes.",
  "provider-wait":
    "A provider asked Templ to wait before asking again. Some data may be missing.",
  "history-partial":
    "This is not the full history. Older activity may exist.",
  "items-capped": "Some inputs, outputs or transfers are not listed.",
  "unreviewed-token":
    "Some tokens are not on Templ's reviewed list. Their names are not shown. On Ethereum their amounts are in raw units. A token can copy a real token's name.",
  "zero-value-token-transfer":
    "A token transfer of zero is often spam that plants a look-alike address. Never copy an address from history.",
  "failed-fee-charged":
    "A failed transaction moves no funds, but its network fee is still paid.",
  "pending-no-fee-yet":
    "A pending transaction has no final fee yet. It may still fail or be replaced.",
  "unconfirmed-can-change":
    "An unconfirmed Bitcoin transaction can still be replaced or dropped. It is final only after confirmations.",
  "internal-transfers-not-shown":
    "ETH that a contract sends during a transaction (an internal transfer) is not shown.",
  "not-found-meaning":
    "Not found can mean a wrong ID, another network, a transaction that was never sent, or one that was dropped or replaced.",
  "ordinary-history-unavailable": "The provider could only return token transfers. Regular transaction history was unavailable.",
  "token-history-unavailable": "The provider could only return regular transactions. Token transfer history was unavailable.",
  "ethereum-mainnet-only":
    "This covers Ethereum mainnet only. The same address can hold funds on other networks.",
  "solana-token-accounts":
    "On Solana, tokens arrive in token accounts. Only this wallet's USDC and USDT accounts were read.",
  "free-text-omitted":
    "Memos, method names, token names and error text written by others are left out.",
} as const);
export type CryptoReadNote = keyof typeof CRYPTO_READ_NOTES;

export type TxResult<T> = { found: true; tx: T } | { found: false };
export type TxReadBody<T> = {
  agreement: CryptoAgreement;
  /** Null on conflict or when no provider answered. */
  result: TxResult<T> | null;
  /** Only on conflict: what each answering provider said. */
  observations: { provider: CryptoProviderId; result: TxResult<T> }[];
  sources: CryptoSourceReport[];
  notes: CryptoReadNote[];
};
export type AddressReadBody<T> = {
  agreement: CryptoAgreement;
  activity: T | null;
  sources: CryptoSourceReport[];
  notes: CryptoReadNote[];
};
/** One history item: both providers listed it with the same facts, one did,
 * or both did with different facts. */
export type ActivityAgreement = "agreed" | "single" | "conflict";

function sourceNotes(agreement: CryptoAgreement, sources: readonly CryptoSourceReport[]) {
  const notes = new Set<CryptoReadNote>();
  if (agreement === "single") notes.add("single-source");
  if (agreement === "conflict") notes.add("providers-conflict");
  if (sources.some((source) => source.outcome === "rate-limited" || source.outcome === "cooling-down"))
    notes.add("provider-wait");
  return notes;
}

export function txReadNotes(
  agreement: CryptoAgreement,
  sources: readonly CryptoSourceReport[],
  result: TxResult<unknown> | null,
) {
  const notes = sourceNotes(agreement, sources);
  if (result && !result.found) notes.add("not-found-meaning");
  return notes;
}

export const addressReadNotes = sourceNotes;
