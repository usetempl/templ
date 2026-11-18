import type { TailHost } from "./support-widget";
type Controls = {
  disclosure: HTMLDetailsElement;
  people: HTMLDetailsElement;
  feedback: HTMLElement;
  note: HTMLElement;
  title?: HTMLElement;
  subtitle?: HTMLElement;
  placeholder: string;
  action?: string;
};
const controls = new WeakMap<TailHost, Controls>();
export const CONVERSATION_STYLE =
  ".chat-people{flex:1;min-width:0}.chat-people>summary{display:flex;flex-direction:column;justify-content:center;min-height:44px;cursor:pointer;list-style:none}.chat-people>summary::-webkit-details-marker,.chat-options>summary::-webkit-details-marker{display:none}.chat-people>summary>span{color:var(--m);font-size:12px;line-height:1.4}.chat-options>summary{display:grid;place-items:center;cursor:pointer;list-style:none;width:36px;height:44px;border-radius:50%;font-size:25px;color:var(--m)}.chat-options>summary:hover,.chat-options[open]>summary{background:var(--s2);color:var(--t)}.chat-menu,.chat-people-menu{position:absolute;right:8px;top:calc(100% - 2px);width:264px;max-width:calc(100% - 16px);max-height:calc(100dvh - 90px);overflow:auto;z-index:5;padding:8px;background:var(--bg);border:1px solid var(--b2);border-radius:12px;box-shadow:0 8px 24px var(--shc);display:grid;gap:4px}.chat-menu .tools{display:grid;gap:0}.chat-menu .tools button,.chat-menu>button,.chat-people-menu>button{display:block;width:100%;min-height:44px;margin:0;padding:10px 12px;text-align:left;border-radius:8px;font-size:14px;font-weight:400}.chat-menu button:hover:not(:disabled),.chat-people-menu button:hover{background:var(--s2)}.chat-menu .options-note{font-size:12px;color:var(--m);padding:8px 12px}.chat-menu .return-chat,.chat-people-menu .return-chat{border-top:1px solid var(--b);font-weight:500}.chat-feedback{padding:6px 12px;font-size:12px;color:var(--m);background:var(--s)}.chat-roster{display:grid;padding:4px 8px}.chat-roster div{display:flex;align-items:center;gap:12px;min-height:52px}.chat-roster i{font-style:normal;display:grid;place-items:center;flex:0 0 36px;height:36px;border-radius:50%;background:var(--s2);font-size:12px}.chat-roster b,.chat-roster small{display:block;font-size:14px;font-weight:500}.chat-roster small{font-size:12px;color:var(--m);font-weight:400}.chat-people-menu>.sub{padding:8px 12px;white-space:normal;font-size:12px}.conversation-chat .head{position:relative;background:var(--bg);gap:8px;padding:8px 12px}.conversation-chat .titles strong{font-size:15px;font-weight:600}.conversation-chat .avatar{width:36px;height:36px;border-radius:50%}.conversation-chat .avatar.logo{border-radius:0;background:transparent}.conversation-chat .body{background:var(--s);padding:10px 12px 16px}.conversation-chat .body>.safety,.conversation-chat .starter,.conversation-chat .suggestions,.conversation-chat .tail[data-state=hatch]{display:none}.conversation-chat .messages{gap:10px}.conversation-chat .message{padding:8px 11px 5px;border-radius:14px 14px 14px 4px;background:var(--bg);box-shadow:0 1px 1px var(--shc);font-size:14px;font-weight:400;line-height:1.45;letter-spacing:normal}.conversation-chat .message.own{border-radius:14px 14px 4px 14px;background:var(--s2);box-shadow:none}.conversation-chat .message.own[data-grouped=true]{margin-top:-7px;border-top-right-radius:5px}.conversation-chat .message time{font-size:10px;line-height:1.2;margin-top:3px}.conversation-chat .composer{background:var(--s);border:0;border-radius:24px}.conversation-chat .form{padding:6px 10px 10px}.conversation-chat .send{border-radius:50%}.conversation-chat .chat-empty{text-align:center;color:var(--m);font-size:12px;padding:40px 0 20px}.chat-day{align-self:center;margin:6px auto 14px;padding:3px 10px;border-radius:20px;background:var(--b);color:var(--t);font-size:11px;font-weight:500}";

/** Presentation only. Existing authenticated handlers stay on their buttons. */
export function chatFirstControls(
  host: TailHost,
  tools: HTMLElement,
  handedOff: boolean,
  busy: boolean,
) {
  const enabled =
    host.options.chatFirst === true && host.policy?.chatFirst === true;
  let state = controls.get(host);
  if (!enabled) {
    if (state?.disclosure.isConnected) {
      const panel = state.disclosure.closest(".panel");
      panel?.classList.remove("conversation-chat");
      for (const node of panel?.querySelectorAll(".chat-empty,.chat-day") ?? [])
        node.remove();
      if (state.title) {
        state.people.before(state.title);
        if (state.subtitle) state.title.append(state.subtitle);
      }
      state.disclosure.before(tools);
      state.disclosure.remove();
      state.people.remove();
      state.feedback.remove();
      host.draft.placeholder = state.placeholder;
    }
    return false;
  }
  if (!state) {
    host.style.textContent += CONVERSATION_STYLE;
    const disclosure = host.el("details", undefined, "chat-options"),
      more = host.el("summary", "⋮");
    more.setAttribute("aria-label", "Chat options");
    const menu = host.el("div", undefined, "chat-menu");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Conversation options");
    const people = host.el("details", undefined, "chat-people"),
      summary = host.el("summary");
    summary.setAttribute("aria-label", "Conversation participants");
    const roster = host.el("div", undefined, "chat-roster"),
      peopleMenu = host.el("div", undefined, "chat-people-menu");
    peopleMenu.setAttribute("aria-label", "Participants");
    for (const [name, role, initial] of [
      ["You", "Your messages", "Y"],
      ["AI", "AI assistant", "AI"],
      ["Founder", "Human support", "F"],
    ]) {
      const row = host.el("div"),
        label = host.el("span");
      label.append(host.el("b", name), host.el("small", role));
      row.append(host.el("i", initial), label);
      roster.append(row);
    }
    const note = host.el("p", undefined, "options-note"),
      feedback = host.el("p", undefined, "chat-feedback");
    feedback.setAttribute("role", "status");
    feedback.hidden = true;
    const close = () => {
      disclosure.open = people.open = false;
      host.draft.focus();
    };
    for (const [details, body] of [
      [disclosure, menu],
      [people, peopleMenu],
    ] as const) {
      const back = host.el("button", "Back to chat", "return-chat");
      back.type = "button";
      back.addEventListener("click", close);
      body.append(back);
      details.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      });
      details.addEventListener("toggle", () => {
        if (details.open)
          (details === people ? disclosure : people).open = false;
      });
    }
    peopleMenu.prepend(roster);
    menu.prepend(note);
    disclosure.append(more, menu);
    people.append(summary, peopleMenu);
    state = {
      disclosure,
      people,
      feedback,
      note,
      placeholder: host.draft.placeholder,
    };
    controls.set(host, state);
    tools.addEventListener(
      "click",
      (event) => {
        if (host.options.chatFirst !== true || host.policy?.chatFirst !== true)
          return;
        const button = (event.target as HTMLElement).closest("button");
        if (!button || button.disabled) return;
        state!.action =
          button === host.firstPerson
            ? "Requesting the team…"
            : button === host.emailButton
              ? "Opening email options…"
              : "Opening your wallet…";
        close();
      },
      true,
    );
    const panel = tools.closest(".panel");
    panel?.addEventListener("pointerdown", (event) => {
      if (
        !disclosure.contains(event.target as Node) &&
        !people.contains(event.target as Node)
      )
        disclosure.open = people.open = false;
    });
  }
  if (!state.disclosure.isConnected) {
    const header = tools.parentElement!,
      title = header.querySelector<HTMLElement>(".titles"),
      summary = state.people.querySelector("summary")!;
    state.title = title ?? undefined;
    state.subtitle = title?.querySelector<HTMLElement>(".sub") ?? undefined;
    if (state.subtitle)
      state.people.querySelector(".chat-people-menu")!.append(state.subtitle);
    summary.replaceChildren(
      title ?? host.el("strong", host.options.label ?? "Support"),
      host.el("span", "You, AI, Founder"),
    );
    tools.before(state.people, state.disclosure);
    state.disclosure.querySelector(".chat-menu")!.prepend(tools);
    header.after(state.feedback);
    const panel = header.closest(".panel");
    panel?.classList.add("conversation-chat");
    panel
      ?.querySelector(".body")
      ?.prepend(host.el("div", "Start a conversation", "chat-empty"));
  }
  const panel = state.disclosure.closest(".panel"),
    empty = panel?.querySelector<HTMLElement>(".chat-empty");
  if (empty) empty.hidden = !!panel?.querySelector(".message:not(.tail)");
  host.draft.placeholder = "Message";
  state.disclosure.hidden = host.draft.closest("form")?.hidden ?? false;
  for (const button of tools.querySelectorAll("button")) {
    const text =
      button === host.firstPerson
        ? handedOff
          ? "Team requested"
          : "Ask the team"
        : button === host.emailButton
          ? "Email replies"
          : host.client.session?.level === "signed"
            ? "Sign out"
            : "Verify wallet";
    button.replaceChildren(document.createTextNode(text));
    button.setAttribute("aria-label", text);
    button.removeAttribute("title");
  }
  const level = host.client.session?.level;
  state.note.textContent =
    level === "signed"
      ? "Wallet ownership verified."
      : level === "connected"
        ? "Wallet connected. Ownership not verified."
        : "You can chat without verifying a wallet.";
  if (!busy) {
    const error = panel?.querySelector<HTMLElement>(".error");
    if (
      state.action === "Opening your wallet…" &&
      error?.textContent === "Support is unavailable. Try again."
    )
      error.textContent =
        level === "signed"
          ? "Couldn’t sign out. Try again."
          : "Couldn’t verify your wallet. Try again.";
    state.action = undefined;
  }
  state.feedback.textContent = state.action ?? "";
  state.feedback.hidden = !busy || !state.action;
  const log = panel?.querySelector(".messages"),
    body = panel?.querySelector<HTMLElement>(".body");
  const nearEnd =
    body && body.scrollHeight - body.scrollTop - body.clientHeight < 72;
  for (const node of log?.querySelectorAll(".chat-day") ?? []) node.remove();
  let previous = "",
    own = false;
  for (const row of log?.querySelectorAll<HTMLElement>(".message") ?? []) {
    const time = row.querySelector("time"),
      date = new Date(time?.dateTime ?? "");
    if (!Number.isFinite(date.getTime())) continue;
    const day = date.toDateString(),
      member = row.classList.contains("own");
    row.dataset.grouped = String(own && member && previous === day);
    own = member;
    if (previous !== day)
      row.before(
        host.el(
          "div",
          day === new Date().toDateString()
            ? "Today"
            : date.toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              }),
          "chat-day",
        ),
      );
    previous = day;
  }
  if (nearEnd) body.scrollTop = body.scrollHeight;
  return true;
}
