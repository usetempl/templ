import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, toFunctionSelector, zeroAddress } from "viem";
import { verifiedWalletName } from "./support-wallet-name";
import type { SupportWalletProvider } from "./support-widget";

const address = getAddress("0x5aeda56215b167893e80b4fe645ba6d5bab767de");
function wallet(forward: typeof address, chain = "0x1") {
  const calls: string[] = [];
  const provider: SupportWalletProvider = {
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_chainId") return chain;
      if (method === "eth_accounts") return [address.toLowerCase()];
      if (method !== "eth_call") throw Error("Unexpected wallet request");
      const { data } = params![0] as { data: string };
      switch (data.slice(0, 10)) {
        case toFunctionSelector("reverseWithGateways(bytes,uint256,string[])"):
          return encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "address" }], ["visitor.eth", address, address]);
        case toFunctionSelector("resolveWithGateways(bytes,bytes,string[])"):
          return encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [encodeAbiParameters([{ type: "address" }], [forward]), address]);
        default: throw Error("Unexpected resolver call");
      }
    },
  };
  return { provider, calls };
}
describe("the People drawer's verified name", () => {
  it("requires both ENS records to identify the shared address", async () => {
    const match = wallet(address);
    await expect(verifiedWalletName(address, match.provider)).resolves.toBe("visitor.eth");
    expect(match.calls).toEqual(["eth_chainId", "eth_accounts", "eth_call", "eth_call", "eth_chainId"]);
    await expect(verifiedWalletName(address, wallet(zeroAddress).provider)).resolves.toBeUndefined();
  });
  it("keeps the address without switching networks or requesting a connection", async () => {
    const otherNetwork = wallet(address, "0x2105");
    await expect(verifiedWalletName(address, otherNetwork.provider)).resolves.toBeUndefined();
    expect(otherNetwork.calls).toEqual(["eth_chainId"]);
    const otherAccount = wallet(address);
    await expect(verifiedWalletName(zeroAddress, otherAccount.provider)).resolves.toBeUndefined();
    expect(otherAccount.calls).toEqual(["eth_chainId", "eth_accounts"]);
  });
});
