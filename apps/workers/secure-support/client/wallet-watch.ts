import type {SupportWalletProvider} from "../../../web/src/lib/support-widget";

export type WalletSelection = {accounts: string[]; chain: string};
type Event = "accountsChanged" | "chainChanged" | "disconnect";
type Handler = (value?: unknown) => void;
type Events = {on?(event: Event, handler: Handler): void; removeListener?(event: Event, handler: Handler): void};
function accountsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 100 ||
      value.some(address => typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address))) return null;
  return value.map(address => address.toLowerCase());
}
function chainOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) return null;
  const chain = BigInt(value);
  return chain > 0n ? `0x${chain.toString(16)}` : null;
}
const sameAccounts = (a: string[] | null, b: string[]) => a !== null && a.length === b.length && a.every((address, i) => address === b[i]);
/** The baseline is local provider state checked against the authenticated
 * session. Events grant no sign-in or device approval. Real changes clear the
 * page synchronously; only exact, well-formed normalized repeats are ignored. */
export function watchTeamWallet(provider: SupportWalletProvider, signal: AbortSignal, changed: () => void, baseline?: WalletSelection) {
  const events = provider as unknown as Events;
  let selected = baseline ? {accounts: [...baseline.accounts], chain: baseline.chain} : undefined, closed = false;
  const current = () => {if (closed || signal.aborted) throw new DOMException("Navigation changed", "AbortError");};
  const close = () => {
    if (closed) return;
    closed = true;
    events.removeListener?.("accountsChanged", accounts); events.removeListener?.("chainChanged", chain); events.removeListener?.("disconnect", disconnect);
    signal.removeEventListener("abort", close);
  };
  const invalid = () => {if (closed) return; close(); changed();};
  const accounts: Handler = value => {if (!selected || !sameAccounts(accountsOf(value), selected.accounts)) invalid();};
  const chain: Handler = value => {if (!selected || chainOf(value) !== selected.chain) invalid();};
  const disconnect: Handler = () => invalid();
  events.on?.("accountsChanged", accounts); events.on?.("chainChanged", chain); events.on?.("disconnect", disconnect);
  signal.addEventListener("abort", close, {once: true});
  if (signal.aborted) close();
  return {
    async confirm(address: string, checkIntent: () => void): Promise<WalletSelection> {
      current();
      const accounts = accountsOf(await provider.request({method: "eth_accounts"})); current(); checkIntent();
      const chain = chainOf(await provider.request({method: "eth_chainId"})); current(); checkIntent();
      if (!accounts || !chain || accounts[0] !== address.toLowerCase() ||
          selected && (!sameAccounts(accounts, selected.accounts) || chain !== selected.chain)) {
        invalid(); throw new Error("Your wallet changed. Sign in again.");
      }
      selected = {accounts, chain};
      return {accounts: [...accounts], chain};
    },
    close,
  };
}
