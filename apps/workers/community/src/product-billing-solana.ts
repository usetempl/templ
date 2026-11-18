import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PRODUCT_SOLANA_GENESIS,
  PRODUCT_SOLANA_TOKEN_PROGRAM,
  PRODUCT_SOLANA_MEMO_PROGRAM,
  type ProductPaymentRecipient,
  type ProductPaymentConfirmation,
  type SolanaProductPaymentIntent,
} from "@templ/chat/product-payment";
import { base58Decode, isSolanaAddress } from "@templ/chat/solana";
import { HttpError } from "./common";
import { solanaEndpoints, type SolanaRpcEnv } from "./solana";
import { paymentRpc, type PaymentFetcher } from "./chain-payment-rpc";
import { RPC_BUDGET, type RpcBudgetEnv } from "./rpc-budget";
import type { ProductPaymentRpc } from "./product-billing";
const unavailable = () =>
  new HttpError(503, "Solana payment could not be verified.");
const mismatch = () =>
  new HttpError(422, "This transaction does not match the payment request.");
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, any>;
};
export function isSolanaPaymentSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value))
    return false;
  try {
    return base58Decode(value).length === 64;
  } catch {
    return false;
  }
}
export function productTokenAccount(mint: string, owner: string): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    false,
    new PublicKey(PRODUCT_SOLANA_TOKEN_PROGRAM),
  ).toBase58();
}
export async function prepareSolanaProductTransfer(
  _env: SolanaRpcEnv,
  config: ProductPaymentRecipient,
  payer: string,
  _amountRaw: string,
  _fetcher?: PaymentFetcher,
) {
  if (
    !isSolanaAddress(payer) ||
    !isSolanaAddress(config.recipient) ||
    !isSolanaAddress(config.asset) ||
    config.chain !== "solana"
  )
    throw unavailable();
  return {
    tokenProgram:
      PRODUCT_SOLANA_TOKEN_PROGRAM as typeof PRODUCT_SOLANA_TOKEN_PROGRAM,
    memoProgram:
      PRODUCT_SOLANA_MEMO_PROGRAM as typeof PRODUCT_SOLANA_MEMO_PROGRAM,
    sourceTokenAccount: productTokenAccount(config.asset, payer),
    destinationTokenAccount: productTokenAccount(
      config.asset,
      config.recipient,
    ),
  };
}

export type SolanaTransfer = {
  instructionIndex: number;
  amountRaw: string;
  usdCents: number;
  paidAt: number;
  confirmation?: ProductPaymentConfirmation;
};
/** jsonParsed decodes both direct and inner SPL instructions. Account owners
 * and mint decimals come from the transaction's token balance metadata. */
export function matchSolanaProductTransfer(
  value: unknown,
  intent: SolanaProductPaymentIntent,
  nowMs: number,
  checkTime = true,
): SolanaTransfer | null {
  if (value === null) return null;
  const tx = object(value),
    meta = object(tx.meta),
    message = object(object(tx.transaction).message);
  if (meta.err !== null) throw mismatch();
  if (
    !Number.isSafeInteger(tx.slot) ||
    !Number.isSafeInteger(tx.blockTime) ||
    !Array.isArray(message.accountKeys) ||
    !Array.isArray(message.instructions) ||
    message.instructions.length > 256 ||
    !Array.isArray(meta.preTokenBalances) ||
    !Array.isArray(meta.postTokenBalances)
  )
    throw unavailable();
  const keys = message.accountKeys.map((key: unknown) =>
    typeof key === "string" ? key : object(key).pubkey,
  );
  const instructions: { row: Record<string, any>; index: number }[] =
    message.instructions.map((row: unknown, index: number) => ({
      row: object(row),
      index,
    }));
  for (const group of meta.innerInstructions ?? []) {
    const inner = object(group);
    if (
      !Array.isArray(inner.instructions) ||
      inner.instructions.length > 256 ||
      !Number.isSafeInteger(inner.index) ||
      inner.index < 0 ||
      inner.index >= message.instructions.length
    )
      throw unavailable();
    for (const [offset, row] of inner.instructions.entries())
      instructions.push({
        row: object(row),
        index: message.instructions.length + inner.index * 256 + offset,
      });
  }
  const transfers = instructions.filter(
    ({ row }) =>
      row.programId === PRODUCT_SOLANA_TOKEN_PROGRAM &&
      ["transfer", "transferChecked"].includes(row.parsed?.type),
  );
  if (transfers.length !== 1) throw mismatch();
  const { row, index } = transfers[0],
    info = object(object(row.parsed).info);
  const sourceMetadata = meta.preTokenBalances.find(
    (entry: unknown) =>
      object(entry).accountIndex === keys.indexOf(info.source),
  );
  if (!sourceMetadata || object(sourceMetadata).mint !== intent.asset.address)
    throw mismatch();
  if (
    row.parsed.type === "transferChecked" &&
    info.mint !== intent.asset.address
  )
    throw mismatch();
  const amount =
    row.parsed.type === "transferChecked"
      ? object(info.tokenAmount)
      : {
          amount: info.amount,
          decimals: object(object(sourceMetadata).uiTokenAmount).decimals,
        };
  if (
    amount.decimals !== intent.asset.decimals ||
    typeof amount.amount !== "string" ||
    !/^\d{1,78}$/.test(amount.amount)
  )
    throw mismatch();
  const raw = BigInt(amount.amount),
    units = 10n ** BigInt(intent.asset.decimals - 2),
    cents = raw / units;
  if (
    raw <= 0n ||
    raw % units !== 0n ||
    cents > 25_000_000n ||
    (!intent.orderFormId && amount.amount !== intent.amountRaw)
  )
    throw mismatch();
  const balance = (rows: unknown[], account: string, owner: string) => {
    const entries = rows.filter(
      (entry) => object(entry).accountIndex === keys.indexOf(account),
    );
    if (
      entries.length === 0 &&
      ((rows === meta.preTokenBalances && account === info.destination) ||
        (rows === meta.postTokenBalances && account === info.source))
    )
      return 0n;
    if (entries.length !== 1) throw mismatch();
    const value = object(entries[0]),
      token = object(value.uiTokenAmount);
    if (
      value.owner !== owner ||
      value.mint !== intent.asset.address ||
      token.decimals !== intent.asset.decimals ||
      typeof token.amount !== "string" ||
      !/^\d{1,78}$/.test(token.amount)
    )
      throw mismatch();
    return BigInt(token.amount);
  };
  if (
    balance(meta.preTokenBalances, info.source, intent.payer) -
      balance(meta.postTokenBalances, info.source, intent.payer) !==
      raw ||
    balance(meta.postTokenBalances, info.destination, intent.recipient) -
      balance(meta.preTokenBalances, info.destination, intent.recipient) !==
      raw
  )
    throw mismatch();
  const paidAt = tx.blockTime * 1000;
  if (
    checkTime &&
    (!Number.isSafeInteger(paidAt) ||
      paidAt < Date.parse(intent.createdAt) - 120_000 ||
      paidAt > nowMs)
  )
    throw mismatch();
  return {
    instructionIndex: index,
    amountRaw: amount.amount,
    usdCents: Number(cents),
    paidAt,
  };
}
export async function readSolanaProductTransfer(
  env: SolanaRpcEnv,
  intent: SolanaProductPaymentIntent,
  signature: string,
  input: { nowMs: number; fetcher?: PaymentFetcher },
) {
  if (!isSolanaPaymentSignature(signature))
    throw new HttpError(400, "Enter the Solana transaction signature.");
  const result = await paymentRpc(
    env as RpcBudgetEnv,
    solanaEndpoints(env)[0],
    "getTransaction",
    [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ],
    input.fetcher,
  );
  if (
    result !== null &&
    object(object(result).transaction).signatures?.[0] !== signature
  )
    throw unavailable();
  const transfer = matchSolanaProductTransfer(
    result,
    intent,
    input.nowMs,
    false,
  );
  if (!transfer) return null;
  return {
    ...transfer,
    confirmation: {
      kind: "solana" as const,
      slot: String(object(result).slot),
      commitment: "confirmed" as const,
      checkedAt: new Date(input.nowMs).toISOString(),
    },
  };
}
export async function verifySolanaProductPayment(
  env: SolanaRpcEnv,
  config: ProductPaymentRecipient,
  intent: SolanaProductPaymentIntent,
  signature: string,
  input: {
    nowMs: number;
    fetcher?: PaymentFetcher;
    rpc?: ProductPaymentRpc;
    observeConfirmation?: (
      value: ProductPaymentConfirmation,
    ) => void | Promise<void>;
  },
) {
  if (
    config.chain !== "solana" ||
    intent.recipient !== config.recipient ||
    intent.asset.address !== config.asset ||
    intent.asset.decimals !== config.decimals
  )
    throw unavailable();
  if (!isSolanaPaymentSignature(signature))
    throw new HttpError(400, "Enter the Solana transaction signature.");
  const urls = solanaEndpoints(env),
    params = [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ];
  const [results, genesis] = await Promise.all([
    Promise.all(
      urls.map((url) =>
        (input.rpc ?? paymentRpc)(
          env as RpcBudgetEnv,
          url,
          "getTransaction",
          params,
          input.fetcher,
        ),
      ),
    ),
    Promise.all(
      urls.map((url) =>
        (input.rpc ?? paymentRpc)(
          env as RpcBudgetEnv,
          url,
          "getGenesisHash",
          [],
          input.fetcher,
        ),
      ),
    ),
  ]);
  if (genesis.some((value) => value !== PRODUCT_SOLANA_GENESIS))
    throw unavailable();
  if ((results[0] === null) !== (results[1] === null))
    throw new HttpError(503, "Independent payment reads disagree.");
  if (results.every((value) => value === null))
    throw new HttpError(
      409,
      "The transfer is still confirming.",
      undefined,
      "product-payment-receipt-missing",
    );
  const facts = results.map((value) => {
    const tx = object(value);
    if (object(tx.transaction).signatures?.[0] !== signature)
      throw unavailable();
    return {
      slot: tx.slot,
      blockTime: tx.blockTime,
      transaction: tx.transaction,
      meta: tx.meta,
    };
  });
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? JSON.stringify(value.map(canonical))
      : value && typeof value === "object"
        ? JSON.stringify(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, row]) => [key, canonical(row)]),
          )
        : JSON.stringify(value);
  if (canonical(facts[0]) !== canonical(facts[1]))
    throw new HttpError(503, "Independent payment reads disagree.");
  const transfer = matchSolanaProductTransfer(results[0], intent, input.nowMs);
  if (!transfer) throw new HttpError(409, "The transfer is still confirming.");
  const confirmation: ProductPaymentConfirmation = {
    kind: "solana",
    slot: String(facts[0].slot),
    commitment: "finalized",
    checkedAt: new Date(input.nowMs).toISOString(),
  };
  await input.observeConfirmation?.(confirmation);
  return { ...transfer, txHash: signature, confirmation };
}
