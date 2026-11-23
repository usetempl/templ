import type { memberConversations } from "./support-widget-conversations";
import type { TailHost } from "./support-widget";
type Controls = {
  disclosure: HTMLDetailsElement;
  people: HTMLDetailsElement;
  feedback: HTMLElement;
  note: HTMLElement;
  title?: HTMLElement;
  subtitle?: HTMLElement;
  roster: HTMLElement;
  avatars: HTMLElement;
  shareDetails?: HTMLButtonElement;
  identity?: string;
  placeholder: string;
  action?: string;
  conversations?: ReturnType<typeof memberConversations>;
  history?: HTMLDetailsElement;
};
const controls = new WeakMap<TailHost, Controls>();
const calendarDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
});
/** Presentation only. Existing authenticated handlers stay on their buttons. */
export function chatFirstControls(
  host: TailHost,
  tools: HTMLElement,
  peopleView: typeof import("./support-widget-people"),
  _handedOff: boolean,
  busy: boolean,
  style = "",
  listModule?: typeof import("./support-widget-conversations"),
) {
  const enabled =
    host.options.chatFirst === true && (host.policy?.chatFirst === true || host.policy?.singleConversation === true);
  let state = controls.get(host);

  if (!enabled) {
    if (state?.disclosure.isConnected) {
      const panel = state.disclosure.closest(".panel");
      panel?.classList.remove("conversation-chat", "conversation-drawers");
      for (const node of panel?.querySelectorAll(".chat-empty,.chat-day,.delivery-status") ?? [])
        node.remove();
      if (state.title) {
        state.people.before(state.title);
        if (state.subtitle) state.title.append(state.subtitle);
      }
      state.disclosure.before(tools);
      state.history?.remove();
      if (state.shareDetails) {
        state.shareDetails.textContent = "+";
        state.shareDetails.setAttribute("aria-label", "Add details");
        host.draft.before(state.shareDetails);
      }
      state.disclosure.remove();
      state.people.remove();
      state.feedback.remove();
      host.draft.placeholder = state.placeholder;
    }
    return false;
  }
  if (!state) {
    host.style.textContent += style;
    const disclosure = host.el("details", undefined, "chat-options"),
      more = host.el("summary", "Menu");
    more.setAttribute("aria-label", "Chat options");
    const menu = host.el("div", undefined, "chat-menu");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Conversation options");
    const people = host.el("details", undefined, "chat-people"),
      summary = host.el("summary");
    const panel = tools.closest(".panel");
    const drawer = host.showCase && listModule?.conversationDrawer(host);
    const history = drawer?.history;
    summary.setAttribute("aria-label", "Conversation participants");
    const roster = host.el("div", undefined, "chat-roster"),
      peopleMenu = host.el("div", undefined, "chat-people-menu");
    const avatars = host.el("span", undefined, "chat-avatars");
    avatars.setAttribute("aria-hidden", "true");
    peopleMenu.setAttribute("aria-label", "Participants");
    const note = host.el("p", undefined, "options-note"),
      feedback = host.el("p", undefined, "chat-feedback");
    feedback.setAttribute("role", "status");
    feedback.hidden = true;
    const close = () => {
      disclosure.open = people.open = false;
      if (history) history.open = false;
      host.draft.focus();
    };
    for (const details of [disclosure, people, ...(history ? [history] : [])]) {
      if (!host.options.conversationDrawers) {
        const back = host.el("button", "Back to chat", "return-chat");
        back.type = "button";
        back.addEventListener("click", close);
        (details === disclosure ? menu : peopleMenu).append(back);
      }
      details.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      });
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        if (details === people && host.policy?.supportProfiles) peopleView.refreshContacts(host);
        for (const other of [disclosure, people, history])
          if (other && other !== details) other.open = false;
      });
    }
    peopleMenu.prepend(roster);
    menu.prepend(note);
    disclosure.append(more, menu);
    people.append(summary, peopleMenu);
    const threadList = drawer && listModule?.bindMemberHistory(host, tools, drawer.history, drawer.trigger, true);
    state = {
      disclosure,
      people,
      feedback,
      note,
      roster,
      avatars,
      history: threadList ? history : undefined,
      shareDetails: host.draft.closest(".composer")?.querySelector<HTMLButtonElement>("button[aria-controls]") ?? undefined,
      placeholder: host.draft.placeholder,
      conversations: threadList,
    };
    controls.set(host, state);
    tools.addEventListener(
      "click",
      (event) => {
        if (host.options.chatFirst !== true || !(host.policy?.chatFirst || host.policy?.singleConversation))
          return;
        const button = (event.target as HTMLElement).closest("button");
        if (!button || button.disabled || button.hasAttribute("data-conversation-list")) return;
        state!.action = button === state!.shareDetails ? undefined
          : button === host.firstPerson
            ? "Requesting the team…"
            : button === host.emailButton
              ? "Opening email options…"
              : "Opening your wallet…";
        close();
      },
      true,
    );
    panel?.addEventListener("pointerdown", (event) => {
      if (
        !disclosure.contains(event.target as Node) &&
        !people.contains(event.target as Node) &&
        !history?.contains(event.target as Node)
      ) {
        disclosure.open = people.open = false;
        if (history) history.open = false;
      }
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
    summary.replaceChildren(state.avatars);
    if (!host.options.conversationDrawers)
      summary.append(title ?? host.el("strong", host.options.label ?? "Support"));
    tools.before(state.people, state.disclosure);
    state.disclosure.querySelector(".chat-menu")!.prepend(tools);
    if (state.history) state.people.before(state.history);
    else if (state.conversations)
      tools.after(state.conversations.list);
    if (state.shareDetails) tools.prepend(state.shareDetails);
    header.after(state.feedback);
    const panel = header.closest(".panel");
    panel?.classList.add("conversation-chat");
    if (host.options.conversationDrawers) panel?.classList.add("conversation-drawers");
    const intro = host.options.intro;
    const titleText = typeof intro?.title === "string" ? intro.title.trim().slice(0, 80) : "";
    const welcome = host.el("div", titleText ? undefined : "How can we help?", "chat-empty");
    if (titleText) {
      welcome.append(host.el("strong", titleText));
      if (typeof intro?.text === "string" && intro.text.trim())
        welcome.append(host.el("p", intro.text.trim().slice(0, 200)));
    }
    panel?.querySelector(".body")?.prepend(welcome);
  }
  const panel = state.disclosure.closest<HTMLElement>(".panel"),
    empty = panel?.querySelector<HTMLElement>(".chat-empty");
  if (empty) empty.hidden = !!panel?.querySelector(".message:not(.tail)");
  void state.conversations?.refresh();
  host.draft.placeholder = "Message";
  state.disclosure.hidden = host.draft.closest("form")?.hidden ?? false;
  const level = host.client.session?.level;
  const assistant = Boolean(panel?.querySelector(".message[data-assistant]"));
  const team = host.options.label ?? "Support";
  const contacts = peopleView.workspaceContacts(host);
  const identity = JSON.stringify([level, assistant, team, contacts]);
  if (state.identity !== identity) {
    state.identity = identity;
    const visitor = level === "signed" ? "Verified wallet"
      : level === "connected" ? "Connected wallet" : "Anonymous User";
    const people: [string, string, string, (string | null)?][] = [
      ["You", visitor, "Y"],
    ];
    if (contacts) people.push(...contacts);
    else {
      people.push(["Team", team, "T"]);
      if (assistant) people.push(["AI assistant", "Support assistant", "AI"]);
    }
    peopleView.renderPeople(host, state.roster, state.avatars, people);
  }
  for (const button of tools.querySelectorAll("button")) {
    if (button.hasAttribute("data-conversation-list")) continue;
    if (button === host.firstPerson) {
      button.hidden = !host.client.askPerson || host.policy?.askPerson === false;
      continue;
    }
    const text =
      button === state.shareDetails
        ? "Share details"
        : button === host.emailButton
          ? "Notify me when answered"
          : host.client.session?.level === "signed"
            ? "Sign out"
            : "Verify wallet";
    const label = document.createTextNode(text);
    if (host.options.conversationDrawers) {
      const icon = host.icon(button === state.shareDetails || button === host.emailButton ? "chat" : "wallet");
      button.replaceChildren(icon, label);
    } else button.replaceChildren(label);
    button.setAttribute("aria-label", text);
    button.removeAttribute("title");
  }
  state.note.textContent =
    level === "signed"
      ? "Wallet ownership verified."
      : level === "connected"
        ? "Wallet connected. Ownership not verified."
        : "";
  state.note.hidden = !state.note.textContent;
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
    previousSender: string | undefined,
    own = false,
    lastReplyAt = 0;
  for (const row of log?.querySelectorAll<HTMLElement>(".message:not(.tail)") ?? []) {
    const time = row.querySelector("time"),
      date = new Date(time?.dateTime ?? "");
    if (row.matches(".own[data-client-id]") && !row.querySelector(".delivery-status")) {
      const pending = row.querySelector(".state");
      if (pending && !pending.classList.contains("failed")) {
        row.dataset.sending = "true";
        const clock = host.el("span", undefined, "delivery-status delivery-clock");
        clock.setAttribute("aria-hidden", "true");
        if (time) time.append(clock);
        else pending.prepend(clock);
      } else if (time && !pending) {
        const tick = host.el("span", "✓", row.dataset.sending ? "delivery-status delivery-arrived" : "delivery-status");
        delete row.dataset.sending;
        tick.setAttribute("role", "img"); tick.setAttribute("aria-label", "Sent");
        time.append(tick);
      }
    }
    if (!Number.isFinite(date.getTime())) continue;
    const day = date.toDateString(),
      member = row.classList.contains("own");
    if (!member)
      lastReplyAt = Math.max(lastReplyAt, date.getTime());
    if (!member) row.dataset.avatar = row.querySelector("small")?.textContent?.trim().charAt(0) || "T";
    const sender = host.messageAuthors?.get(row);
    const adjacent = row.previousElementSibling?.matches(".message:not(.tail)") === true;
    row.dataset.grouped = String(adjacent && previous === day && own === member &&
      (sender ? sender === previousSender : member));
    previousSender = sender;
    own = member;
    if (previous !== day)
      row.before(
        host.el(
          "div",
          calendarDay.format(date),
          "chat-day",
        ),
      );
    previous = day;
  }
  const shown = host.thread?.();
  if (shown) state.conversations?.read(shown, lastReplyAt);
  if (nearEnd) body.scrollTop = body.scrollHeight;
  return true;
}
