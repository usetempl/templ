import type { TailHost, createSupportClient } from "./support-widget";

type Proof = { receipt: string; address: string; expires: number; conversation?: string };

/** Sharing an address keeps the visitor's guest session and grants no inbox access. */
export function drawerWallet(host: TailHost, menu: HTMLElement, signal: AbortSignal) {
  const { el } = host;
  const client = host.client as ReturnType<typeof createSupportClient>;
  const section = el("section", undefined, "drawer-section");
  const heading = el("h3", "Wallet verification");
  heading.prepend(host.icon("wallet"));
  const content = el("div", undefined, "drawer-section-body");
  const hint = el("p");
  const button = el("button", "Verify and share address", "quiet");
  button.type = "button";
  const status = el("p");
  status.setAttribute("role", "status");
  content.append(hint, button, status);
  section.append(heading, content);
  const email = menu.querySelector(".drawer-section");
  if (email) menu.insertBefore(section, email);
  else menu.append(section);
  const thread = () => host.draftingConversation?.() ? undefined : host.thread?.() ?? client.session?.thread;
  let scope: string | undefined;
  let proof: Proof | undefined;
  let busy = false;
  let selected: string | undefined;
  // These chats group account actions under Wallet verification. Keep the
  // existing sign-in, sign-out and minimum-level handlers in charge.
  const accountAction = () => {
    if (!host.options.decorateOwnMenu) return;
    const signed = client.session?.level === "signed";
    const required = host.policy?.chatMode === "encrypted" || host.policy?.minimumLevel === "signed" || host.policy?.minimumLevel === "connected";
    if (!signed && (thread() || !required)) return;
    return menu.querySelector<HTMLButtonElement>(signed ? '.tools button[aria-label="Sign out"]' : '.tools button[aria-label="Verify wallet"]');
  };
  function remember(value?: Proof) {
    proof = value;
    if (!scope) return;
    try {
      if (value) sessionStorage.setItem(scope, JSON.stringify(value));
      else sessionStorage.removeItem(scope);
    } catch { /* The current tab can finish sharing without storage. */ }
  }
  function sync() {
    const session = client.session;
    const next = session && `templ:chat-wallet:v1:${host.options.workspace}:${session.principalId}`;
    if (next !== scope) {
      if (scope) remember();
      scope = next;
      if (scope) {
        try {
          const stored = JSON.parse(sessionStorage.getItem(scope) ?? "null") as Proof | null;
          if (stored && typeof stored.address === "string" && /^[0-9a-f]{64}$/.test(stored.receipt) && stored.expires > Date.now()) proof = stored;
        } catch { /* A partial record can be replaced by a fresh proof. */ }
      }
      status.textContent = "";
    }
    if (proof && proof.expires <= Date.now()) {
      remember();
      status.textContent = "Your wallet proof expired. Verify again to share the address.";
    }
    const id = thread();
    if (selected !== id) { selected = id; status.textContent = ""; }
    const attached = host.verifiedWallet?.();
    const retry = !!proof?.conversation && proof.conversation === id;
    const encrypted = host.policy?.chatMode === "encrypted" && !id;
    const account = accountAction();
    if (account) {
      section.hidden = button.hidden = false;
      button.disabled = account.disabled;
      button.textContent = account.textContent;
      hint.textContent = session?.level === "signed" ? "You’re signed in with your wallet." : "This chat requires a wallet. Sign a message to verify it.";
      return;
    }
    section.hidden = session?.level === "signed" || encrypted;
    hint.textContent = attached ? "The support team can see your verified address in this chat."
      : proof && !proof.conversation && !id ? "Wallet verified. Your first message will share the address with this team."
      : client.hasWallet ? "Sign a message to share your verified address with the support team in this chat."
      : "Open this chat in a wallet browser or connect a wallet on the site to verify your address.";
    button.hidden = !!attached || (!!proof && !proof.conversation && !id);
    button.disabled = busy || (!retry && !client.hasWallet);
    button.textContent = retry ? "Retry sharing address" : "Verify and share address";
    const sign = menu.querySelector<HTMLButtonElement>('button[aria-label="Verify wallet"]');
    if (sign && !encrypted) sign.hidden = true;
  }
  async function attach(id: string, principal: string) {
    if (!proof || (proof.conversation && proof.conversation !== id) || client.session?.principalId !== principal) return;
    const pending = { ...proof, conversation: id };
    remember(pending);
    busy = true;
    sync();
    try {
      await client.adopt()[1]("/auth/share-wallet", { conversation: id, receipt: pending.receipt });
      if (signal.aborted || proof !== pending || client.session?.principalId !== principal) return;
      remember();
      if (thread() === id) {
        await host.refresh(true);
        status.textContent = "Your verified address is shared with this team.";
      }
    } catch (error) {
      if (!signal.aborted && proof === pending) status.textContent = host.errorText(error);
    } finally { busy = false; if (!signal.aborted) sync(); }
  }
  button.addEventListener("click", async () => {
    if (busy || signal.aborted) return;
    const account = accountAction();
    if (account) { account.click(); return; }
    const id = thread();
    if (proof?.conversation && proof.conversation === id && client.session) {
      await attach(id, client.session.principalId);
      return;
    }
    if (!client.hasWallet || client.session?.level === "signed") return;
    busy = true;
    sync();
    status.textContent = "Opening your wallet…";
    try {
      await client.guest();
      const [session, request, loadWallet, , origin] = client.adopt();
      if (!session || session.level === "signed" || signal.aborted || thread() !== id) return;
      const stale = () => signal.aborted || client.session?.principalId !== session.principalId || thread() !== id;
      const wallet = await loadWallet();
      if (stale()) return;
      const [verified, selectedWallet] = await wallet.signIn({
        workspace: host.options.workspace, origin, hosted: host.policy?.hosted,
        bearer: session.token, shareConversation: id ?? "next", call: request, read: wallet.read, stale,
      });
      if (stale()) return;
      if (id) {
        await host.refresh(true);
        if (!stale()) status.textContent = "Your verified address is shared with this team.";
      } else {
        if (!verified.walletReceipt || !/^[0-9a-f]{64}$/.test(verified.walletReceipt) ||
          !verified.walletReceiptExpiresAt || verified.walletReceiptExpiresAt <= Date.now())
          throw new Error("Could not save the wallet proof. Try again.");
        remember({ receipt: verified.walletReceipt, address: selectedWallet.address, expires: verified.walletReceiptExpiresAt });
        status.textContent = "";
      }
    } catch (error) { if (!signal.aborted) status.textContent = host.errorText(error); }
    finally { busy = false; if (!signal.aborted) sync(); }
  }, { signal });
  const firstMessage = (id: string, principal: string) => { if (proof && !proof.conversation) void attach(id, principal); };
  (host.firstMessageListeners ??= new Set()).add(firstMessage);
  signal.addEventListener("abort", () => host.firstMessageListeners?.delete(firstMessage), { once: true });
  sync();
  return sync;
}
