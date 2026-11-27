import { expect } from "vitest";
import {
  encodeAbiParameters,
  getAddress,
  toFunctionSelector,
  type Address,
} from "viem";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { verifiedWalletName } from "./support-wallet-name";
import type { SupportWalletProvider } from "./support-widget";

const HEX = [..."0123456789abcdef"];
const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];
const address = (draw: Rng) => getAddress(`0x${draw.text(HEX, 40)}`);

/** A connected wallet whose resolver answers both ENS records. `chains` are
 * its answers to successive network checks; the last one repeats. */
function wallet(
  draw: Rng,
  records: { connected: Address; primary: string; forward: Address },
  chains = ["0x1"],
) {
  const calls: string[] = [];
  let checks = 0;
  const provider: SupportWalletProvider = {
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_chainId")
        return chains[Math.min(checks++, chains.length - 1)];
      if (method === "eth_accounts")
        return [
          draw.chance(0.5) ? records.connected.toLowerCase() : records.connected,
        ];
      if (method !== "eth_call") throw Error("Unexpected wallet request");
      const { data } = params![0] as { data: string };
      switch (data.slice(0, 10)) {
        case toFunctionSelector("reverseWithGateways(bytes,uint256,string[])"):
          return encodeAbiParameters(
            [{ type: "string" }, { type: "address" }, { type: "address" }],
            [records.primary, records.connected, records.connected],
          );
        case toFunctionSelector("resolveWithGateways(bytes,bytes,string[])"):
          return encodeAbiParameters(
            [{ type: "bytes" }, { type: "address" }],
            [
              encodeAbiParameters([{ type: "address" }], [records.forward]),
              records.connected,
            ],
          );
        default:
          throw Error("Unexpected resolver call");
      }
    },
  };
  return { provider, calls };
}

simulate(
  "sim:unit the People drawer names a wallet only when both ENS records identify the shared address, without prompting or switching networks",
  async (draw) => {
    const shared = address(draw);
    const name = `${draw.text(LETTERS, draw.int(3, 12))}.eth`;
    const primary = draw.chance(0.5)
      ? name
      : name[0].toUpperCase() + name.slice(1);
    const records = { connected: shared, primary, forward: shared };

    const match = wallet(draw, records);
    await expect(verifiedWalletName(shared, match.provider)).resolves.toBe(name);
    expect(match.calls).toEqual([
      "eth_chainId",
      "eth_accounts",
      "eth_call",
      "eth_call",
      "eth_chainId",
    ]);

    // A name that resolves elsewhere, or no name, leaves the address unnamed.
    const elsewhere = wallet(draw, { ...records, forward: address(draw) });
    await expect(
      verifiedWalletName(shared, elsewhere.provider),
    ).resolves.toBeUndefined();
    const unnamed = wallet(draw, { ...records, primary: "" });
    await expect(
      verifiedWalletName(shared, unnamed.provider),
    ).resolves.toBeUndefined();
    expect(unnamed.calls).toEqual(["eth_chainId", "eth_accounts", "eth_call"]);

    // Another network is left as it is, before any account or resolver read.
    const chain = draw.pick(["0x2105", "0x38", "0xa4b1", "0x89"]);
    const otherNetwork = wallet(draw, records, [chain]);
    await expect(
      verifiedWalletName(shared, otherNetwork.provider),
    ).resolves.toBeUndefined();
    expect(otherNetwork.calls).toEqual(["eth_chainId"]);
    const switched = wallet(draw, records, ["0x1", chain]);
    await expect(
      verifiedWalletName(shared, switched.provider),
    ).resolves.toBeUndefined();

    // A case address the wallet has not connected is never sent to its resolver.
    const otherAccount = wallet(draw, records);
    await expect(
      verifiedWalletName(address(draw), otherAccount.provider),
    ).resolves.toBeUndefined();
    expect(otherAccount.calls).toEqual(["eth_chainId", "eth_accounts"]);

    for (const used of [match, elsewhere, unnamed, otherNetwork, switched])
      expect(
        used.calls.filter(
          (method) =>
            !["eth_chainId", "eth_accounts", "eth_call"].includes(method),
        ),
      ).toEqual([]);
  },
);
