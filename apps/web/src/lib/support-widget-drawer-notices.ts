import { drawerActionsStyle } from "./support-widget-drawer-actions-style";
import type { TailHost, createSupportClient } from "./support-widget";

type Notices = { enabled: boolean; pending?: boolean };

/** A guest's email and choice to subscribe belong to one conversation. */
export function drawerNotices(host: TailHost, menu: HTMLElement, signal: AbortSignal) {
  const { el } = host;
  host.style.append(document.createTextNode(`${drawerActionsStyle}
.shared-chat .drawer-section-body label{display:grid;gap:4px;font-size:13px}
.shared-chat .drawer-section-body input{box-sizing:border-box;width:100%;min-width:0;padding:8px;border:1px solid var(--b2);border-radius:8px;color:var(--t);background:var(--s);font:inherit;font-size:16px}
`));
  const client = host.client as ReturnType<typeof createSupportClient>;
  const section = el("section", undefined, "drawer-section drawer-notices");
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
  const controls = el("div", undefined, "drawer-actions");
  const save = el("button", "Use this email", "drawer-primary");
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
  form.append(label, controls, status);
  section.append(heading, form);
  menu.append(section);

  const currentThread = () => host.draftingConversation?.() ? undefined : host.thread?.() ?? client.session?.thread;
  const allowed = () => host.policy?.replyEmail === true;
  const path = (id: string) => "/conversations/" + id + "/guest-email";
  const request = () => client.adopt()[1];
  let pending: { principal: string; email: string } | undefined;
  let current: Notices | undefined;
  let reading: Promise<void> | undefined;
  let submitting: object | undefined;
  let account: string | undefined;
  let thread: string | undefined;
  let member = false;
  let busy = false;
  let readFailed = false;
  let epoch = 0;

  function render() {
    const signed = client.session?.level === "signed";
    const hasNotices = !!(current?.enabled || current?.pending);
    section.hidden = !allowed();
    label.hidden = save.hidden = signed || hasNotices || !!pending;
    cancel.hidden = signed || hasNotices;
    off.hidden = signed || !hasNotices;
    manage.hidden = !signed;
    input.disabled = label.hidden || busy;
    input.readOnly = !!submitting;
    save.disabled = busy || !!submitting;
    off.disabled = cancel.disabled = busy;
    if (host.emailButton) host.emailButton.hidden = true;
  }
  function display(value: Notices) {
    current = value;
    status.textContent = value.enabled ? "Reply notifications are on."
      : value.pending ? "Check your email for the confirmation link." : "";
  }
  function active(id: string, principal: string) {
    return !signal.aborted && allowed() && currentThread() === id &&
      client.session?.principalId === principal && client.session.level !== "signed";
  }
  function read(id: string, principal: string) {
    if (!current && !reading) {
      const started = epoch;
      reading = request()<Notices>(path(id)).then(value => {
        if (started === epoch && active(id, principal)) {
          display(value);
          render();
        }
      }, () => {
        if (started === epoch && active(id, principal)) {
          readFailed = true;
          status.textContent = "Could not check notifications. Try again.";
        }
      });
    }
    return reading;
  }
  function sync(open: boolean) {
    const id = currentThread();
    const principal = client.session?.principalId;
    const signed = client.session?.level === "signed";
    if (principal !== account || id !== thread || signed !== member) {
      const acquiredGuest = !account && !!principal && !signed && thread === id;
      account = principal;
      thread = id;
      member = signed;
      epoch++;
      current = undefined;
      reading = undefined;
      busy = readFailed = false;
      status.textContent = "";
      if (!acquiredGuest) {
        submitting = undefined;
        input.value = "";
      }
      if (pending && (pending.principal !== principal || id)) pending = undefined;
    }
    if (!open && readFailed) { reading = undefined; readFailed = false; }
    if (!allowed()) { pending = undefined; submitting = undefined; }
    render();
    if (open && id && principal && !signed && allowed() && !busy) void read(id, principal);
  }
  async function change(id: string, principal: string, email?: string) {
    if (!active(id, principal)) return;
    const started = ++epoch;
    busy = true;
    render();
    try {
      const value = await request()<Notices>(path(id), email
        ? { email, path: host.options.guestPath ?? location.pathname } : { enabled: false });
      if (started !== epoch || !active(id, principal)) return;
      input.value = "";
      display(value);
      if (!email && !value.enabled && !value.pending) status.textContent = "Reply notifications are off.";
    } catch (error) {
      if (started === epoch && active(id, principal)) {
        reading = undefined;
        current = undefined;
        status.textContent = host.errorText(error);
      }
    } finally {
      if (started === epoch) { busy = false; render(); }
    }
  }
  async function subscribe(email: string) {
    if (busy || submitting || !allowed()) return;
    sync(false);
    const intent = {};
    submitting = intent;
    const id = currentThread();
    const previousAccount = client.session?.principalId;
    render();
    try {
      await client.guest();
      const session = client.session;
      if (submitting !== intent || !session || session.level === "signed" || signal.aborted || !allowed() ||
          (previousAccount && previousAccount !== session.principalId) || currentThread() !== id) return;
      sync(false);
      if (id) {
        await read(id, session.principalId);
        if (submitting === intent && active(id, session.principalId) && current && !current.enabled && !current.pending)
          await change(id, session.principalId, email);
        return;
      }
      pending = { principal: session.principalId, email };
      input.value = "";
      status.textContent = "We’ll send the confirmation email after your first message.";
    } catch (error) {
      if (submitting === intent && !signal.aborted) status.textContent = host.errorText(error);
    } finally {
      if (submitting === intent) { submitting = undefined; render(); }
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (form.reportValidity()) void subscribe(input.value.trim());
  }, { signal });
  cancel.addEventListener("click", () => {
    submitting = undefined;
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
    if (active(id, principal)) void subscribe(queued.email);
  };
  (host.firstMessageListeners ??= new Set()).add(firstMessage);
  signal.addEventListener("abort", () => { pending = undefined; submitting = undefined; host.firstMessageListeners?.delete(firstMessage); }, { once: true });
  sync(false);
  return sync;
}
