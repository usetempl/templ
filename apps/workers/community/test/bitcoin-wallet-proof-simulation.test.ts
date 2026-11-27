import { expect } from "vitest";
import { addressFromPrivateKey, signMessage } from "@orangecheck/bip322";
import { bitcoinWalletProofMessage } from "@templ/chat/bitcoin-wallet-proof";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { canonicalBitcoinProofAddress, verifyBitcoinWalletProof } from "../src/bitcoin-wallet-proof";
import published from "./fixtures/bitcoin-bip322-vectors.json";

// Public signed examples from bitcoin/bips bip-0322/{basic,generated}-test-vectors.json.
// Git blob IDs f32a5bf45ae8b19ca33d0763669f5718879c82f4 and 4677eea4544b9fef4814c85640ff109a4d887264.
simulate("checks published Bitcoin proofs while two visitors sign different support requests", random => {
  for (const vector of random.shuffle(published)) {
    expect(verifyBitcoinWalletProof(vector.address, vector.message, vector.signature)).toBe(vector.accept);
    if (!vector.accept) continue;
    const raw = vector.signature.replace(/^smp/, "");
    expect(verifyBitcoinWalletProof(vector.address, vector.message, raw)).toBe(true);
    expect(verifyBitcoinWalletProof(vector.address, vector.message, "smp" + raw)).toBe(true);
    expect(canonicalBitcoinProofAddress(vector.address.toUpperCase())).toBe(vector.address);
  }

  const hex = "0123456789abcdef";
  const visitors = [0, 1].map(() => {
    // Deterministic test-only scalars. No account, network or transaction is involved.
    const secret = "01" + random.text(hex, 62);
    const address = addressFromPrivateKey(secret, random.pick(["p2wpkh", "p2tr"] as const));
    const request = {
      origin: "https://usetempl.com", workspace: "00000000-0000-7000-8000-000000000001",
      address, conversation: random.chance(0.5) ? "next" : "tc-" + random.text(hex, 32),
      nonce: random.text(hex, 64), expiresAt: 1700000000000 + random.int(1, 100000),
    };
    const message = bitcoinWalletProofMessage(request);
    const signature = signMessage(address, message, secret, { prefixed: random.chance(0.5), auxRand: new Uint8Array(32) });
    return { request, message, signature };
  });
  const [first, other] = visitors;
  expect(verifyBitcoinWalletProof(first!.request.address, first!.message, first!.signature)).toBe(true);
  expect(verifyBitcoinWalletProof(other!.request.address, first!.message, first!.signature)).toBe(false);
  for (const edit of [{ origin: "https://other.invalid" }, { workspace: other!.request.workspace.replace(/^0/, "f") },
    { conversation: "tc-" + random.text(hex, 32) }, { nonce: other!.request.nonce }, { expiresAt: first!.request.expiresAt + 1 }]) {
    const changed = bitcoinWalletProofMessage({ ...first!.request, ...edit });
    expect(verifyBitcoinWalletProof(first!.request.address, changed, first!.signature)).toBe(false);
  }
  for (const sig of [first!.signature + " ", first!.signature + "=", "A".repeat(200), btoa("x".repeat(65))])
    expect(verifyBitcoinWalletProof(first!.request.address, first!.message, sig)).toBe(false);
});
