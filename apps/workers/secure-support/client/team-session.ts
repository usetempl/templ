import {parseSiweMessage} from "viem/siwe";
import {stringToHex} from "viem";
import type {SupportWalletProvider} from "../../../web/src/lib/support-widget";

export type TeamSession = {principalId: string; address: `0x${string}`; expiresAt: number};
type Request = <T>(path: string, body?: object) => Promise<T>;
const addressOf = (accounts: unknown) => Array.isArray(accounts) && typeof accounts[0] === "string" && /^0x[a-fA-F0-9]{40}$/.test(accounts[0])
  ? accounts[0] as `0x${string}` : null;
export function checkedTeamSession(value: TeamSession, address?: string) {
  if (!value || typeof value.principalId !== "string" || !value.principalId || value.principalId.length > 256 ||
      typeof value.address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value.address) ||
      (address !== undefined && value.address.toLowerCase() !== address.toLowerCase()) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now())
    throw new Error("Your team sign-in could not be verified. Sign in again.");
  return value;
}
/** Resume only the server-verified session for the currently selected wallet.
 * A session still grants no encryption-device approval. */
export async function signInTeam(provider: SupportWalletProvider, request: Request, checkIntent: () => void): Promise<TeamSession> {
  const readAddress = async () => {const accounts = await provider.request({method: "eth_accounts"}); checkIntent(); return addressOf(accounts);};
  const selected = await readAddress();
  if (selected) {
    let existing: TeamSession | null;
    try {existing = checkedTeamSession(await request<TeamSession>("/native/team/auth/session"));}
    catch (error) {if ((error as {status?: number})?.status !== 401) throw error; existing = null;}
    checkIntent();
    if (existing && typeof existing.address === "string" && existing.address.toLowerCase() === selected.toLowerCase()) {
      checkedTeamSession(existing, selected);
      if ((await readAddress())?.toLowerCase() !== selected.toLowerCase()) throw new Error("Your wallet changed. Sign in again.");
      return existing;
    }
  }
  await provider.request({method: "eth_requestAccounts"}); checkIntent();
  const address = await readAddress();
  if (!address) throw new Error("Select your team wallet first.");
  const chain = await provider.request({method: "eth_chainId"}); checkIntent();
  if (typeof chain !== "string" || !/^0x[0-9a-fA-F]+$/.test(chain)) throw new Error("Select a supported wallet network.");
  const chainId = Number.parseInt(chain, 16);
  const challenge = await request<{message: string; expiresAt: number}>("/native/team/auth/nonce", {address, chainId}); checkIntent();
  const parsed = parseSiweMessage(challenge.message);
  if (parsed.domain !== "usetempl.com" || parsed.uri !== "https://usetempl.com" || parsed.chainId !== chainId ||
      parsed.address?.toLowerCase() !== address.toLowerCase() || !parsed.expirationTime || parsed.expirationTime.getTime() <= Date.now())
    throw new Error("The wallet sign-in message could not be verified.");
  const signature = await provider.request({method: "personal_sign", params: [stringToHex(challenge.message), address]}); checkIntent();
  if (typeof signature !== "string") throw new Error("Wallet sign-in was cancelled.");
  const session = checkedTeamSession(await request<TeamSession>("/native/team/auth/verify", {message: challenge.message, signature}), address); checkIntent();
  if ((await readAddress())?.toLowerCase() !== address.toLowerCase()) throw new Error("Your wallet changed. Sign in again.");
  return session;
}
