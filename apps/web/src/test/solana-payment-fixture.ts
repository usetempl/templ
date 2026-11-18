import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PRODUCT_SOLANA_TOKEN_PROGRAM,
  PRODUCT_SOLANA_MEMO_PROGRAM,
  getProductPaymentAsset,
  type SolanaProductPaymentIntent,
} from "@templ/chat/product-payment";
import { paymentIntent } from "./product-payment-fixture";

export function solanaPaymentIntent(): SolanaProductPaymentIntent {
  const payer = "11111111111111111111111111111111";
  const recipient = "2DuL55jht2d758yCvXNRVzWxshhiBkkm936b7D3msugb";
  const asset = getProductPaymentAsset("solana", "USDC")!;
  const account = (owner: string) =>
    getAssociatedTokenAddressSync(
      new PublicKey(asset.address),
      new PublicKey(owner),
    ).toBase58();
  return {
    ...paymentIntent(),
    kind: "solana",
    chainId: "solana",
    network: "solana",
    rail: "solana-usdc",
    payer,
    recipient,
    asset,
    usdCents: 9900,
    amountRaw: "99000000",
    status: "open",
    expectedFinalitySeconds: 32,
    sourceTokenAccount: account(payer),
    destinationTokenAccount: account(recipient),
    tokenProgram: PRODUCT_SOLANA_TOKEN_PROGRAM,
    memoProgram: PRODUCT_SOLANA_MEMO_PROGRAM,
    memo: "Templ payment test",
    recentBlockhash: payer,
    lastValidBlockHeight: 100,
  };
}
