import { expect } from "vitest";
import { base58Encode } from "@templ/chat/solana";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { cryptoCaseWallets, resolveCryptoLookup } from "../src/crypto-lookup-target";
import type { TeamConversationRecord } from "../src/team-conversations";
import vectors from "./fixtures/bitcoin-bip322-vectors.json";

simulate("uses the public address in the message or a current proof shared in this conversation", random => {
  const address = "0x" + random.text("abcdef0123456789", 40);
  const other = "0x" + random.text("0123456789abcdef", 40);
  const bitcoin = random.pick(vectors.filter(vector => vector.accept)).address;
  const solana = "11111111111111111111111111111111";
  const record = {
    room: "room:" + CRYPTO_SUPPORT_WORKSPACE,
    sharedVerifiedWallets: [{ network: "evm", address, chainId: 1 }, { network: "solana", address: solana }],
    sharedVerifiedBitcoinWallets: [bitcoin],
  } as TeamConversationRecord;
  const verified = cryptoCaseWallets(record);
  expect(verified).toHaveLength(3);
  const action = { kind: "lookup", subject: "address", chain: "ethereum", value: other, from: "pasted" };
  expect(resolveCryptoLookup("Ethereum activity for " + other, [])).toEqual(action);
  expect(resolveCryptoLookup("Ethereum activity for " + other, verified)).toEqual(action);
  expect(resolveCryptoLookup("check my wallet", verified)).toMatchObject({ kind: "clarify", reason: "choose-wallet" });
  expect(resolveCryptoLookup("What is the balance of my Bitcoin wallet?", verified)).toEqual({
    kind: "lookup", subject: "address", chain: "bitcoin", value: bitcoin, from: "verified",
  });
  expect(resolveCryptoLookup("What is the balance of my Solana wallet?", verified)).toMatchObject({ from: "verified", value: solana });
  expect(resolveCryptoLookup("Qual é o saldo da minha carteira?", verified.slice(0,1))).toMatchObject({ from: "verified", value: address });
  expect(resolveCryptoLookup("what is self custody?", verified)).toEqual({ kind: "none" });
  expect(resolveCryptoLookup("How do I check my wallet balance?", verified)).toEqual({ kind: "none" });
  expect(resolveCryptoLookup("Don't check my balance", verified)).toEqual({ kind: "none" });
  expect(resolveCryptoLookup("Check my wallet", [])).toMatchObject({ kind: "clarify", reason: "need-address" });
  expect(cryptoCaseWallets({ ...record, encryptedCases: true })).toEqual([]);
  expect(cryptoCaseWallets({ ...record, room: "room:neighbor" })).toEqual([]);
  expect(cryptoCaseWallets({ ...record, sharedVerifiedBitcoinWallets: [] }).some(w => w.chain === "bitcoin")).toBe(false);
  expect(resolveCryptoLookup("Look up " + bitcoin, [])).toMatchObject({ from: "pasted", chain: "bitcoin" });
  expect(resolveCryptoLookup("Check " + address + " on Arbitrum", verified)).toMatchObject({ kind: "clarify", reason: "choose-network" });
  expect(resolveCryptoLookup("Ethereum", [], "Can you check this address " + other + "?")).toEqual(action);
  expect(resolveCryptoLookup("Bitcoin", verified, "Check my wallet")).toMatchObject({ chain: "bitcoin", value: bitcoin });
  expect(resolveCryptoLookup("Ethereum", verified, "What is self-custody?")).toEqual({ kind: "none" });
  expect(resolveCryptoLookup("My wallet balance at 0x123456789abcde", verified.slice(0, 1))).toEqual({ kind: "clarify", reason: "need-address" });
  expect(resolveCryptoLookup("Check my wallet at https://nobody.invalid/address/" + address, verified)).toMatchObject({ kind: "none" });
  const id = random.text("abcdef0123456789",64);
  const signature = base58Encode(Uint8Array.from({ length: 64 }, () => random.int(0, 255)));
  expect(resolveCryptoLookup("https://solscan.io/tx/" + signature, [])).toMatchObject({ subject: "transaction", chain: "solana", value: signature });
  for (const text of [id, "tx 0x" + id, "Bitcoin transaction " + id, "Solana transaction " + signature]) {
    expect(resolveCryptoLookup(text, verified)).toMatchObject({ kind: "clarify", reason: "need-explorer" });
  }
  for (const link of ["https://etherscan.io.bad.example/tx/0x","https://etherscan.io@evil.example/tx/0x","https://mempool.space/testnet/tx/"]) {
    expect(resolveCryptoLookup("Check my transaction " + link + id, verified).kind).not.toBe("lookup");
  }
  expect(resolveCryptoLookup("What happened? https://etherscan.io/tx/0x" + id, [])).toMatchObject({ subject:"transaction", value:"0x"+id, chain:"ethereum" });
  expect(resolveCryptoLookup("https://mempool.space/tx/" + id, [])).toMatchObject({ subject:"transaction", value:id, chain:"bitcoin" });
});
