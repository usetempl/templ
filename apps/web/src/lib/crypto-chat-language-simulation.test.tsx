import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_LANGUAGES, CRYPTO_LANGUAGE_CODES, cryptoLanguage } from "@templ/chat/crypto-languages";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { afterEach, expect, vi } from "vitest";
import { CRYPTO_CHAT_STRINGS } from "./crypto-chat-strings";
import { checkedLanguageBundle, createCryptoChatLanguage, type CryptoChatLanguageStore } from "./crypto-chat-language";
import { cryptoLanguagePickers } from "./crypto-chat-language-picker";
import { localizeCryptoChat } from "./crypto-chat-localizer";
import type { TailHost } from "./support-widget";

// The self-hosted desk is unconfigured until the operator chooses a workspace.
vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000001",
}));

const API = "https://community.usetempl.com";
const BASE = `${API}/widget/${CRYPTO_SUPPORT_WORKSPACE}`;
const NEIGHBOR = `${API}/widget/01990000-0000-7000-8000-000000000002`;
const THREAD = `tc-${"0123456789abcdef".repeat(2)}`;
const SAVED = `templ:support-language:v1:${CRYPTO_SUPPORT_WORKSPACE}`;
const TOKENS = /\{[a-zA-Z]\w*\}/g;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

type Sent = { input: string; init?: RequestInit };
/** The offline bundles keep every token; a visible prefix stands in for a translation. */
const translation = (code: string, english: string) => `[${code}] ${english}`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true, ...init }));

function staticFiles(paths: string[]): typeof fetch {
  return async input => {
    const path = String(input);
    paths.push(path);
    const code = /^\/chat-languages\/([\w-]+)\.json$/.exec(path)?.[1];
    if (!code || code === "en" || !CRYPTO_LANGUAGE_CODES.has(code)) return json({}, 404);
    return json(Object.fromEntries(CRYPTO_CHAT_STRINGS.map(text => [text, translation(code, text)])));
  };
}
function service(flag: () => unknown, sent: Sent[]): typeof fetch {
  return async (input, init) => {
    sent.push({ input: String(input), init });
    if (String(input) !== `${BASE}/auth/policy`) return json({ conversation: { id: THREAD } });
    const value = flag();
    return json({ minimumLevel: "anyone", ...(value === undefined ? {} : { cryptoChatLanguage: value }) });
  };
}
async function enable(store: CryptoChatLanguageStore) {
  await store.transport(service(() => true, []))(`${BASE}/auth/policy`, { method: "GET", credentials: "omit", cache: "no-store" });
  await vi.waitFor(() => expect(store.state.enabled).toBe(true));
}
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "", attributes: Record<string, string> = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

simulate("the crypto desk adds only the visitor's explicit language to ordinary sends", async draw => {
  // A device language is never a choice.
  Object.defineProperty(navigator, "language", { value: draw.pick(["fr-FR", "ar-EG", "ja-JP"]), configurable: true });
  const files: string[] = [];
  const sent: Sent[] = [];
  let flag: unknown;
  const store = createCryptoChatLanguage(CRYPTO_SUPPORT_WORKSPACE, API, staticFiles(files));
  const transport = store.transport(service(() => flag, sent));
  const codes = [...CRYPTO_LANGUAGE_CODES];
  const texts = [
    ...draw.shuffle(CRYPTO_CHAT_STRINGS).slice(0, 3),
    draw.text(["a", "é", "日", "😀", '"', "\\", "{", "}", "<", "‮", " ", "\n"], draw.int(1, 40)),
    '{"preferredLanguage":"xx"}',
  ];
  for (let step = 0; step < 40; step++) {
    const roll = draw.int(0, 9);
    if (roll === 0) {
      flag = draw.pick([true, false, "true", 1, undefined]);
      const init: RequestInit = { method: "GET", credentials: "omit", cache: "no-store" };
      await transport(`${BASE}/auth/policy`, init);
      expect(sent.at(-1)!.init).toBe(init);
      await vi.waitFor(() => expect(store.state.enabled).toBe(flag === true));
      continue;
    }
    if (roll === 1) {
      const code = draw.pick([...draw.shuffle(codes).slice(0, 3), "en", "xx", "EN", "fr-FR", "__proto__"]);
      const before = store.state.chosen;
      await store.choose(code);
      expect(store.state.chosen).toBe(store.state.enabled && CRYPTO_LANGUAGE_CODES.has(code) ? cryptoLanguage(code) : before);
      continue;
    }
    const text = draw.pick(texts);
    const clientId = `w-${step}`;
    const [path, body, ordinary] = draw.pick<[string, object | undefined, boolean]>([
      ["/conversations/ask", { text, clientId }, true],
      ["/conversations/ask", { text, clientId, context: { app: { page: "/swap" } }, contextConsent: true }, true],
      ["/conversations/ask", { text, clientId, newCaseFrom: THREAD }, true],
      [`/conversations/${THREAD}/messages`, { text, clientId }, true],
      ["/conversations/ask", { handoff: { by: "member" } }, false],
      ["/conversations/ask", { encryptedRecord: text, validationReceipt: "receipt" }, false],
      ["/conversations/ask", { text, clientId, lead: { email: "visitor@example.com" } }, false],
      ["/conversations/ask", { text, clientId, installCheck: "check" }, false],
      [`/conversations/${THREAD}/messages`, undefined, false],
      [`/conversations/${THREAD}/workflow`, { action: "ask-person" }, false],
    ]);
    const origin = draw.pick([BASE, BASE, BASE, NEIGHBOR, `https://example.com/widget/${CRYPTO_SUPPORT_WORKSPACE}`]);
    const init: RequestInit = body
      ? { method: "POST", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method: "GET", credentials: "omit", cache: "no-store" };
    await transport(origin + path, init);
    const forwarded = sent.at(-1)!;
    expect(forwarded.input).toBe(origin + path);
    const code = store.state.enabled ? store.state.chosen?.code : undefined;
    if (ordinary && origin === BASE && code) {
      const original = init.body as string;
      // Only the leading field is new; the visitor's text keeps its exact bytes.
      expect(forwarded.init!.body).toBe(`{"preferredLanguage":${JSON.stringify(code)},${original.slice(1)}`);
      expect(JSON.parse(forwarded.init!.body as string)).toEqual({ preferredLanguage: code, ...body });
      expect({ ...forwarded.init, body: original }).toEqual(init);
    } else expect(forwarded.init).toBe(init);
  }
  const saved = localStorage.getItem(SAVED);
  expect(store.state.chosen ? saved === store.state.chosen.code : saved === null).toBe(true);
  for (const path of files) expect(path).toMatch(/^\/chat-languages\/[\w-]+\.json$/);
});

simulate("rapid language changes use the newest choice even if older requests finish later", async draw => {
  const resume: (() => void)[] = [];
  const files = staticFiles([]);
  const store = createCryptoChatLanguage(CRYPTO_SUPPORT_WORKSPACE, API, async (input, init) => {
    await new Promise<void>(resolve => resume.push(resolve));
    init?.signal?.throwIfAborted();
    return files(input, init);
  });
  await enable(store);
  const first = draw.pick(["fr", "ar", "ja"]);
  const selections = [store.choose(first), store.choose("de"), store.choose(first)];
  for (const resolve of draw.shuffle(resume)) resolve();
  await Promise.all(selections);
  expect(store.state.shown.code).toBe(first);
  expect(store.state.chosen?.code).toBe(first);
  expect(store.state.failed).toBeUndefined();
}, { runs: 3 });

simulate("an incomplete update keeps the last working language and can be retried", async draw => {
  const files = staticFiles([]);
  const code = draw.pick(["ar", "fr", "ja", "pt-BR"]);
  let truncated = false;
  const store = createCryptoChatLanguage(CRYPTO_SUPPORT_WORKSPACE, API, (input, init) =>
    truncated ? Promise.resolve(json({ Send: "Send" })) : files(input, init));
  await enable(store);
  await store.choose("de");
  truncated = true;
  await store.choose(code);
  expect(store.state.failed?.code).toBe(code);
  expect(store.state.shown.code).toBe("de");
  expect(store.state.chosen?.code).toBe("de");
  truncated = false;
  await store.choose(code);
  expect(store.state.shown.code).toBe(code);
  expect(store.state.failed).toBeUndefined();
}, { runs: 4 });

simulate("language bundles keep only exact plain-text entries with the same tokens", draw => {
  const valid: [string, string][] = [];
  const bundle: Record<string, unknown> = { "Not on the crypto desk": "Pas sur le guichet" };
  for (const source of draw.shuffle([...new Set(CRYPTO_CHAT_STRINGS)]).slice(0, 30)) {
    const tokens = source.match(TOKENS) ?? [];
    const kind = draw.int(0, 7);
    if (kind <= 2) {
      const text = `  ${draw.text("абвگ文é", draw.int(1, 6))} ${draw.shuffle(tokens).join(" ")} `;
      bundle[source] = text;
      valid.push([source, text.trim()]);
    } else if (kind === 3) bundle[source] = tokens.length ? draw.text("xyz", 5) : " ";
    else if (kind === 4) bundle[source] = `${source}‮`;
    else if (kind === 5) bundle[source] = `${source}\u0007`;
    else if (kind === 6) bundle[source] = draw.pick([42, null, ["text"], { text: source }]);
    else bundle[source] = `${source} {extra}`;
  }
  const parsed: unknown = JSON.parse(JSON.stringify(bundle).replace(/^\{/, '{"__proto__":"x",'));
  if (!valid.length) expect(() => checkedLanguageBundle(parsed)).toThrow();
  else expect([...checkedLanguageBundle(parsed)].sort()).toEqual(valid.sort());
  for (const invalid of [[], "text", null, 7]) expect(() => checkedLanguageBundle(invalid)).toThrow();
});

/** A hosted crypto chat as the widget draws it, with message content that reads like interface text. */
function hostedChat(draw: Rng) {
  const pick = () => draw.pick(CRYPTO_CHAT_STRINGS);
  const widget = make("div", "", "", { "data-templ-support": "" });
  document.body.append(widget);
  const root = widget.attachShadow({ mode: "open" });
  const panel = make("section", "panel conversation-chat shared-chat", "", { "aria-label": "Crypto Help Desk" });
  const head = make("div", "head");
  const title = make("strong", "", "Crypto Help Desk");
  const summary = make("summary", "", "", { "aria-label": "Menu", "aria-description": "People and conversation settings" });
  const menu = make("div", "chat-menu");
  const verify = make("button", "", "Verify wallet", { "aria-label": "Verify wallet" });
  const tools = make("div", "tools");
  tools.append(verify);
  const section = make("section", "drawer-section");
  const heading = make("h3", "", "Wallet verification");
  const share = make("button", "quiet drawer-primary", "Verify and share address");
  const address = make("bdi", "", ADDRESS);
  const remove = make("button", "wallet-remove", "", { "aria-label": `Remove wallet ${ADDRESS}` });
  section.append(heading, share, address, remove);
  menu.append(tools, section);
  const details = make("details", "chat-options");
  details.append(summary, menu);
  head.append(title, details);
  const body = make("div", "body");
  const intro = make("strong", "", "Ask about Bitcoin, Solana, Ethereum, layer 2s, DeFi or wallets.");
  const empty = make("div", "chat-empty");
  empty.append(intro);
  const messages = make("div", "messages", "", { role: "log" });
  const date = [draw.int(1, 28), draw.pick(MONTHS)] as const;
  const dayText = `${date[0]} ${date[1]}`;
  const day = make("div", "chat-day", dayText);
  const content = { visitor: pick(), assistant: pick(), team: pick(), followUp: pick(), shared: pick(), prompt: pick() };
  const you = make("small", "", "You");
  const sending = make("span", "state", "Sending…");
  const own = make("div", "message own");
  const instant = new Date(2026, MONTHS.indexOf(date[1]), date[0], 15, 45);
  const timestamp = make("time", "", "3:45 PM", { datetime: instant.toISOString() });
  own.append(you, content.visitor, timestamp, sending);
  const agent = make("small", "", "AI agent");
  const assistant = make("div", "message", "", { "data-assistant": "" });
  assistant.append(agent, content.assistant, make("time", "", "3:46 PM"));
  const flag = make("button", "flag", "", { "data-tip": "Report this answer", "aria-label": "Report this answer" });
  assistant.append(flag);
  const teamName = make("small", "", "Team");
  const team = make("div", "message");
  team.append(teamName, content.team);
  const customName = draw.pick(["Close", "You", "Wallet", "Sent"]);
  const namedAuthor = make("small", "", customName);
  const teamBadge = make("span", "tag", "Team");
  namedAuthor.append(" ", teamBadge);
  const namedReply = make("div", "message");
  namedReply.append(namedAuthor, content.team);
  const typingLabel = make("small", "", "AI assistant");
  const typing = make("div", "message typing tail", "", { "data-state": "typing agent" });
  typing.append(typingLabel);
  const received = make("div", "system tail", "Received.", { "data-state": "received" });
  const minutes = draw.int(2, 59);
  const waitText = `The team usually replies in about ${minutes} minutes.`;
  const wait = make("div", "system tail", waitText);
  const followUp = make("div", "system nudge tail", content.followUp);
  const sharedTitle = make("h3", "", "Details you shared (1)");
  const sharedLabel = make("b", "", "Wallet");
  const sharedValue = make("span", "", content.shared);
  const row = make("div", "row");
  row.append(sharedLabel, sharedValue);
  const sharedList = make("section", "shared-list");
  sharedList.append(sharedTitle, row);
  const shared = make("div", "system tail shared-tail");
  shared.append(sharedList);
  messages.append(day, own, assistant, team, namedReply, typing, received, wait, followUp, shared);
  const prompt = make("button", "", content.prompt);
  const suggestions = make("div", "suggestions");
  suggestions.append(prompt);
  body.append(empty, messages, suggestions);
  const error = make("p", "error", "", { role: "alert" });
  const draft = make("textarea", "", "", {
    "aria-label": "Message to the support team", "aria-description": "Enter sends. Shift+Enter adds a new line.", placeholder: "Message",
  });
  draft.value = draw.pick([pick(), draw.text("I lost 0.5 ETH 😀 ", draw.int(1, 30))]);
  const send = make("button", "send", "", { "aria-label": "Send" });
  const composer = make("div", "composer");
  composer.append(draft, send);
  const form = make("form", "form");
  form.append(composer);
  panel.append(head, body, error, form);
  root.append(make("style"), panel);
  const unit = (code: string) => new Intl.NumberFormat(code, { style: "unit", unit: "minute", unitDisplay: "long" }).format(minutes);
  const month = (code: string) => new Intl.DateTimeFormat(code, { day: "numeric", month: "long" }).format(instant);
  return {
    widget, root, panel, messages, section, error, draft, verify, flag,
    /** Interface text and its expected form in a language. */
    ui: [
      ...([[title, "Crypto Help Desk"], [verify, "Verify wallet"], [heading, "Wallet verification"],
        [share, "Verify and share address"], [intro, "Ask about Bitcoin, Solana, Ethereum, layer 2s, DeFi or wallets."],
        [you, "You"], [sending, "Sending…"], [agent, "AI agent"], [teamName, "Team"], [typingLabel, "AI assistant"],
        [received, "Received."], [sharedLabel, "Wallet"], [teamBadge, "Team"]] as const).map(([node, english]) =>
        [node, (code: string) => code === "en" ? english : translation(code, english)] as const),
      [wait, (code: string) => code === "en" ? waitText : `[${code}] The team usually replies in about ${unit(code)}.`] as const,
      [sharedTitle, (code: string) => code === "en" ? "Details you shared (1)"
        : `[${code}] Details you shared (${new Intl.NumberFormat(code).format(1)})`] as const,
      [timestamp, (code: string) => code === "en" ? "3:45 PM" : new Intl.DateTimeFormat(code, { hour: "numeric", minute: "2-digit" }).format(instant)] as const,
      [day, (code: string) => code === "en" ? dayText : month(code)] as const,
    ],
    /** Message content, addresses and typed input, each with the only text it may hold. */
    content: [
      [own.childNodes[1], content.visitor], [assistant.childNodes[1], content.assistant], [team.childNodes[1], content.team],
      [followUp.firstChild!, content.followUp], [sharedValue.firstChild!, content.shared], [prompt.firstChild!, content.prompt],
      [address.firstChild!, ADDRESS], [namedAuthor.firstChild!, customName], [assistant.querySelector("time")!.firstChild!, "3:46 PM"],
    ] as const,
    /** Names the widget, its styles and the hosted page look up in English. */
    named: [[panel, "Crypto Help Desk"], [summary, "Menu"], [verify, "Verify wallet"], [remove, `Remove wallet ${ADDRESS}`],
      [draft, "Message to the support team"], [send, "Send"]] as const,
    described: [[summary, "People and conversation settings"], [draft, "Enter sends. Shift+Enter adds a new line."]] as const,
  };
}

simulate("switching language rewrites only the hosted chat's own interface text", async draw => {
  const files: string[] = [];
  const store = createCryptoChatLanguage(CRYPTO_SUPPORT_WORKSPACE, API, staticFiles(files));
  const chat = hostedChat(draw);
  const original = chat.panel.outerHTML;
  const dispose = localizeCryptoChat(chat.root, store);
  await enable(store);
  const draft = chat.draft.value;
  chat.draft.focus();
  const [start, end] = [draw.int(0, draft.length), draft.length];
  chat.draft.setSelectionRange(start, end);
  const copy = make("button", "quiet");
  chat.section.append(copy);
  copy.textContent = chat.verify.textContent;
  const order = [...draw.shuffle(["fr", "ar", "es", "ja", "fa"]), ...Array.from({ length: draw.int(0, 3) }, () => draw.pick(["fr", "ar", "en"])), "en"];
  for (const code of order) {
    await store.choose(code);
    await settle();
    const shown = (english: string) => code === "en" ? english : translation(code, english);
    if (draw.chance(0.6)) {
      // The widget reads its alert back in English, for example to clear an outage line.
      chat.error.textContent = "Support is unavailable. Try again.";
      await settle();
      expect(chat.error.firstChild?.textContent).toBe(shown("Support is unavailable. Try again."));
      expect(chat.error.textContent).toBe("Support is unavailable. Try again.");
      if (chat.error.textContent === "Support is unavailable. Try again.") chat.error.textContent = "";
      expect(chat.error.childNodes.length).toBe(0);
    }
    const line = make("div", "system tail", "Your message is saved. The team can reply here.", { "data-state": "wait" });
    chat.messages.append(line);
    if (draw.chance(0.5)) copy.textContent = chat.verify.textContent;
    await settle();
    expect(line.textContent).toBe(shown("Your message is saved. The team can reply here."));
    expect(copy.textContent).toBe(shown("Verify wallet"));
    line.remove();
    for (const [node, expected] of chat.ui) expect(node.textContent, code).toBe(expected(code));
    for (const [node, text] of chat.content) expect(node.textContent).toBe(text);
    expect(chat.flag.getAttribute("data-tip")).toBe(shown("Report this answer"));
    expect(chat.draft.value).toBe(draft);
    expect([chat.draft.selectionStart, chat.draft.selectionEnd]).toEqual([start, end]);
    expect(chat.root.activeElement).toBe(chat.draft);
    expect(chat.draft.getAttribute("placeholder")).toBe(shown("Message"));
    for (const [node, english] of chat.named) {
      expect(node.getAttribute("aria-label")).toBe(english);
      const label = node.getAttribute("aria-labelledby");
      if (code === "en") expect(label).toBeNull();
      else expect(chat.root.querySelector(`#${label}`)?.textContent).toBe(shown(english));
    }
    for (const [node, english] of chat.described) {
      const description = node.getAttribute("aria-describedby");
      if (code === "en") expect(description).toBeNull();
      else expect(chat.root.querySelector(`#${description}`)?.textContent).toBe(shown(english));
    }
    expect(chat.root.querySelector('button[aria-label="Verify wallet"]')).toBe(chat.verify);
    expect(chat.root.querySelector('textarea[aria-label="Message to the support team"]')).toBe(chat.draft);
    expect(chat.widget.getAttribute("dir")).toBe(code === "en" ? null : cryptoLanguage(code)!.dir);
    expect(chat.widget.getAttribute("lang")).toBe(code === "en" ? null : code);
  }
  copy.remove();
  expect(chat.panel.outerHTML).toBe(original);
  dispose();
  expect(Object.hasOwn(chat.error, "textContent")).toBe(false);
  for (const path of files) expect(path).toMatch(/^\/chat-languages\/[\w-]+\.json$/);
});

simulate("the language picker searches, pages and chooses by keyboard without leaving the chat", async draw => {
  const store = createCryptoChatLanguage(CRYPTO_SUPPORT_WORKSPACE, API, staticFiles([]));
  const widget = document.createElement("div");
  document.body.append(widget);
  const root = widget.attachShadow({ mode: "open" });
  const panel = make("section", "panel conversation-chat shared-chat");
  const menu = make("div", "chat-menu");
  const tools = make("div", "tools");
  const people = make("section", "drawer-section drawer-people");
  menu.append(tools, people);
  const details = make("details", "chat-options");
  details.append(make("summary"), menu);
  const empty = make("div", "chat-empty");
  empty.append(make("strong", "", "Ask about Bitcoin, Solana, Ethereum, layer 2s, DeFi or wallets."));
  const body = make("div", "body");
  body.append(empty);
  const draft = make("textarea");
  const typed = draw.text("gm wen refund 😀 ", draw.int(1, 20));
  draft.value = typed;
  panel.append(details, body, draft);
  const style = make("style");
  root.append(style, panel);
  const lifetime = new AbortController();
  const host = {
    el: (tag: string, text?: string, className?: string) => make(tag as "div", className, text),
    style,
    icon: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
    lifetime: lifetime.signal,
  } as unknown as TailHost;
  const refresh = cryptoLanguagePickers(host, tools, store);
  refresh();
  const section = menu.querySelector<HTMLElement>(".crypto-language-section")!;
  const pickers = [section.querySelector<HTMLElement>(".crypto-language")!, empty.querySelector<HTMLElement>(".crypto-language")!];
  expect(section.nextElementSibling).toBe(people);
  expect([section.hidden, ...pickers.map(picker => picker.hidden)]).toEqual([true, true, true]);
  await enable(store);
  expect([section.hidden, ...pickers.map(picker => picker.hidden)]).toEqual([false, false, false]);
  const escapes: string[] = [];
  panel.addEventListener("keydown", event => escapes.push(event.key));
  for (let round = 0; round < 4; round++) {
    const picker = draw.pick(pickers);
    const trigger = picker.querySelector("button")!;
    const search = picker.querySelector("input")!;
    const list = picker.querySelector<HTMLElement>("[role=listbox]")!;
    const target = draw.pick(CRYPTO_LANGUAGES);
    const name = draw.pick([target.native, target.english, target.english.toLowerCase(), fold(target.native)]);
    const query = name.slice(0, draw.int(1, Math.min(name.length, 6)));
    trigger.focus();
    if (draw.chance(0.5)) key(trigger, query[0]);
    else trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(root.activeElement).toBe(search);
    search.value = query;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const options = [...list.querySelectorAll<HTMLElement>("[role=option]")];
    expect(options.some(option => option.dataset.code === target.code), query).toBe(true);
    let active = 0;
    for (let press = draw.int(0, 6); press > 0; press--) {
      const [step, delta] = draw.pick([["ArrowDown", 1], ["ArrowUp", -1], ["PageDown", 8], ["PageUp", -8]] as const);
      key(search, step);
      active = Math.min(Math.max(active + delta, 0), options.length - 1);
    }
    expect(search.getAttribute("aria-activedescendant")).toBe(options[active].id);
    expect(options.filter(option => option.hasAttribute("data-active"))).toEqual([options[active]]);
    // An input method's Enter finishes the word; it chooses nothing.
    key(search, "Enter", { isComposing: true });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const chosen = draw.chance(0.5) ? options[active] : options.find(option => option.dataset.code === target.code)!;
    if (chosen === options[active] && draw.chance(0.5)) key(search, "Enter");
    else chosen.click();
    await vi.waitFor(() => expect(store.state.chosen?.code).toBe(chosen.dataset.code));
    await settle();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(trigger);
    for (const each of pickers) expect(each.querySelector("button")!.textContent).toContain(store.state.chosen!.native);
    expect(localStorage.getItem(SAVED)).toBe(chosen.dataset.code);
    // Escape closes only the list and keeps focus on its control.
    key(trigger, "ArrowDown");
    search.value = "qqqzzzxx";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(list.querySelectorAll("[role=option]").length).toBe(0);
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    expect(picker.querySelector(".crypto-language-panel [role=status]")!.textContent).toBe(store.t("No languages found"));
    key(search, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(trigger);
  }
  expect(escapes).not.toContain("Escape");
  expect(draft.value).toBe(typed);
  lifetime.abort();
});
