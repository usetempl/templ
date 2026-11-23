import type { TailHost, createSupportClient } from "./support-widget";

type Notices = { enabled: boolean; pending?: boolean };

/** A guest's email and choice to subscribe belong to one conversation. */
export function drawerNotices(host: TailHost, menu: HTMLElement, signal: AbortSignal) {
  const { el } = host;
  const client = host.client as ReturnType<typeof createSupportClient>;
  const section = el("section", undefined, "drawer-section");
  const heading = el("h3", "Reply notifications");
  const icon = host.icon("chat");
  icon.querySelector("path")!.setAttribute("d", "M4 5h16v14H4zM4 5l8 7 8-7");
  heading.prepend(icon);
  const form = el("form", undefined, "drawer-section-body");
  const label = el("label", "Email address");
  const input = el("input");
  input.type = "email";
  input.autocomplete = "email";
  input.required = true;
  input.maxLength = 254;
  label.append(input);
  const hint = el("p", "Confirm your address by email to get replies to this chat. The team cannot see your email address.");
  const controls = el("div", undefined, "drawer-form-actions");
  const save = el("button", "Use this address", "drawer-primary");
  save.type = "submit";
  const cancel = el("button", "Cancel", "quiet");
  cancel.type = "button";
  const off = el("button", "Turn off notices", "drawer-stop");
  off.type = "button";
  const manage = el("button", "Manage reply notifications", "quiet");
  manage.type = "button";
  const status = el("p");
  status.setAttribute("role", "status");
  controls.append(save, cancel, off, manage);
  form.append(label, hint, controls, status);
  section.append(heading, form);
  menu.append(section);

  const currentThread = () => host.draftingConversation?.() ? undefined : host.thread?.() ?? client.session?.thread;
  const allowed = () => host.policy?.replyEmail === true;
  const path = (id: string) => "/conversations/" + id + "/guest-email";
  const request = () => client.adopt()[1];
  let pending: { principal: string; email: string } | undefined;
  let current: Notices | undefined;
  let lastRead: string | undefined;
  let scope: string | undefined;
  let busy = false;
  let epoch = 0;

  function render() {
    const signed = client.session?.level === "signed";
    const hasNotices = !!(current?.enabled || current?.pending);
    section.hidden = !allowed();
    label.hidden = hint.hidden = save.hidden = signed || hasNotices || !!pending;
    cancel.hidden = signed || hasNotices;
    off.hidden = signed || !hasNotices;
    manage.hidden = !signed;
    input.disabled = label.hidden || busy;
    save.disabled = off.disabled = cancel.disabled = busy;
    if (host.emailButton) host.emailButton.hidden = true;
  }
  function display(value: Notices) {
    current = value;
    status.textContent = value.enabled ? "Reply notifications are on."
      : value.pending ? "Check your email for the confirmation link." : "";
  }
  function sync(open: boolean) {
    const id = currentThread();
    const principal = client.session?.principalId;
    const next = principal + "/" + (id ?? "");
    if (scope !== next) {
      scope = next;
      epoch++;
      current = undefined;
      lastRead = undefined;
      busy = false;
      status.textContent = input.value = "";
      if (pending && (pending.principal !== principal || id)) pending = undefined;
    }
    if (!allowed()) pending = undefined;
    render();
    if (!open || !id || !principal || !allowed() || client.session?.level === "signed" || busy || lastRead === next) return;
    lastRead = next;
    const started = epoch;
    void request()<Notices>(path(id)).then(value => {
      if (started !== epoch || signal.aborted) return;
      display(value);
      render();
    }, () => {
      if (started === epoch) {
        lastRead = undefined;
        status.textContent = "Could not read reply notifications. Open Menu to try again.";
      }
    });
  }
  async function change(id: string, principal: string, email?: string) {
    if (!allowed() || client.session?.principalId !== principal || signal.aborted) return;
    const started = ++epoch;
    busy = true;
    render();
    status.textContent = email ? "Requesting your confirmation email…" : "Turning off notifications…";
    try {
      const value = await request()<Notices>(path(id), email
        ? { email, path: host.options.guestPath ?? location.pathname } : { enabled: false });
      if (started !== epoch || signal.aborted) return;
      input.value = "";
      display(value);
      if (!email && !value.enabled && !value.pending) status.textContent = "Reply notifications are off.";
    } catch (error) {
      if (started === epoch) {
        lastRead = undefined;
        status.textContent = host.errorText(error);
      }
    } finally {
      if (started === epoch) { busy = false; render(); }
    }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !allowed() || !form.reportValidity()) return;
    const email = input.value.trim();
    try {
      await client.guest();
      const session = client.session;
      if (!session || session.level === "signed" || signal.aborted || !allowed()) return;
      const id = currentThread();
      if (id) { await change(id, session.principalId, email); return; }
      pending = { principal: session.principalId, email };
      input.value = "";
      status.textContent = "We’ll send the confirmation email after your first message.";
      render();
    } catch (error) { status.textContent = host.errorText(error); }
  }, { signal });
  cancel.addEventListener("click", () => {
    pending = undefined;
    input.value = status.textContent = "";
    render();
    input.focus();
  }, { signal });
  off.addEventListener("click", () => {
    const id = currentThread();
    const principal = client.session?.principalId;
    if (id && principal && !busy) void change(id, principal);
  }, { signal });
  manage.addEventListener("click", () => {
    if (!allowed() || client.session?.level !== "signed") return;
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    void host.run(async () => {
      try {
        const { url } = await request()<{url: string}>("/conversations/alert-ticket", {});
        const target = new URL(url);
        const origins = [location.origin, new globalThis.URL(import.meta.url).origin, "https://usetempl.com"];
        if (target.protocol !== "https:" || !origins.includes(target.origin) ||
          target.pathname !== "/alerts" || target.username || target.password)
          throw new Error("Email settings could not open.");
        if (tab) tab.location.href = target.href;
        else window.open(target.href, "_blank", "noopener");
      } catch (error) { tab?.close(); throw error; }
    });
  }, { signal });
  const firstMessage = (id: string, principal: string) => {
    const queued = pending;
    pending = undefined;
    if (queued?.principal !== principal) return;
    sync(false);
    void change(id, principal, queued.email);
  };
  (host.firstMessageListeners ??= new Set()).add(firstMessage);
  signal.addEventListener("abort", () => { pending = undefined; host.firstMessageListeners?.delete(firstMessage); }, { once: true });
  sync(false);
  return sync;
}
