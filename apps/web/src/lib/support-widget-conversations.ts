import type { TeamConversation, TeamConversationList } from "@templ/chat/index";
import type { TailHost } from "./support-widget";

export const memberConversationsPath = (cursor?: string) =>
  "/conversations?view=member&filter=all" +
  (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

export function conversationDrawer(host: TailHost, start: () => void) {
  const history = host.el("details", undefined, "chat-history");
  history.hidden = true;
  const trigger = host.el("summary");
  trigger.setAttribute("aria-label", "Conversations");
  trigger.append(host.icon("chat"));
  history.append(trigger);
  const button = host.el("button", "New conversation");
  button.type = "button";
  button.dataset.conversationList = "";
  button.prepend(host.icon("chat"));
  button.addEventListener("click", start);
  return { history, trigger, button };
}

/** Both renderers mark only messages that their own verified history showed. */
export function memberConversations(input: {
  workspace: string;
  menu: HTMLDetailsElement;
  trigger: HTMLElement;
  actions: HTMLElement;
  drawer?: { drafting(): boolean };
  principal(): string | undefined;
  selected(): string | undefined | null;
  active(): boolean;
  load(cursor?: string): Promise<TeamConversationList>;
  open(row: TeamConversation): Promise<boolean>;
  focusChat(): void;
}) {
  const { menu, trigger, actions, drawer } = input;
  const button = (label: string) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    return element;
  };
  const entry = button("Conversations");
  entry.dataset.conversationList = "";
  const list = document.createElement("section");
  const title = document.createElement("strong");
  title.textContent = "Conversations";
  const rows = document.createElement("div");
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  const back = button("Back to menu");
  const more = button("More conversations");
  list.className = "member-conversations";
  list.setAttribute("aria-label", "Your conversations");
  more.hidden = true;
  list.append(title, rows, feedback, more);
  if (drawer) menu.append(list);
  else {
    list.hidden = true;
    list.append(back);
    actions.prepend(entry);
    actions.after(list);
  }
  const seen = new Map<string, number>();
  let conversations: TeamConversation[] = [];
  let cursor: string | null = null, updated = 0;
  let account: string | undefined, flight: Promise<void> | undefined;
  let selected: string | null | undefined;
  const key = (id: string) => `templ:chat-seen:v1:${input.workspace}:${id}`;
  const unseen = (row: TeamConversation) => {
    let time = seen.get(row.id);
    if (time === undefined) {
      try { time = Number(localStorage.getItem(key(row.id))) || 0; }
      catch { time = 0; }
      seen.set(row.id, time);
    }
    return Date.parse(row.lastReplyAt ?? "") > time;
  };
  const badge = (element: HTMLElement, label: string, unread: boolean) => {
    element.toggleAttribute("data-unread", unread);
    element.setAttribute("aria-label", unread ? `${label}, unread reply` : label);
  };
  function render() {
    const hasUnread = conversations.some(row => row.id !== input.selected() && unseen(row));
    badge(trigger, drawer ? "Conversations" : "Chat options", hasUnread);
    badge(entry, "Conversations", hasUnread);
    if (drawer) {
      menu.hidden = conversations.length < 2 && !(drawer.drafting() && conversations.length);
      if (menu.hidden) menu.open = false;
      if (!menu.open) return;
    }
    if (list.hidden) return;
    const focused = rows.querySelector(":focus")?.getAttribute("data-thread");
    rows.replaceChildren(...conversations.map(row => {
      const date = new Date(row.createdAt);
      const day = drawer ? date.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "medium"})
        : date.toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"});
      const label = `${day} · ${row.state === "resolved" ? "Closed" : "Open"}`;
      const item = button(label);
      item.dataset.thread = row.id;
      if (row.id === input.selected()) item.setAttribute("aria-current", "true");
      badge(item, label, unseen(row));
      item.addEventListener("click", () => {
        item.disabled = true;
        void input.open(row).then(opened => {
          if (opened && input.active()) {
            menu.open = false;
            input.focusChat();
          } else if (!opened && input.active()) feedback.textContent = "Send or clear your draft before you switch chats.";
        }).catch(() => {
          feedback.textContent = "Couldn’t open this chat. Try again.";
        }).finally(() => { item.disabled = false; });
      });
      return item;
    }));
    if (focused) [...rows.querySelectorAll("button")].find(item => item.dataset.thread === focused)?.focus();
    more.hidden = !cursor;
    feedback.textContent = conversations.length ? "" : "No conversations yet.";
  }
  const refresh = (next?: string, force = false) => {
    const principal = input.principal();
    if (account !== principal) {
      account = principal;
      conversations = []; seen.clear(); cursor = null; updated = 0; flight = undefined;
      render();
    }
    if (!principal || !input.active() || document.hidden) return Promise.resolve();
    if (flight) return flight;
    if (!force && Date.now() - updated < 10_000) return Promise.resolve();
    if (!next && !list.hidden && (!drawer || menu.open) && conversations.length > 50 && !force) return Promise.resolve();
    const active = () => input.active() && input.principal() === principal;
    const task = input.load(next).then(page => {
      if (!active()) return;
      conversations = next ? [...conversations, ...page.conversations.filter(row => !conversations.some(previous => previous.id === row.id))] : page.conversations;
      cursor = page.nextCursor;
      updated = Date.now();
      render();
    }).catch(() => {
      if (active() && !list.hidden) feedback.textContent = "Couldn’t load your chats. Open Conversations to try again.";
    }).finally(() => { if (flight === task) flight = undefined; });
    return flight = task;
  };
  const dismiss = () => {
    list.hidden = true;
    actions.hidden = false;
  };
  back.addEventListener("click", () => { dismiss(); entry.focus(); });
  menu.addEventListener("toggle", () => {
    if (drawer) {
      if (menu.open) {
        render();
        void refresh(undefined, true);
      }
    } else if (!menu.open) dismiss();
  });
  entry.addEventListener("click", () => {
    list.hidden = false;
    actions.hidden = true;
    menu.open = true;
    render();
    back.focus();
    void refresh(undefined, true);
  });
  more.addEventListener("click", () => { if (cursor) void refresh(cursor, true); });
  return {
    list,
    refresh: () => {
      const next = input.selected();
      const changed = selected !== next;
      selected = next;
      if (drawer && changed) render();
      return refresh(undefined, Boolean(drawer && changed));
    },
    read(id: string, receivedAt: number) {
      if (!input.active() || !Number.isFinite(receivedAt) || receivedAt <= 0) return;
      const time = Math.max(seen.get(id) ?? 0, receivedAt);
      if (seen.get(id) === time) return;
      seen.set(id, time);
      try { localStorage.setItem(key(id), String(Math.max(time, Number(localStorage.getItem(key(id))) || 0))); }
      catch { /* The open chat can still track replies for this visit. */ }
      render();
    },
  };
}
