import {digestValue, object, opaqueId, parseCase, type E2eeCase, type OwnSupportEncryptionProfile} from "@templ/e2ee/protocol";
import type {SupportClient, SupportWallet, SupportWalletProvider, SupportSolanaWallet} from "../../../web/src/lib/support-widget";

type Selected = {address: string; chainId?: number; network?: "solana"};
type Intent = {v: 1; profile: string; account: string; draftId: string; from: string; ref?: E2eeCase;
  selected?: Selected; phase: "prepared" | "verifying" | "verified"; principal?: string};
const intentKey = (profile: OwnSupportEncryptionProfile) => `templ:own-wallet-intent:v1:${profile.workspace}:${profile.rootKey}`;
const mappingKey = (profile: OwnSupportEncryptionProfile, principal: string, ref?: E2eeCase) =>
  `templ:own-device-account:v1:${profile.workspace}:${profile.rootKey}:${principal}:${ref ? `${ref.conversation}:${ref.caseSeq}` : "opening"}`;
function checked(profile: OwnSupportEncryptionProfile, value: unknown): Intent {
  const data = object(value, ["v", "profile", "account", "draftId", "from", "phase"], ["ref", "selected", "principal"]);
  if (data.v !== 1 || data.profile !== profile.signature || typeof data.from !== "string" || !/^[\w:-]{1,128}$/.test(data.from) ||
      !["prepared", "verifying", "verified"].includes(String(data.phase))) throw new Error("The saved wallet request could not be verified.");
  digestValue(data.account); opaqueId(data.draftId);
  if (data.ref) {const scope = parseCase(data.ref); if (scope.workspace !== profile.workspace || scope.environment !== profile.environment) throw new Error("The wallet request belongs to another workspace.");}
  if (data.selected) {
    const selected = object(data.selected, ["address"], ["chainId", "network"]);
    if (selected.network === "solana" ? typeof selected.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(selected.address) || selected.chainId !== undefined
      : selected.network !== undefined || typeof selected.address !== "string" || !/^0x[a-f0-9]{40}$/.test(selected.address) || !Number.isSafeInteger(selected.chainId) || Number(selected.chainId) < 1)
      throw new Error("Select the wallet used for this request.");
  }
  if (data.principal !== undefined && (typeof data.principal !== "string" || !/^[\w:-]{1,128}$/.test(data.principal))) throw new Error("The wallet identity could not be verified.");
  if ((data.phase === "verifying" || data.phase === "verified") && !data.selected || data.phase === "verified" && !data.principal)
    throw new Error("The saved wallet verification is incomplete.");
  return data as Intent;
}
/** Public local lookup hints only. Possession, the native owner and the exact
 * case's authority binding are still checked before any encrypted read. */
export function memberWalletIntent(profile: OwnSupportEncryptionProfile) {
  const text = localStorage.getItem(intentKey(profile));
  return text ? checked(profile, JSON.parse(text)) : undefined;
}
export function memberDeviceAccount(profile: OwnSupportEncryptionProfile, principal: string, ref?: E2eeCase) {
  const text = localStorage.getItem(mappingKey(profile, principal, ref));
  if (!text) return;
  const intent = checked(profile, JSON.parse(text));
  if (intent.phase !== "verified" || intent.principal !== principal || JSON.stringify(intent.ref) !== JSON.stringify(ref)) throw new Error("Open the chat with its approved device.");
  return {account: intent.account, draftId: intent.draftId};
}
export function prepareMemberWallet(profile: OwnSupportEncryptionProfile, value: Pick<Intent, "account" | "draftId" | "from" | "ref">) {
  const old = memberWalletIntent(profile);
  if (old && old.phase === "verifying") throw new Error("Finish the pending wallet verification first.");
  const intent = checked(profile, {v: 1, profile: profile.signature, ...value, phase: "prepared"});
  localStorage.setItem(intentKey(profile), JSON.stringify(intent)); return intent;
}
export function forgetMemberWallet(profile: OwnSupportEncryptionProfile) {localStorage.removeItem(intentKey(profile));}
export function rememberMemberCase(profile: OwnSupportEncryptionProfile, principal: string, ref: E2eeCase, account: string, draftId: string) {
  const intent = memberWalletIntent(profile);
  if (!intent || intent.phase !== "verified" || intent.principal !== principal || intent.account !== account || intent.draftId !== draftId) return;
  intent.ref = ref; localStorage.setItem(intentKey(profile), JSON.stringify(intent));
  localStorage.setItem(mappingKey(profile, principal, ref), JSON.stringify(intent));
}
export function memberWalletProvider(network: "evm" | "solana"): SupportWallet {
  const source = window as Window & {ethereum?: SupportWalletProvider; solana?: SupportSolanaWallet};
  if (network === "solana" && source.solana) return {solana: source.solana};
  if (network === "evm" && source.ethereum) return {evm: source.ethereum};
  throw new Error(`Open the secure support page in a browser with your ${network === "solana" ? "Solana" : "EVM"} wallet.`);
}
export async function verifyMemberWallet(profile: OwnSupportEncryptionProfile, client: SupportClient, network: "evm" | "solana", current: () => void, expecting: (address: string) => void) {
  const intent = memberWalletIntent(profile);
  if (!intent) throw new Error("Open Verify wallet from your chat first.");
  const uncertain = intent.phase === "verifying";
  const provider = memberWalletProvider(network); client.setWallet(provider); current();
  let selected = await client.reportedWallet(); current();
  if (!selected) {
    if (provider.evm) await provider.evm.request({method: "eth_requestAccounts"});
    else if ("connect" in provider.solana! && provider.solana.connect) await provider.solana.connect();
    else throw new Error("Connect your Solana wallet first.");
    current(); selected = await client.reportedWallet(); current();
  }
  if (!selected || intent.selected && JSON.stringify(intent.selected) !== JSON.stringify(selected)) throw new Error("Select the wallet and network used for this request.");
  intent.selected = selected; intent.phase = "verifying";
  // Persist before the native challenge can move ownership. A lost reply is
  // reconciled by another explicit proof, never by replaying a chat message.
  localStorage.setItem(intentKey(profile), JSON.stringify(checked(profile, intent)));
  expecting(selected.address);
  try {await client.signIn();}
  catch (error) {
    current();
    // A definite refusal settles only this attempt. It cannot establish the
    // result of an earlier proof whose reply was lost.
    if (!uncertain && ([403, 404].includes((error as {status?: number}).status ?? 0) || (error as Error).message === "Signature cancelled. Nothing was sent.")) {
      intent.phase = "prepared"; localStorage.setItem(intentKey(profile), JSON.stringify(intent));
    }
    throw error;
  }
  current();
  const session = client.session;
  if (!session || session.level !== "signed" || session.address !== selected.address) throw new Error("Verify the same wallet again to finish opening your chat.");
  const request = client.adopt()[1];
  if (intent.ref) {
    const descriptor = await request<{case: E2eeCase; enrollment: {principal: string; kind: string}}>(`/conversations/${intent.ref.conversation}/encryption/${intent.ref.caseSeq}`); current();
    if (JSON.stringify(parseCase(descriptor.case)) !== JSON.stringify(intent.ref) || descriptor.enrollment.kind !== "member" || descriptor.enrollment.principal !== session.principalId)
      throw new Error("This wallet does not hold the selected chat.");
  }
  intent.principal = session.principalId; intent.phase = "verified";
  localStorage.setItem(intentKey(profile), JSON.stringify(intent));
  if (!intent.ref) {
    const list = await request<{conversations: {id: string; encryption?: {custody: string; caseSeq: number}}[]}>("/conversations?filter=all"); current();
    const existing = list.conversations.find(row => row.encryption?.custody === "templ-own-support");
    if (existing?.encryption) return {principal: session.principalId, existing: parseCase({environment: profile.environment, workspace: profile.workspace, conversation: existing.id, caseSeq: existing.encryption.caseSeq})};
  }
  const key = mappingKey(profile, session.principalId, intent.ref), existing = localStorage.getItem(key);
  if (existing && checked(profile, JSON.parse(existing)).account !== intent.account) throw new Error("This wallet already has another approved device on this browser. Open its chat separately.");
  localStorage.setItem(key, JSON.stringify(intent));
  return {principal: session.principalId, ref: intent.ref};
}
