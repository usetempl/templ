import { isAddress } from "viem";
import { decodeAddress } from "@orangecheck/bip322";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { isSolanaAddress } from "@templ/chat/solana";
import { isSolanaSignature } from "@templ/chat/diagnosis/subject";
import { parseWidgetWallet } from "@templ/chat/widget-wallet";
import { canonicalBitcoinProofAddress } from "./bitcoin-wallet-proof";
import type { TeamConversationRecord } from "./team-conversations";

export type CryptoChain = "bitcoin" | "ethereum" | "solana";
export type CryptoWalletRef = { chain: CryptoChain; address: string; chainId?: number };
type Target = { chain: CryptoChain; subject: "address" | "transaction"; value: string; permalink?: string };
export type CryptoLookupSelection =
  | { kind: "none" }
  | { kind: "clarify"; reason: "choose-wallet" | "need-address" | "choose-network" | "need-explorer"; chains?: string[] }
  | ({ kind: "lookup"; from: "pasted" | "verified" } & Target);

export function cryptoCaseWallets(record: TeamConversationRecord): CryptoWalletRef[] {
  if (record.encryptedCases || record.room !== "room:" + CRYPTO_SUPPORT_WORKSPACE) return [];
  const wallets = new Map<string, CryptoWalletRef>();
  for (const proof of [record.sharedVerifiedWallet, ...(record.sharedVerifiedWallets ?? [])]) {
    const wallet = parseWidgetWallet(proof);
    if (!wallet) continue;
    const value: CryptoWalletRef = wallet.network === "evm"
      ? { chain: "ethereum", address: wallet.address, chainId: wallet.chainId }
      : { chain: "solana", address: wallet.address };
    wallets.set(value.chain + "/" + value.address, value);
  }
  for (const proof of record.sharedVerifiedBitcoinWallets ?? []) {
    const address = canonicalBitcoinProofAddress(proof);
    if (address) wallets.set("bitcoin/" + address, { chain: "bitcoin", address });
  }
  return [...wallets.values()];
}

const explorers: Record<string, CryptoChain> = {
  "etherscan.io": "ethereum", "eth.blockscout.com": "ethereum",
  "mempool.space": "bitcoin", "blockstream.info": "bitcoin",
  "explorer.solana.com": "solana", "solscan.io": "solana",
};
const mentionedChain: Record<CryptoChain, RegExp> = {
  ethereum: /\b(?:ethereum|ether|eth)\b|以太坊/iu,
  bitcoin: /\b(?:bitcoin|btc|satoshis?)\b|比特币|比特幣/iu,
  solana: /\b(?:solana|sol)\b|索拉纳/iu,
};
const otherNetwork = /\b(?:arbitrum|optimism|polygon|avalanche|bnb|bsc|zksync|linea|sepolia|hole[šs]ky|devnet|testnet|regtest|signet|base(?:scan| mainnet| network| chain)|(?:on|no|na|en|sur|auf|via) base)\b/i;
const activity = /\b(?:balance|holdings?|history|activity|transactions?|payments?|transfers?|deposits?|withdrawals?|received|sent|arrived|charged|saldo|extrato|hist[oó]ric[oa]|moviment[oa]s?|transaç[ãõ](?:o|es)|transfer[eê]ncias?|recebi|enviei|pagamentos?|historial|transacciones|actividad|movimientos|movements|historique|solde|virements?|transferts?|guthaben|verlauf|transaktionen)\b|余额|餘額|交易|履歴|残高/iu;
const specificWallet = /\b(?:(?:my|this|that|the verified|the shared|linked|verified) (?:bitcoin |ethereum |solana |eth |sol |btc )?(?:wallet|address|account|activity|balance|history|transactions?|transfer|payment|deposit|withdrawal)|(?:minha|meu|mi|esta?|essa?|ma|mon|ce|mein(?:e[rm]?)?) (?:carteira|endereço|conta|saldo|extrato|wallet|direcci[oó]n|billetera|cuenta|solde|portefeuille|adresse|konto|guthaben)|(?:inspect|look (?:at|up)|check|show|veja|verifique|consulta|revise|vérifie) (?:my |the |a |o )?(?:wallet|address|carteira|balance|transactions?))\b|我的|私の/iu;
const directRequest = /\b(?:look (?:at|up)|inspect|check|verifique|consulta|vérifie) (?:my|this|that|a minha|mi|mon|ma) (?:wallet|address|carteira|billetera|adresse|portefeuille)\b/iu;
const noLookup = /\b(?:do not|don't|don’t|never|please avoid) (?:check|use|inspect|look|read|query|fetch)|\b(?:não|no) (?:consult[ea]|verifiqu?e|uses|busques)\b/i;
const opaqueHex = /^(?:0x)?[0-9a-f]{64}$/i;
const ethereumAddress = /^0x[0-9a-f]{40}$/i;
const selfService = /\b(?:how (?:can|do|would|could) (?:i|we)|how to|how (?:can|do) (?:people|visitors)|como (?:posso|puedo|faço)|comment (?:puis-je|faire)|wie (?:kann|prüfe) ich)\b/iu;
function bitcoinAddress(value: string): string | null {
  if (!/^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[0-9a-z]{8,86})$/i.test(value)) return null;
  if (/^bc1/i.test(value) && value !== value.toLowerCase() && value !== value.toUpperCase()) return null;
  const canonical = /^bc1/i.test(value) ? value.toLowerCase() : value;
  return decodeAddress(canonical)?.network === "mainnet" ? canonical : null;
}

function addressTarget(value: string): Target | undefined {
  if (ethereumAddress.test(value)) {
    const body = value.slice(2);
    if (body !== body.toUpperCase() && body !== body.toLowerCase() && !isAddress(value, { strict: true })) return;
    return { chain: "ethereum", subject: "address", value: value.toLowerCase() };
  }
  const address = bitcoinAddress(value);
  if (address) return { chain: "bitcoin", subject: "address", value: address };
  if (isSolanaAddress(value)) return { chain: "solana", subject: "address", value };
}

function explorerTarget(raw: string): Target | undefined {
  if (!/^https:\/\/[a-z0-9.]+\/[a-zA-Z0-9/]+$/.test(raw)) return;
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return;
  const chain = Object.hasOwn(explorers, url.hostname) ? explorers[url.hostname] : undefined;
  const path = /^\/(address|account|tx)\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
  if (!chain || !path) return;
  const [, kind, value] = path;
  if (kind !== "tx") {
    const target = addressTarget(value);
    return target?.chain === chain ? target : undefined;
  }
  if (chain === "solana" ? !isSolanaSignature(value)
    : chain === "ethereum" ? !/^0x[0-9a-f]{64}$/i.test(value) : !/^[0-9a-f]{64}$/i.test(value)) return;
  return { chain, subject: "transaction", value: chain === "solana" ? value : value.toLowerCase(), permalink: raw };
}

export function resolveCryptoLookup(text: string, verified: readonly CryptoWalletRef[], previousQuestion?: string): CryptoLookupSelection {
  if (!text || text.length > 8192 || noLookup.test(text)) return { kind: "none" };
  const targets = new Map<string, Target>();
  let explorer = false, ambiguousId = false, unsupportedLink = false, invalidAddress = false;
  const add = (target: Target) => targets.set(target.chain + "/" + target.value, target);
  const rest = text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\s<>]+/gi, raw => {
    const target = explorerTarget(raw.replace(/[.,!?)\]]+$/g, ""));
    if (target) { add(target); explorer = true; }
    else unsupportedLink = true;
    return " ";
  });
  for (const word of rest.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (opaqueHex.test(word) || isSolanaSignature(word)) { ambiguousId = true; continue; }
    const address = addressTarget(word);
    if (address) add(address);
    else if (/^(?:0x[0-9a-z]{12,}|(?:bc1|tb1|bcrt1)[a-z0-9]{12,})$/i.test(word)) invalidAddress = true;
  }
  const chains = (Object.keys(mentionedChain) as CryptoChain[]).filter(chain => mentionedChain[chain].test(rest));
  if (ambiguousId) return { kind: "clarify", reason: "need-explorer" };
  if (invalidAddress) return { kind: "clarify", reason: "need-address" };
  if (targets.size > 1) return { kind: "clarify", reason: "choose-wallet" };
  const target = targets.values().next().value;
  if (target) {
    if (otherNetwork.test(rest) || (chains.length && !chains.includes(target.chain))) return { kind: "clarify", reason: "choose-network" };
    if (!explorer && target.chain === "ethereum" && !chains.includes("ethereum") &&
        !verified.some(wallet => wallet.address === target.value && wallet.chainId === 1)) return { kind: "clarify", reason: "choose-network" };
    return { kind: "lookup", from: "pasted", ...target };
  }
  if (previousQuestion && chains.length === 1 && rest.trim().length <= 32 &&
      /^(?:(?:on|it[’']?s|use|na|no|en|em|sur)\s+)?(?:ethereum|ether|eth|solana|sol|bitcoin|btc|以太坊|比特币|比特幣)(?:\s+mainnet)?[\s.!?]*$/iu.test(rest.trim())) {
    const earlier = resolveCryptoLookup(previousQuestion, verified);
    if (earlier.kind === "clarify" && (earlier.reason === "choose-network" || earlier.reason === "choose-wallet")) {
      return resolveCryptoLookup(previousQuestion + "\n" + text, verified);
    }
  }
  if (unsupportedLink) return activity.test(rest) ? { kind: "clarify", reason: "need-explorer" } : { kind: "none" };
  if (!directRequest.test(rest) && (!specificWallet.test(rest) || !activity.test(rest))) return { kind: "none" };
  if (selfService.test(rest)) return { kind: "none" };
  if (otherNetwork.test(rest)) return { kind: "clarify", reason: "choose-network" };
  const matches = verified.filter(wallet => !chains.length || chains.includes(wallet.chain));
  if (!matches.length) return { kind: "clarify", reason: "need-address" };
  if (matches.length > 1) return { kind: "clarify", reason: "choose-wallet", chains: [...new Set(matches.map(wallet => wallet.chain))] };
  const wallet = matches[0]!;
  if (wallet.chain === "ethereum" && wallet.chainId !== 1 && !chains.includes("ethereum")) return { kind: "clarify", reason: "choose-network" };
  return { kind: "lookup", from: "verified", subject: "address", chain: wallet.chain, value: wallet.address };
}
