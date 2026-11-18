/** Conversation chrome only. Authentication and action handlers stay with the client. */
import {domIcon} from "./icons";
import styles from "./page.module.css";
/** Presentation data from the caller. Role titles stay fixed; details describe this configuration. */
export type ConversationParticipant = {name: "You" | "Templ AI" | "Founder"; detail: string; initial: string};
/** `note` says who can read messages; it describes key custody, not the avatars shown. */
export type ConversationPresentation = {title: string; participants: ConversationParticipant[]; note?: string};
export function conversationTools(close: HTMLButtonElement, draft: () => HTMLElement | null, signal: AbortSignal, presentation: ConversationPresentation) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {const node = document.createElement(tag); if (text) node.textContent = text; return node;};
  const root = el("div"), people = el("details"), title = el("summary"), roster = el("div");
  root.className = styles.chatTools!; people.className = styles.participants!; roster.className = styles.participantMenu!;
  const name = el("strong", presentation.title), protection = el("small", "Encrypted"); name.append(protection);
  title.append(name, el("span", presentation.participants.map(person => person.name).join(", "))); title.setAttribute("aria-label", "Conversation participants");
  roster.setAttribute("aria-label", "Participants"); roster.append(el("strong", "Participants"));
  for (const {name, detail, initial} of presentation.participants) {
    const row = el("div"), avatar = el("span", initial), identity = el("span");
    avatar.className = styles.participantAvatar!; identity.append(el("b", name), el("small", detail)); row.append(avatar, identity); roster.append(row);
  }
  if (presentation.note) {const note = el("p", presentation.note); note.className = styles.participantNote!; roster.append(note);}
  const options = el("details"), more = el("summary"), menu = el("div"), actions = el("div");
  options.className = styles.conversationOptions!; more.append(domIcon("more")); more.setAttribute("aria-label", "Chat options");
  menu.className = styles.participantMenu!; actions.className = styles.participantActions!;
  menu.append(actions);
  const privacy = el("a", "Privacy"); privacy.href = "https://usetempl.com/privacy"; privacy.target = "_blank"; privacy.rel = "noopener noreferrer"; menu.append(privacy);
  for (const [details, body] of [[people, roster], [options, menu]] as const) {
    const back = el("button", "Back to chat"); back.type = "button";
    const dismiss = () => {details.open = false; draft()?.focus();};
    back.addEventListener("click", dismiss);
    details.addEventListener("keydown", event => {if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); dismiss();}});
    details.addEventListener("toggle", () => {if (details.open) (details === people ? options : people).open = false;});
    body.append(back);
  }
  actions.addEventListener("click", event => {if ((event.target as HTMLElement).closest("button")) options.open = false;});
  document.addEventListener("pointerdown", event => {if (!root.contains(event.target as Node)) {people.open = options.open = false;}}, {signal});
  people.append(title, roster); options.append(more, menu); root.append(people, options, close);
  return {root, actions};
}
