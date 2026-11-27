import { keccak_256 } from "@noble/hashes/sha3";
import { sharedWalletAddresses } from "@templ/chat/widget-wallet";
import type { TailHost } from "./support-widget";

/** EIP-55 is a display convention. Requests still use the stored address. */
export function displayWalletAddress(address: string) {
  if (!/^0x[\da-f]{40}$/i.test(address)) return address;
  const hex = address.slice(2).toLowerCase();
  const digest = keccak_256(new TextEncoder().encode(hex));
  return "0x" + Array.from(hex, (digit, i) => {
    const half = i % 2 ? digest[i >> 1]! & 15 : digest[i >> 1]! >> 4;
    return half >= 8 ? digit.toUpperCase() : digit;
  }).join("");
}

export function caseWalletAddresses(host: TailHost) {
  return sharedWalletAddresses(host.walletCase?.(), host.verifiedWallet?.());
}

export function verifiedAddress(host: TailHost, address: string) {
  const label = host.el("span", undefined, "wallet-proof");
  const value = host.el("bdi", displayWalletAddress(address));
  value.dir = "ltr";
  const verified = host.el("span", "Verified", "sr");
  label.append(value, verified);
  return label;
}

/** Only proofs attached to this case give People addresses to show or copy. */
export function walletRoster(host: TailHost, panel: HTMLElement, signal: AbortSignal) {
  const doc = panel.ownerDocument;
  const menu = panel.querySelector<HTMLDetailsElement>(".chat-options")!;
  const toast = doc.createElement("div");
  toast.className = "wallet-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-atomic", "true");
  panel.append(toast);
  let owner: HTMLElement | null = null;
  let fallback = "";
  let shown: string | undefined;
  let lifetime: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAttempt = 0;
  function clearToast() {
    ++lastAttempt;
    clearTimeout(timer);
    toast.replaceChildren();
  }
  signal.addEventListener("abort", () => { lifetime?.abort(); clearToast(); toast.remove(); }, { once: true });
  menu.addEventListener("toggle", () => { if (!menu.open) clearToast(); }, { signal });

  function addressButton(address: string, row: AbortSignal) {
    const label = verifiedAddress(host, address);
    const canonical = label.querySelector("bdi")!.textContent!;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "wallet-identity";
    button.setAttribute("aria-label", "Copy verified wallet address " + canonical);
    button.append(label);
    button.addEventListener("click", async () => {
      clearToast();
      const attempt = lastAttempt;
      try {
        await navigator.clipboard.writeText(canonical);
        if (row.aborted || attempt !== lastAttempt || !menu.open) return;
        toast.textContent = "Address copied";
        timer = setTimeout(clearToast, 3500);
      } catch {
        if (row.aborted || attempt !== lastAttempt || !menu.open) return;
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
    if (host.walletName && /^0x[\da-f]{40}$/i.test(canonical)) {
      const resolve = () => {
        if (!menu.open) return;
        menu.removeEventListener("toggle", resolve);
        void host.walletName?.(canonical as `0x${string}`)
          .then(name => { if (name && !row.aborted) button.title = name; })
          .catch(() => { /* Keep displaying the checksummed address. */ });
      };
      menu.addEventListener("toggle", resolve, { signal: row });
      resolve();
    }
    return button;
  }

  return () => {
    const cell = panel.querySelector<HTMLElement>(".chat-roster > div:first-child small");
    const addresses = caseWalletAddresses(host);
    const key = JSON.stringify([host.thread?.(), addresses]);
    if (owner === cell && shown === key) return;
    lifetime?.abort();
    clearToast();
    if (owner === cell && cell?.querySelector(".wallet-identity")) cell.textContent = fallback;
    owner = cell;
    shown = key;
    if (!cell || !addresses.length) return;
    fallback = cell.textContent ?? "";
    lifetime = new AbortController();
    const row = lifetime.signal;
    cell.replaceChildren(...addresses.map(address => addressButton(address, row)));
  };
}
