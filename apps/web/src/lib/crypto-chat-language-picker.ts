import { CRYPTO_LANGUAGES, type CryptoChatLanguage } from "@templ/chat/crypto-languages";
import type { TailHost } from "./support-widget";
import { ENGLISH, type CryptoChatLanguageStore } from "./crypto-chat-language";

/** Tabler's world icon, as one path for the widget's icon helper. */
const WORLD = "M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18";
const PAGE = 8;
const collator = new Intl.Collator("en");
const SORTED = [...CRYPTO_LANGUAGES].sort((a, b) => collator.compare(a.english, b.english));
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const styled = new WeakSet<TailHost>();
const STYLE = `
.crypto-language{display:grid;justify-items:center;gap:8px;margin-top:16px;color:var(--t);font-size:14px}
.drawer-section .crypto-language{justify-items:stretch;margin:0}
.crypto-language-trigger{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-height:44px;padding:0 14px;border:1px solid var(--b2);border-radius:22px;background:var(--bg);color:var(--t);font-size:14px;font-weight:600}
.crypto-language-trigger:hover{background:var(--s)}
.crypto-language-trigger>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crypto-language-trigger::after{content:"";flex:none;width:6px;height:6px;margin-inline-start:2px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:translateY(-2px) rotate(45deg)}
.crypto-language-trigger[aria-expanded=true]::after{transform:translateY(1px) rotate(-135deg)}
.shared-chat .drawer-section-body .crypto-language-trigger{justify-content:flex-start;border:1px solid var(--b2)}
.crypto-language-flag{flex:none;font-size:18px;line-height:1}
.crypto-language-panel{box-sizing:border-box;display:grid;gap:6px;width:min(100%,22rem);padding:8px;border:1px solid var(--b);border-radius:12px;background:var(--bg);box-shadow:0 8px 24px var(--shc);text-align:start}
.drawer-section .crypto-language-panel{width:auto;box-shadow:none}
.crypto-language-panel label{display:grid;gap:4px;color:var(--m);font-size:13px}
.crypto-language-panel input{box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:8px 12px;border:1px solid var(--b2);border-radius:8px;background:var(--s);color:var(--t);font:inherit;font-size:16px}
.crypto-language-list{position:relative;display:grid;align-content:start;max-height:18rem;max-height:min(18rem,40cqh);overflow:auto;overscroll-behavior:contain}
.crypto-language-option{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 10px;border-radius:8px;cursor:pointer;-webkit-user-select:none;user-select:none}
.crypto-language-option[data-active]{background:var(--s2);box-shadow:inset 0 0 0 2px var(--af)}
.crypto-language-option[aria-selected=true]{font-weight:600}
.crypto-language-option[aria-selected=true]::after{content:"✓" / "";margin-inline-start:auto;color:var(--at)}
.crypto-language-names{display:grid;min-width:0}
.crypto-language-names small{color:var(--m);font-size:12px;font-weight:400}
.crypto-language-note{margin:0;color:var(--m);font-size:13px}
.crypto-language-note:empty{display:none}
.conversation-chat .body:has(>.chat-empty:not([hidden]) .crypto-language:not([hidden])){display:flex;flex-direction:column}
.conversation-chat .body>.chat-empty:has(.crypto-language:not([hidden])){margin-block:auto}
@media(hover:hover){.crypto-language-option:hover{background:var(--s2)}}
`;

/** Every language whose own, English or current interface name matches. Word and name
 * starts come first; each group keeps alphabetical order. */
function matching(query: string, shown: CryptoChatLanguage) {
  const wanted = fold(query.trim());
  if (!wanted) return SORTED;
  let names: Intl.DisplayNames | undefined;
  try {
    if (shown.code !== ENGLISH.code) names = new Intl.DisplayNames([shown.code], { type: "language" });
  } catch { /* English and own names still match. */ }
  const starts: CryptoChatLanguage[] = [];
  const contains: CryptoChatLanguage[] = [];
  for (const language of SORTED) {
    let local: string | undefined;
    try {
      local = names?.of(language.code);
    } catch { /* Not every runtime names every language. */ }
    const keys = [language.native, language.english, language.code, local ?? ""].map(fold);
    if (keys.some(key => key.startsWith(wanted) || key.split(/[\s()-]+/).some(word => word.startsWith(wanted))))
      starts.push(language);
    else if (keys.some(key => key.includes(wanted))) contains.push(language);
  }
  return [...starts, ...contains];
}

function languagePicker(host: TailHost, store: CryptoChatLanguageStore, id: string, signal: AbortSignal) {
  const { el } = host;
  const root = el("div", undefined, "crypto-language");
  root.dataset.cryptoLanguage = "";
  const trigger = el("button", undefined, "crypto-language-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const flag = el("span", undefined, "crypto-language-flag");
  flag.setAttribute("aria-hidden", "true");
  const name = el("span");
  trigger.append(flag, name);
  const panel = el("div", undefined, "crypto-language-panel");
  panel.id = `${id}-panel`;
  panel.hidden = true;
  trigger.setAttribute("aria-controls", panel.id);
  const label = el("label");
  const caption = el("span");
  const search = el("input");
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.dir = "auto";
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-expanded", "true");
  const list = el("div", undefined, "crypto-language-list");
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  search.setAttribute("aria-controls", list.id);
  label.append(caption, search);
  const none = el("p", undefined, "crypto-language-note");
  none.setAttribute("role", "status");
  panel.append(label, list, none);
  const status = el("p", undefined, "crypto-language-note");
  status.setAttribute("role", "status");
  root.append(trigger, panel, status);
  let found: readonly CryptoChatLanguage[] = [];
  let active = -1;

  const current = () => store.state.shown;
  function option(language: CryptoChatLanguage, selected: string) {
    const row = el("div", undefined, "crypto-language-option");
    row.id = `${id}-${language.code}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(language.code === selected));
    row.dataset.code = language.code;
    const mark = el("span", language.flag, "crypto-language-flag");
    mark.setAttribute("aria-hidden", "true");
    const names = el("span", undefined, "crypto-language-names");
    const own = el("span", language.native);
    own.lang = language.code;
    own.dir = language.dir;
    names.append(own);
    if (language.english !== language.native) {
      const english = el("small", language.english);
      english.lang = "en";
      english.dir = "ltr";
      names.append(english);
    }
    row.append(mark, names);
    return row;
  }
  function move(index: number) {
    active = found.length ? Math.min(Math.max(index, 0), found.length - 1) : -1;
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) rows[i].toggleAttribute("data-active", i === active);
    const row = rows[active] as HTMLElement | undefined;
    if (!row) {
      search.removeAttribute("aria-activedescendant");
      return;
    }
    search.setAttribute("aria-activedescendant", row.id);
    // Scroll only the list, so the conversation keeps its place.
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }
  /** Lists the matches and highlights `target` when it is among them, else the first. */
  function fill(target?: string) {
    const selected = current().code;
    found = matching(search.value, store.state.shown);
    list.replaceChildren(...found.map(language => option(language, selected)));
    none.textContent = found.length ? "" : store.t("No languages found");
    move(Math.max(0, found.findIndex(language => language.code === target)));
  }
  function open(query = "") {
    if (!store.state.enabled) return;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.value = query;
    fill(query ? undefined : current().code);
    search.focus();
  }
  function close(returnFocus: boolean) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    list.replaceChildren();
    found = [];
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
  function choose(code: string | undefined) {
    close(true);
    if (code) void store.choose(code);
  }
  function render() {
    const { enabled, loading, failed } = store.state;
    if (!enabled) close(false);
    root.hidden = !enabled;
    const language = current();
    flag.textContent = language.flag;
    name.textContent = language.native;
    name.lang = language.code;
    name.dir = language.dir;
    trigger.setAttribute("aria-label", store.t("Language: {language}", { language: language.native }));
    caption.textContent = store.t("Search languages");
    list.setAttribute("aria-label", store.t("Languages"));
    status.textContent = loading ? store.t("Loading {language}…", { language: loading.native })
      : failed ? store.t("Couldn’t load {language}. Try again.", { language: failed.native }) : "";
    if (!panel.hidden) fill(found[active]?.code);
  }

  trigger.addEventListener("click", () => (panel.hidden ? open() : close(true)), { signal });
  trigger.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") open();
    // Typing on the closed control starts a search with that letter.
    else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey)
      open(event.key);
    else return;
    event.preventDefault();
  }, { signal });
  search.addEventListener("input", () => fill(), { signal });
  search.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "PageDown") move(active + PAGE);
    else if (event.key === "PageUp") move(active - PAGE);
    else if (event.key === "Enter") choose(found[active]?.code);
    else if (event.key === "Escape") {
      // Close the list before the drawer or chat sees Escape.
      event.stopPropagation();
      close(true);
    } else return;
    event.preventDefault();
  }, { signal });
  // Keep focus in the search field while a pointer picks or scrolls the list.
  list.addEventListener("pointerdown", event => event.preventDefault(), { signal });
  list.addEventListener("click", event => {
    const row = (event.target as Element).closest<HTMLElement>("[role=option]");
    if (row) choose(row.dataset.code);
  }, { signal });
  // Focus left the control once it settles outside it, by Tab, a tap elsewhere or another control.
  root.addEventListener("focusout", () => queueMicrotask(() => {
    if (!root.contains((root.getRootNode() as Document | ShadowRoot).activeElement)) close(false);
  }), { signal });
  return { root, render };
}

/** The crypto desk's language choice in its menu and in the empty chat. Returns the
 * menu's refresh, which keeps the empty-chat control in place across renders. */
export function cryptoLanguagePickers(host: TailHost, actions: HTMLElement, store: CryptoChatLanguageStore) {
  const signal = host.lifetime!;
  if (!styled.has(host)) {
    styled.add(host);
    host.style.textContent += STYLE;
  }
  const menu = actions.closest<HTMLElement>(".chat-menu")!;
  const panel = menu.closest<HTMLElement>(".panel")!;
  const section = host.el("section", undefined, "drawer-section crypto-language-section");
  section.dataset.cryptoLanguage = "";
  const heading = host.el("h3");
  const title = host.el("span");
  heading.append(host.icon("chat", WORLD), title);
  const body = host.el("div", undefined, "drawer-section-body");
  const inMenu = languagePicker(host, store, "crypto-language-menu", signal);
  const inChat = languagePicker(host, store, "crypto-language-chat", signal);
  body.append(inMenu.root);
  section.append(heading, body);
  const people = menu.querySelector(":scope > .drawer-people");
  if (people) people.before(section);
  else menu.prepend(section);
  function render() {
    section.hidden = !store.state.enabled;
    title.textContent = store.t("Language");
    inMenu.render();
    inChat.render();
  }
  const unsubscribe = store.subscribe(render);
  signal.addEventListener("abort", unsubscribe, { once: true });
  render();
  return () => {
    const empty = panel.querySelector<HTMLElement>(".chat-empty");
    if (empty && inChat.root.parentElement !== empty) empty.append(inChat.root);
  };
}
