import { encodeFunctionData, erc20Abi, getAddress, type Hash } from "viem";
import type { ChatRoomId } from "@templ/chat/index";
import {
  PRODUCT_OFFER_VERSION,
  PRODUCT_USAGE_PAYMENT_RECIPIENT,
} from "@templ/chat/plans";
import {
  getProductPaymentAsset,
  productRailOf,
  type ProductPaymentNetwork,
  type ProductPaymentAssetSymbol,
  type EvmProductPaymentIntent,
  type SolanaProductPaymentIntent,
  type ProductPaymentIntent,
} from "@templ/chat/product-payment";
import {
  checkSolanaProductPaymentIntent,
  buildSolanaProductTransaction,
} from "./solana-product-payment";
import { connectSolanaTransactionWallet } from "./solana-wallet";
import { base58Decode } from "@templ/chat/solana";
import type { useWallet } from "./wallet";
import { paymentRecipient } from "./release-public";
import type { WorkspaceFlagKey } from "@templ/chat/workspace-flags";
import { checkTopUp, PAYMENT_MISMATCH } from "./product-offer";
import { productPaymentTransferAmount } from "./product-payment-amount";

export type CheckoutFeatures = Partial<Record<WorkspaceFlagKey, boolean>>;

export function productCheckoutAvailable(
  network: ProductPaymentNetwork,
  symbol: ProductPaymentAssetSymbol = "USDC",
  features: CheckoutFeatures = {},
) {
  const rail = productRailOf(network, symbol);
  return (
    rail !== null &&
    features[`pay.${rail}`] === true &&
    Boolean(paymentRecipient(network, symbol))
  );
}
/** Review the token, receiver and amount before opening the wallet. */
export function checkProductPaymentIntent(
  room: ChatRoomId,
  intent: ProductPaymentIntent,
  payer: string,
  features: CheckoutFeatures = {},
) {
  if (
    intent.settlement === "manual-usage" &&
    (intent.kind !== "evm" ||
      ![1, 8453].includes(intent.chainId) ||
      intent.recipient.toLowerCase() !==
        PRODUCT_USAGE_PAYMENT_RECIPIENT.toLowerCase() ||
      intent.preview.bonusCents !== 0)
  )
    throw new Error(PAYMENT_MISMATCH);
  if (intent.kind === "solana")
    return checkSolanaProductPaymentIntent(
      room,
      intent,
      payer,
      productCheckoutAvailable("solana", intent.asset.symbol, features),
    );
  const recipient = paymentRecipient(intent.chainId, intent.asset.symbol);
  const asset = getProductPaymentAsset(intent.chainId, intent.asset.symbol);
  if (
    !productCheckoutAvailable(intent.chainId, intent.asset.symbol, features) ||
    !recipient ||
    !asset
  )
    throw new Error("Payments are not available on this network yet.");
  checkTopUp(intent);
  productPaymentTransferAmount(intent);
  if (
    intent.offerVersion !== PRODUCT_OFFER_VERSION ||
    intent.room !== room ||
    intent.workspace !== room ||
    intent.network !== intent.chainId ||
    intent.token !== intent.asset.symbol ||
    intent.status !== "open" ||
    intent.rail !== productRailOf(intent.chainId, intent.asset.symbol) ||
    intent.payer.toLowerCase() !== payer.toLowerCase() ||
    payer.toLowerCase() === recipient.recipient.toLowerCase() ||
    intent.recipient.toLowerCase() !== recipient.recipient.toLowerCase() ||
    intent.asset.address.toLowerCase() !== asset.address.toLowerCase() ||
    intent.asset.decimals !== asset.decimals ||
    intent.asset.symbol !== asset.symbol ||
    !Number.isFinite(Date.parse(intent.createdAt)) ||
    !Number.isFinite(Date.parse(intent.expiresAt)) ||
    Date.parse(intent.expiresAt) <= Date.parse(intent.createdAt) ||
    intent.amountRaw !==
      (
        BigInt(intent.usdCents) *
        10n ** BigInt(asset.decimals - 2)
      ).toString() ||
    (intent as { test?: unknown }).test !== undefined
  )
    throw new Error(PAYMENT_MISMATCH);
  return recipient;
}

type Journal = {
  intent: ProductPaymentIntent;
  uncertain: boolean;
  hash?: string;
};
const memory = new Map<string, Journal>();
const journalKey = (intent: ProductPaymentIntent) =>
  `templ:product-payment:${intent.chainId}:${intent.kind === "solana" ? intent.payer : intent.payer.toLowerCase()}:${intent.id}`;
function save(journal: Journal) {
  const key = journalKey(journal.intent);
  memory.set(key, journal);
  try {
    localStorage.setItem(key, JSON.stringify(journal));
  } catch {
    /* Keep the current tab's request. */
  }
}
export function pendingProductPayment(
  intent: ProductPaymentIntent,
): Journal | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(journalKey(intent)) ?? "null",
    ) as Journal | null;
    if (value?.intent?.id === intent.id && typeof value.uncertain === "boolean")
      return value;
  } catch {
    /* Read the current tab's copy. */
  }
  return memory.get(journalKey(intent)) ?? null;
}
/** Keep an unknown wallet response locked across tabs and reloads. */
export function pendingProductPaymentFor(
  room: ChatRoomId,
  payer: string,
): Journal | null {
  const entries = new Map(memory);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith("templ:product-payment:")) continue;
      const entry = JSON.parse(
        localStorage.getItem(key) ?? "null",
      ) as Journal | null;
      if (entry?.intent?.room === room && typeof entry.uncertain === "boolean")
        entries.set(key, entry);
    }
  } catch {
    /* Read the current tab's copies. */
  }
  return (
    [...entries.values()].find(
      (entry) =>
        entry.intent.room === room &&
        (entry.intent.kind === "solana"
          ? entry.intent.payer === payer
          : entry.intent.payer.toLowerCase() === payer.toLowerCase()),
    ) ?? null
  );
}
export function clearProductPayment(intent: ProductPaymentIntent) {
  const key = journalKey(intent);
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* No stored copy. */
  }
}
export function validProductTransactionHash(
  intent: ProductPaymentIntent,
  hash: string,
) {
  if (intent.kind === "evm") return /^0x[0-9a-fA-F]{64}$/.test(hash);
  try {
    return base58Decode(hash).length === 64;
  } catch {
    return false;
  }
}
const sending = new Set<string>();
async function locked<T>(key: string, send: () => Promise<T>): Promise<T> {
  if (sending.has(key))
    throw new Error("A payment is already open for this wallet.");
  sending.add(key);
  try {
    if (typeof navigator !== "undefined" && navigator.locks)
      return await navigator.locks.request(
        key,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error("A payment is already open in another tab.");
          return send();
        },
      );
    return await send();
  } finally {
    sending.delete(key);
  }
}
function outstanding(room: ChatRoomId, intent: ProductPaymentIntent) {
  const previous = pendingProductPaymentFor(room, intent.payer);
  if (previous && previous.intent.id !== intent.id)
    throw new Error(
      "Check the earlier wallet response before starting another payment.",
    );
  const saved = pendingProductPayment(intent);
  if (saved?.uncertain)
    throw new Error(
      "The wallet response is unknown. Check its history and enter the transaction below.",
    );
  return saved?.hash;
}
function rejected(error: unknown) {
  const value = error as { code?: number; cause?: { code?: number } };
  return (value?.code ?? value?.cause?.code) === 4001;
}
export async function sendProductPayment(input: {
  room: ChatRoomId;
  intent: EvmProductPaymentIntent;
  wallet: Pick<ReturnType<typeof useWallet>, "account" | "ready">;
  assertCurrent: () => void;
  progress: (message: string) => void;
  features?: CheckoutFeatures;
}): Promise<Hash> {
  const { intent, wallet, assertCurrent } = input;
  assertCurrent();
  if (!wallet.account) throw new Error("Connect your payment wallet.");
  checkProductPaymentIntent(input.room, intent, wallet.account, input.features);
  return locked(
    `templ-product-send:${input.room}:${intent.payer.toLowerCase()}`,
    async () => {
      const saved = outstanding(input.room, intent);
      if (saved) return saved as Hash;
      assertCurrent();
      if (Date.parse(intent.expiresAt) <= Date.now())
        throw new Error("This payment request expired.");
      // ready() asks the wallet to switch to the request's network when needed.
      const client = await wallet.ready(intent.chainId);
      assertCurrent();
      if (
        client.account.address.toLowerCase() !== intent.payer.toLowerCase() ||
        client.chain?.id !== intent.chainId
      )
        throw new Error("The payment wallet or network changed.");
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [
          getAddress(intent.recipient),
          BigInt(productPaymentTransferAmount(intent).amountRaw),
        ],
      });
      if (Date.parse(intent.expiresAt) <= Date.now())
        throw new Error("This payment request expired.");
      input.progress("Confirm the transfer in your wallet.");
      assertCurrent();
      save({ intent, uncertain: true });
      let hash: Hash;
      try {
        hash = await client.sendTransaction({
          account: client.account,
          chain: client.chain,
          to: getAddress(intent.asset.address),
          data,
          value: 0n,
        });
      } catch (error) {
        if (rejected(error)) clearProductPayment(intent);
        throw error;
      }
      save({ intent, uncertain: false, hash });
      assertCurrent();
      return hash;
    },
  );
}
export async function sendSolanaProductPayment(input: {
  room: ChatRoomId;
  intent: SolanaProductPaymentIntent;
  payer: string;
  assertCurrent: () => void;
  progress: (message: string) => void;
  features?: CheckoutFeatures;
}): Promise<string> {
  const { intent, assertCurrent } = input;
  assertCurrent();
  checkProductPaymentIntent(input.room, intent, input.payer, input.features);
  return locked(
    `templ-product-send:${input.room}:${intent.payer}`,
    async () => {
      const saved = outstanding(input.room, intent);
      if (saved) return saved;
      if (Date.parse(intent.expiresAt) <= Date.now())
        throw new Error("This payment request expired.");
      const wallet = await connectSolanaTransactionWallet(input.payer);
      assertCurrent();
      if (Date.parse(intent.expiresAt) <= Date.now())
        throw new Error("This payment request expired.");
      const transaction = buildSolanaProductTransaction(intent);
      input.progress("Confirm the transfer in your Solana wallet.");
      assertCurrent();
      save({ intent, uncertain: true });
      let hash: string;
      try {
        hash = await wallet.send(transaction);
      } catch (error) {
        if (rejected(error)) clearProductPayment(intent);
        throw error;
      }
      save({ intent, uncertain: false, hash });
      assertCurrent();
      return hash;
    },
  );
}
