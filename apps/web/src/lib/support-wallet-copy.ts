import { getAddress, isAddress } from "viem";
import type { TailHost } from "./support-widget";

/** Only a proof attached to the current case gives People an address to copy. */
export function walletRoster(host: TailHost, panel: HTMLElement, signal: AbortSignal) {
  const doc = panel.ownerDocument;
  const people = panel.querySelector<HTMLDetailsElement>(".chat-people")!;
  const toast = doc.createElement("div");
  toast.className = "wallet-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-atomic", "true");
  panel.append(toast);
  let button: HTMLButtonElement | undefined;
  let shown: string | undefined;
  let lifetime: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAttempt = 0;
  function clearToast() {
    clearTimeout(timer);
    toast.replaceChildren();
  }
  signal.addEventListener("abort", () => { lifetime?.abort(); clearToast(); toast.remove(); }, { once: true });
  people.addEventListener("toggle", () => { if (!people.open) { ++lastAttempt; clearToast(); } }, { signal });
  return () => {
    const cell = panel.querySelector<HTMLElement>(".chat-roster > div:first-child small");
    const address = host.verifiedWallet?.();
    if (address === shown && (!address || button?.parentElement === cell)) return;
    lifetime?.abort();
    clearToast();
    if (button?.parentElement === cell && cell) cell.textContent = "Anon";
    button = undefined;
    shown = address;
    if (!cell || !address) return;
    const evm = isAddress(address, { strict: false }) ? getAddress(address) : undefined;
    const canonical = evm ?? address;
    const value = doc.createElement("bdi");
    value.dir = "ltr";
    value.textContent = canonical.slice(0, evm ? 6 : 4) + "…" + canonical.slice(-4);
    const action = doc.createElement("span");
    action.className = "sr";
    action.textContent = "Copy full wallet address for ";
    button = doc.createElement("button");
    button.type = "button";
    button.className = "wallet-identity";
    button.append(action, value);
    cell.replaceChildren(button);
    lifetime = new AbortController();
    const row = lifetime.signal;
    button.addEventListener("click", async () => {
      const attempt = ++lastAttempt;
      clearToast();
      try {
        await navigator.clipboard.writeText(canonical);
        if (row.aborted || attempt !== lastAttempt) return;
        toast.textContent = "Address copied";
        timer = setTimeout(clearToast, 3500);
      } catch {
        if (row.aborted || attempt !== lastAttempt) return;
        const full = doc.createElement("bdi");
        full.dir = "ltr";
        full.textContent = canonical;
        toast.replaceChildren("Couldn’t copy. Select the address to copy it.", full);
        const range = doc.createRange();
        range.selectNodeContents(full);
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }, { signal: row });
    const provider = host.options.wallet?.evm;
    if (evm && provider) {
      const resolve = () => {
        if (!people.open) return;
        people.removeEventListener("toggle", resolve);
        void import("./support-wallet-name").then(module => row.aborted ? undefined : module.verifiedWalletName(evm, provider))
          .then(name => {
            if (!name || row.aborted) return;
            value.className = "wallet-name";
            value.textContent = name;
          })
          .catch(() => { /* Keep displaying the checksummed address. */ });
      };
      people.addEventListener("toggle", resolve, { signal: row });
      resolve();
    }
  };
}
