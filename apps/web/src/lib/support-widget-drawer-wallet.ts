import type { TailHost, createSupportClient } from "./support-widget";
declare const __TEMPL_WIDGET_WALLET_VIEW__: string | undefined;
declare const __TEMPL_WIDGET_WALLET_STYLE__: string | undefined;

type Proof = { receipt: string; address: string; expires: number; conversation?: string };
type Family = "evm" | "solana";
const families: Family[] = ["evm", "solana"];

function validProof(value: unknown): value is Proof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<Proof>;
  return typeof proof.address === "string" && typeof proof.receipt === "string" &&
    /^[0-9a-f]{64}$/.test(proof.receipt) && typeof proof.expires === "number" &&
    proof.expires > Date.now() && (proof.conversation === undefined || typeof proof.conversation === "string");
}

/** Proofs belong to the guest and case. A proof never supplies a staff or member session. */
export async function drawerWallet(host: TailHost, menu: HTMLElement, signal: AbortSignal) {
  const [view, styles]: [typeof import("./support-wallet-copy"), typeof import("./support-widget-wallet-style")] = await Promise.all([
    typeof __TEMPL_WIDGET_WALLET_VIEW__ === "string"
      ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_WALLET_VIEW__, import.meta.url).href)
      : import("./support-wallet-copy"),
    typeof __TEMPL_WIDGET_WALLET_STYLE__ === "string"
      ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_WALLET_STYLE__, import.meta.url).href)
      : import("./support-widget-wallet-style"),
  ]);
  if (signal.aborted) return;
  const { el } = host;
  host.style.append(document.createTextNode(styles.walletStyle));
  const refreshRoster = view.walletRoster(host, menu.closest(".panel")!, signal);
  const client = host.client as ReturnType<typeof createSupportClient>;
  const section = el("section", undefined, "drawer-section");
  const heading = el("h3", "Wallet verification");
  heading.prepend(host.icon("wallet"));
  const content = el("div", undefined, "drawer-section-body");
  const hint = el("p");
  const list = el("div", undefined, "wallet-list");
  const chooser = el("div", undefined, "wallet-families");
  chooser.setAttribute("role", "group");
  chooser.setAttribute("aria-label", "Choose a wallet network");
  const status = el("p");
  status.setAttribute("role", "status");
  const button = (label: string, action: () => void) => {
    const control = el("button", label, "quiet");
    control.type = "button";
    control.addEventListener("click", action);
    return control;
  };
  const add = button("Verify and share address", () => {
    const account = accountAction();
    if (account) return account.click();
    const choices = offered();
    if (choices.length === 1) void verify(choices[0]);
    else { choosing = true; sync(); chooser.querySelector("button")?.focus(); }
  });
  const retry = button("Retry sharing address", () => {
    const id = thread();
    if (id && client.session) void attach(id, client.session.principalId, false);
  });
  add.classList.add("drawer-primary");
  retry.classList.add("drawer-primary");
  const picks = families.map(family => {
    const pick = button(family === "evm" ? "EVM wallet" : "Solana wallet", () => void verify(family));
    pick.classList.add("drawer-primary");
    chooser.append(pick);
    return pick;
  });
  content.append(hint, list, retry, add, chooser, status);
  section.append(heading, content);
  const notices = menu.querySelector(".drawer-notices");
  if (notices) notices.before(section);
  else menu.append(section);
  const thread = () => host.draftingConversation?.() ? undefined : host.thread?.() ?? client.session?.thread;
  let scope: string | undefined;
  let proofs: Proof[] = [];
  let busy = false;
  let choosing = false;
  let removing: string | undefined;
  let selected: string | undefined;
  let rendered = "";

  function provider(family: Family) {
    if (host.options.walletForNetwork) return host.options.walletForNetwork(family);
    const wallet = client.adopt?.()[5] ?? host.options.wallet;
    return wallet?.[family] ? wallet : null;
  }
  function offered() {
    const rules = host.policy?.walletIdentification;
    return families.filter(family => (rules ? rules.enabled && rules[family] :
      family === "evm" || host.policy?.solanaSignIn) && provider(family));
  }
  function accountAction() {
    if (!host.options.decorateOwnMenu) return;
    const signed = client.session?.level === "signed";
    const required = host.policy?.chatMode === "encrypted" || host.policy?.minimumLevel === "signed" || host.policy?.minimumLevel === "connected";
    if (!signed && (thread() || !required)) return;
    return menu.querySelector<HTMLButtonElement>(signed ? '.tools button[aria-label="Sign out"]' : '.tools button[aria-label="Verify wallet"]');
  }
  function save(next: Proof[]) {
    proofs = next;
    if (!scope) return;
    try {
      if (next.length) sessionStorage.setItem(scope, JSON.stringify(next));
      else sessionStorage.removeItem(scope);
    } catch { /* In-memory proofs remain usable in this visit. */ }
  }
  function attached() {
    const record = host.walletCase?.();
    const first = record?.verifiedWalletAddress ?? host.verifiedWallet?.();
    return record?.verifiedWalletAddresses ?? (first ? [first] : []);
  }
  function rows(addresses: string[]) {
    const multiple = !!host.policy?.walletIdentification;
    const signature = JSON.stringify([addresses, removing, multiple]);
    if (signature !== rendered) {
      rendered = signature;
      list.replaceChildren();
      for (const address of addresses) {
        const row = el("div");
        const label = view.verifiedAddress(host, address);
        const canonical = label.querySelector("bdi")!.textContent!;
        const minus = button("", () => {
          removing = address;
          sync();
          list.querySelector<HTMLButtonElement>("[data-keep]")?.focus();
        });
        minus.classList.add("wallet-remove");
        minus.append(host.icon("minus"), el("span", "Remove"));
        minus.setAttribute("aria-label", "Remove wallet " + canonical);
        minus.dataset.address = address;
        if (removing === address) {
          const question = "Remove this wallet from the chat?";
          row.className = "wallet-confirm";
          row.setAttribute("role", "group");
          row.setAttribute("aria-label", question);
          const cancel = () => { removing = undefined; sync(); focusRow(address); };
          const keep = button("Keep wallet", cancel);
          keep.dataset.keep = "";
          const remove = button("Remove wallet", () => void unlink(address));
          remove.classList.add("drawer-stop");
          const actions = el("div", undefined, "drawer-actions");
          actions.append(remove, keep);
          row.append(el("p", question), label, actions);
          row.addEventListener("keydown", event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (!busy) cancel();
          });
        } else {
          row.append(label);
          if (multiple) row.append(minus);
        }
        list.append(row);
      }
    }
    for (const control of list.querySelectorAll("button")) control.disabled = busy;
  }
  function focusRow(address: string) {
    const control = Array.from(list.querySelectorAll("button")).find(item => item.dataset.address === address);
    (control ?? add).focus();
  }
  function sync() {
    const session = client.session;
    const next = session && `templ:chat-wallet:v1:${host.options.workspace}:${session.principalId}`;
    if (next !== scope) {
      if (scope) save([]);
      scope = next;
      proofs = [];
      if (scope) {
        try {
          const stored = JSON.parse(sessionStorage.getItem(scope) ?? "null");
          proofs = (Array.isArray(stored) ? stored : [stored]).filter(validProof);
        } catch { /* A fresh verification replaces incomplete storage. */ }
      }
      choosing = false; removing = undefined; status.textContent = "";
    }
    if (proofs.some(proof => !validProof(proof))) {
      save(proofs.filter(validProof));
      status.textContent = "Your wallet proof expired. Verify again to share the address.";
    }
    const id = thread();
    if (selected !== id) { selected = id; choosing = false; removing = undefined; status.textContent = ""; }
    const bound = attached();
    const addresses = [...new Set([...bound, ...proofs.filter(proof => proof.conversation === id).map(proof => proof.address)])];
    rows(addresses);
    refreshRoster();
    const choices = offered();
    const account = accountAction();
    const rules = host.policy?.walletIdentification;
    const disabled = !!rules && (!rules.enabled || (!rules.evm && !rules.solana));
    const encrypted = id ? !!host.walletCase?.()?.encryption : host.policy?.chatMode === "encrypted";
    section.hidden = !account && (session?.level === "signed" || encrypted || (disabled && !addresses.length));
    list.hidden = !!account || !addresses.length;
    hint.textContent = account ? (session?.level === "signed" ? "You’re signed in with your wallet." : "This chat requires a wallet. Sign a message to verify it.")
      : addresses.length ? (!id ? "Your first message will share these addresses with this team." : "")
      : choices.length ? "Sign a message to share your verified address with the support team in this chat."
      : "Open this chat in a supported wallet browser to verify your address.";
    add.textContent = account?.textContent ?? (addresses.length ? "+ Verify another wallet" : "Verify and share address");
    add.hidden = !account && (disabled || !!removing || (!rules && addresses.length > 0) || (choosing && choices.length > 1));
    add.disabled = busy || (account ? account.disabled : !choices.length);
    chooser.hidden = !!account || !choosing || choices.length < 2;
    for (const [i, pick] of picks.entries()) { pick.hidden = !choices.includes(families[i]); pick.disabled = busy; }
    retry.hidden = !!account || !id || !proofs.some(proof => proof.conversation === id);
    retry.disabled = busy;
    const sign = menu.querySelector<HTMLButtonElement>('button[aria-label="Verify wallet"]');
    if (sign && !encrypted && !account) sign.hidden = true;
  }
  async function verify(family: Family) {
    if (busy || signal.aborted || !offered().includes(family) || client.session?.level === "signed") return;
    const id = thread();
    busy = true; choosing = false; sync(); status.textContent = "Opening your wallet…";
    try {
      await client.guest();
      const [session, request, loadWallet, , origin] = client.adopt();
      if (!session || session.level === "signed" || signal.aborted || thread() !== id) return;
      const stale = () => signal.aborted || client.session?.principalId !== session.principalId || thread() !== id;
      const wallet = await loadWallet(provider(family));
      if (stale()) return;
      const [verified, selectedWallet] = await wallet.signIn({
        workspace: host.options.workspace, origin, hosted: host.policy?.hosted,
        bearer: session.token, shareConversation: id ?? "next", call: request, read: wallet.read, stale,
      });
      if (stale()) return;
      if (id) {
        await host.refresh(true);
        if (!stale()) status.textContent = "Wallet verified.";
      } else {
        const proof = { receipt: verified.walletReceipt, expires: verified.walletReceiptExpiresAt, address: selectedWallet.address };
        if (!validProof(proof)) throw new Error("Could not save the wallet proof. Try again.");
        sync();
        save([...proofs.filter(existing => existing.address !== proof.address), proof]);
        status.textContent = "";
      }
    } catch (error) { if (!signal.aborted) status.textContent = host.errorText(error); }
    finally { busy = false; if (!signal.aborted) sync(); }
  }
  async function attach(id: string, principal: string, first: boolean) {
    if (signal.aborted || client.session?.principalId !== principal) return;
    if (first) save(proofs.map(proof => proof.conversation ? proof : {...proof, conversation: id}));
    const pending = proofs.filter(proof => proof.conversation === id);
    if (!pending.length) return;
    busy = true; sync();
    try {
      for (const proof of pending) {
        if (signal.aborted || client.session?.principalId !== principal) return;
        await client.adopt()[1]("/auth/share-wallet", { conversation: id, receipt: proof.receipt });
        if (signal.aborted || client.session?.principalId !== principal) return;
        save(proofs.filter(item => item.receipt !== proof.receipt));
      }
    } catch (error) { if (!signal.aborted) status.textContent = host.errorText(error); }
    finally {
      try { if (!signal.aborted && thread() === id) await host.refresh(true); }
      catch (error) { if (!signal.aborted) status.textContent = host.errorText(error); }
      busy = false; if (!signal.aborted) sync();
    }
  }
  async function unlink(address: string) {
    if (busy || !host.policy?.walletIdentification || !removing || removing !== address) return;
    const id = thread();
    const principal = client.session?.principalId;
    busy = true; sync();
    try {
      if (id && principal && attached().includes(address))
        await client.adopt()[1]("/auth/unlink-wallet", { conversation: id, address });
      if (signal.aborted || thread() !== id || client.session?.principalId !== principal) return;
      save(proofs.filter(proof => proof.address !== address || proof.conversation !== id));
      removing = undefined;
      if (id) await host.refresh(true);
      if (!signal.aborted) status.textContent = "Wallet removed from this chat.";
    } catch (error) { if (!signal.aborted) status.textContent = host.errorText(error); }
    finally { busy = false; if (!signal.aborted) { sync(); focusRow(address); } }
  }
  const firstMessage = (id: string, principal: string) => { if (proofs.length) void attach(id, principal, true); };
  (host.firstMessageListeners ??= new Set()).add(firstMessage);
  signal.addEventListener("abort", () => host.firstMessageListeners?.delete(firstMessage), { once: true });
  sync();
  return sync;
}
