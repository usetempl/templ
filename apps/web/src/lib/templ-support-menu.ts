import type { TailHost, createSupportClient } from "./support-widget";

type Notices = { pending: boolean; enabled: boolean };

export function addOwnChatMenu(host: TailHost, actions: HTMLElement) {
  const { el } = host;
  const panel = actions.closest<HTMLElement>(".panel")!;
  const drawer = actions.closest<HTMLElement>(".chat-menu")!;
  const client = host.client as ReturnType<typeof createSupportClient>;
  panel.classList.add("templ-home-chat");
  host.style.textContent += `
.panel.conversation-drawers.templ-home-chat .chat-menu{inset-block-start:var(--templ-menu-top,56px);padding-block-start:8px}
.templ-home-chat .chat-menu [hidden]{display:none}
.templ-home-chat .notice-form{display:grid;gap:8px;padding:8px 12px;min-width:0}
.templ-home-chat .notice-form label{display:grid;gap:4px}
.templ-home-chat .notice-form input{min-width:0;width:100%;padding:8px;background:var(--s);color:var(--t);border:1px solid var(--b);border-radius:var(--rc);font:inherit;font-size:16px}
.templ-home-chat .notice-form p{margin:0;font-size:13px;line-height:1.4}
.templ-home-chat .notice-form button,.templ-home-chat .notice-open{min-height:44px}
.templ-home-chat .notice-open{display:flex;align-items:center;gap:10px;padding:8px 12px;text-align:start}
.templ-home-chat .notice-open svg{width:18px;height:18px}
`;
  const button = el("button", "Notify me when answered", "quiet notice-open");
  button.prepend(host.icon("chat"));
  button.type = "button";
  const form = el("form", undefined, "notice-form");
  const label = el("label", "Email address");
  const input = el("input");
  input.type = "email";
  input.required = true;
  input.autocomplete = "email";
  input.maxLength = 254;
  label.append(input);
  const submit = el("button", "Send confirmation link", "quiet");
  submit.type = "submit";
  const stop = el("button", "Turn off notices", "quiet");
  stop.type = "button";
  const cancel = el("button", "Close email options", "quiet");
  cancel.type = "button";
  const explanation = el("p", "Confirm your address by email to get replies to this chat. The team cannot see your notice address.");
  const status = el("p");
  status.setAttribute("role", "status");
  form.append(label, explanation, submit, stop, status, cancel);
  form.hidden = stop.hidden = true;
  drawer.append(button, form);
  let working = false;
  let revision = 0;
  const signed = () => client.session?.level === "signed";
  const draftingAnother = () => !!panel.querySelector(".return-case p");
  const thread = () => host.thread?.() ?? client.session?.thread;
  function show(value?: Notices) {
    label.hidden = submit.hidden = explanation.hidden = !!(value?.enabled || value?.pending);
    stop.hidden = !value?.enabled && !value?.pending;
    status.textContent = value?.enabled ? "Reply notices are on for this chat."
      : value?.pending ? "Check your email. Confirm the link to turn on reply notices." : "";
  }
  function close() {
    revision++;
    form.hidden = true;
    input.value = "";
  }
  const request = () => client.adopt()[1];
  const emailPath = (id: string) => "/conversations/" + id + "/guest-email";
  const permitted = () => host.policy?.templLeadCapture === true && host.policy.replyEmail === true;
  cancel.addEventListener("click", () => { close(); button.focus(); });
  drawer.closest("details")?.addEventListener("toggle", event => {
    if (!(event.currentTarget as HTMLDetailsElement).open) close();
  });
  button.addEventListener("click", () => {
    if (!permitted() || working) return;
    if (!form.hidden) { close(); return; }
    const epoch = ++revision;
    const id = thread();
    if (draftingAnother()) {
      form.hidden = false;
      label.hidden = explanation.hidden = submit.hidden = stop.hidden = true;
      status.textContent = "Send the first message in this new conversation to choose its reply notices.";
      return;
    }
    if (signed()) {
      const tab = window.open("", "_blank");
      if (tab) tab.opener = null;
      void host.run(async () => {
        try {
          if (!id) await client.ask("");
          const {url} = await request()<{url: string}>("/conversations/alert-ticket", {});
          const target = new URL(url);
          if (target.origin !== location.origin || target.pathname !== "/alerts") throw new Error("Email settings could not open.");
          if (tab) tab.location.href = url;
          else window.open(url, "_blank", "noopener");
        } catch (error) { tab?.close(); throw error; }
      });
      return;
    }
    form.hidden = false;
    show();
    input.focus();
    if (id && client.session) {
      const principal = client.session.principalId;
      void request()<Notices>(emailPath(id)).then(value => {
        if (epoch === revision && thread() === id && client.session?.principalId === principal) show(value);
      }, () => {
        if (epoch === revision) status.textContent = "Could not read email settings. Open email options to try again.";
      });
    }
  });
  async function save(enabled: boolean) {
    if (working || !permitted() || signed() || draftingAnother()) return;
    const epoch = ++revision;
    const email = input.value.trim();
    working = submit.disabled = stop.disabled = true;
    status.textContent = enabled ? "Requesting confirmation…" : "Turning notices off…";
    try {
      const selected = thread();
      await client.guest();
      const principal = client.session?.principalId;
      if (epoch !== revision || !principal || signed()) return;
      const id = selected ?? (enabled ? (await client.ask("")).conversation.id : undefined);
      if (!id || epoch !== revision || client.session?.principalId !== principal || (thread() && thread() !== id)) return;
      const value = await request()<Notices>(emailPath(id), enabled ? { email, path: "/" } : { enabled: false });
      if (epoch !== revision || client.session?.principalId !== principal) return;
      input.value = "";
      show(value);
      if (!enabled) status.textContent = "Reply notices are off.";
      await host.refresh(true);
    } catch (error) {
      if (epoch === revision) status.textContent = host.errorText(error);
    } finally {
      working = submit.disabled = stop.disabled = false;
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (form.reportValidity()) void save(true);
  });
  stop.addEventListener("click", () => { void save(false); });
  return () => {
    if (host.emailButton) host.emailButton.hidden = true;
    button.disabled = !permitted();
    const height = panel.querySelector<HTMLElement>(".head")?.offsetHeight;
    if (height) panel.style.setProperty("--templ-menu-top", height + "px");
  };
}
