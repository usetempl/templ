import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import {
  getProductPaymentAsset,
  productSolanaPaymentMemo,
  productRailOf,
  PRODUCT_SOLANA_TOKEN_PROGRAM,
  PRODUCT_SOLANA_MEMO_PROGRAM,
  type SolanaProductPaymentIntent,
} from "@templ/chat/product-payment";
import { PRODUCT_OFFER_VERSION } from "@templ/chat/plans";
import { isSolanaAddress } from "@templ/chat/solana";
import type { ChatRoomId } from "@templ/chat/index";
import { checkTopUp, PAYMENT_MISMATCH } from "./product-offer";
import { paymentRecipient } from "./release-public";
import { productPaymentTransferAmount } from "./product-payment-amount";

/** Build from reviewed fields, never an opaque transaction supplied by an API. */
export function checkSolanaProductPaymentIntent(
  room: ChatRoomId,
  intent: SolanaProductPaymentIntent,
  payer: string,
  available: boolean,
) {
  const recipient = paymentRecipient("solana", intent.asset.symbol);
  const asset = getProductPaymentAsset("solana", intent.asset.symbol);
  if (!available || !recipient || !asset)
    throw new Error("Payments are not available on this network yet.");
  // The amount is a top-up the offer takes, checked here.
  checkTopUp(intent);
  productPaymentTransferAmount(intent);
  if (
    intent.kind !== "solana" ||
    intent.chainId !== "solana" ||
    intent.room !== room ||
    intent.workspace !== room ||
    intent.network !== "solana" ||
    intent.token !== intent.asset.symbol ||
    intent.offerVersion !== PRODUCT_OFFER_VERSION ||
    intent.status !== "open" ||
    intent.rail !== productRailOf("solana", intent.asset.symbol) ||
    !isSolanaAddress(payer) ||
    intent.payer !== payer ||
    intent.payer === intent.recipient ||
    intent.recipient !== recipient.recipient ||
    !isSolanaAddress(intent.recipient) ||
    intent.asset.address !== asset.address ||
    intent.asset.decimals !== asset.decimals ||
    intent.asset.symbol !== asset.symbol ||
    intent.tokenProgram !== PRODUCT_SOLANA_TOKEN_PROGRAM ||
    intent.memoProgram !== PRODUCT_SOLANA_MEMO_PROGRAM ||
    (intent as { test?: unknown }).test !== undefined ||
    intent.amountRaw !==
      (
        BigInt(intent.usdCents) *
        10n ** BigInt(asset.decimals - 2)
      ).toString() ||
    intent.memo !== productSolanaPaymentMemo(intent.id) ||
    (intent.recentBlockhash !== undefined &&
      !isSolanaAddress(intent.recentBlockhash)) ||
    (intent.lastValidBlockHeight !== undefined &&
      (!Number.isSafeInteger(intent.lastValidBlockHeight) ||
        intent.lastValidBlockHeight <= 0)) ||
    !Number.isFinite(Date.parse(intent.createdAt)) ||
    !Number.isFinite(Date.parse(intent.expiresAt)) ||
    Date.parse(intent.expiresAt) <= Date.parse(intent.createdAt)
  )
    throw new Error(PAYMENT_MISMATCH);
  const mint = new PublicKey(asset.address),
    tokenProgram = new PublicKey(intent.tokenProgram);
  const source = getAssociatedTokenAddressSync(
    mint,
    new PublicKey(payer),
    false,
    tokenProgram,
  ).toBase58();
  const destination = getAssociatedTokenAddressSync(
    mint,
    new PublicKey(recipient.recipient),
    false,
    tokenProgram,
  ).toBase58();
  if (
    intent.sourceTokenAccount !== source ||
    intent.destinationTokenAccount !== destination
  )
    throw new Error("The payment token accounts could not be verified.");
  return recipient;
}

export function buildSolanaProductTransaction(
  intent: SolanaProductPaymentIntent,
): Uint8Array {
  const amount = productPaymentTransferAmount(intent);
  if (
    !intent.recentBlockhash ||
    !isSolanaAddress(intent.recentBlockhash) ||
    !intent.lastValidBlockHeight
  )
    throw new Error("Refresh the payment before sending.");
  const payer = new PublicKey(intent.payer);
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: intent.recentBlockhash,
  });
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      new PublicKey(intent.destinationTokenAccount),
      new PublicKey(intent.recipient),
      new PublicKey(intent.asset.address),
      new PublicKey(intent.tokenProgram),
    ),
    createTransferCheckedInstruction(
      new PublicKey(intent.sourceTokenAccount),
      new PublicKey(intent.asset.address),
      new PublicKey(intent.destinationTokenAccount),
      payer,
      BigInt(amount.amountRaw),
      intent.asset.decimals,
      [],
      new PublicKey(intent.tokenProgram),
    ),
  );
  transaction.add(
    new TransactionInstruction({
      programId: new PublicKey(intent.memoProgram),
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(intent.memo, "utf8"),
    }),
  );
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
}
