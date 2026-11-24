import { createClient, custom, type Address } from "viem";
import { getEnsAddress, getEnsName } from "viem/actions";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import type { SupportWalletProvider } from "./support-widget";

/** Only read the connected wallet's Ethereum resolver. Never prompt, switch chains,
 * or send the case address to a separate RPC or offchain gateway. */
export async function verifiedWalletName(address: Address, provider: SupportWalletProvider) {
  const chain = () => provider.request({ method: "eth_chainId" });
  if (Number(await chain()) !== mainnet.id) return;
  const accounts = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || !accounts.some(
    account => typeof account === "string" && account.toLowerCase() === address.toLowerCase(),
  )) return;

  const client = createClient({
    chain: mainnet, transport: custom(provider, { retryCount: 0 }), ccipRead: false,
  });
  const primary = await getEnsName(client, { address, gatewayUrls: [] });
  if (!primary) return;
  const name = normalize(primary);
  const resolved = await getEnsAddress(client, { name, gatewayUrls: [] });
  if (resolved?.toLowerCase() === address.toLowerCase() && Number(await chain()) === mainnet.id)
    return name;
}
