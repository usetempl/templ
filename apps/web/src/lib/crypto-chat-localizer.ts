import { CRYPTO_CHAT_STRINGS } from "./crypto-chat-strings";
import { ENGLISH, fillTokens, type CryptoChatLanguageStore } from "./crypto-chat-language";

type Template = { source: string; names: string[]; pattern: RegExp };
type Shown = { source: string; shown: string };
type Labelled = "aria-label" | "aria-description";

const INTERFACE = new Set<string>();
const TEMPLATES: Template[] = [];
for (const source of CRYPTO_CHAT_STRINGS) {
  const names: string[] = [];
  const pattern = source.replace(/\{([a-zA-Z]\w*)\}|[.*+?^$()|[\]\\{}]/g, (match, name?: string) => {
    if (!name) return "\\" + match;
    names.push(name);
    return "(.+?)";
  });
  if (names.length) TEMPLATES.push({ source, names, pattern: new RegExp(`^${pattern}$`) });
  else INTERFACE.add(source);
}

/* Code-owned boundaries. Visitor, team and AI message text, typed input, team-written
 * lines, addresses and this feature's own controls are never rewritten. Inside a message
 * only its sender label and send state are interface text. */
const KEEP_TEXT = "style,script,textarea,input,select,option,[contenteditable],time,code,pre,bdi," +
  ".suggestions,.header-notice,[data-check-id],.nudge:not([data-state]),.shared-list .row>span,[data-crypto-language]";
const KEEP_ATTRIBUTES = ".suggestions,.header-notice,[data-crypto-language]";
const MESSAGE = ".message:not(.tail)";
const MESSAGE_INTERFACE = ".message:not(.tail)>small,.message:not(.tail) .state";
const ATTRIBUTES = ["aria-label", "aria-description", "placeholder", "title", "data-tip"];
const REFERENCE: Record<Labelled, string> = { "aria-label": "aria-labelledby", "aria-description": "aria-describedby" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const LOCAL_STYLE = `
@media (max-width:340px){.panel.shared-chat .head{gap:3px;padding-inline:8px}}
:host([lang]) .shared-chat .flex-brand>.drawer-create{max-inline-size:100%;min-inline-size:0;white-space:normal;overflow-wrap:anywhere;text-align:start}
:host([lang]) .flag:is(:hover,:focus-visible)::after{max-inline-size:min(16rem,65vw);width:max-content;white-space:normal;overflow-wrap:anywhere;text-align:start}
:host([dir=rtl]) .flag{float:left;margin:-2px 4px -6px -6px}
:host([dir=rtl]) .flag:is(:hover,:focus-visible)::after{left:0;right:auto}
.message:not(.tail),.composer textarea,.drawer-section-body input{unicode-bidi:plaintext}
:host([dir=rtl]) .shared-chat :is(.chat-options,.chat-history)[open]>:is(.flex-drawer,.flex-menu-backdrop){inset:var(--drawer-top) auto auto 0}
:host([dir=rtl]) .chat-avatars{padding:0 4px 0 0}
:host([dir=rtl]) .chat-avatars i{margin:0 -4px 0 0}
:host([dir=rtl]) .chat-menu .tools button,:host([dir=rtl]) .chat-menu>button{text-align:right}
:host([dir=rtl]) .conversation-chat .message{border-radius:14px 14px 4px 14px}
:host([dir=rtl]) .conversation-chat .message.own{border-radius:14px 14px 14px 4px}
:host([dir=rtl]) .conversation-chat .message.own[data-grouped=true]{border-top-left-radius:5px;border-top-right-radius:14px}
:host([dir=rtl]) .message.typing{box-shadow:inset -3px 0 var(--a)}
`;
let sequence = 0;

function textContentAccessor(element: Element) {
  for (let prototype = Object.getPrototypeOf(element); prototype; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "textContent");
    if (descriptor) return descriptor;
  }
}

/** Shows the hosted crypto chat's own interface in the visitor's chosen language. It
 * rewrites only exact catalog strings in place, so the widget keeps its draft, case,
 * focus, handlers and scroll position. Returns the cleanup. */
export function localizeCryptoChat(root: ShadowRoot, store: CryptoChatLanguageStore) {
  const page = root.ownerDocument;
  const widget = root.host as HTMLElement;
  const texts = new WeakMap<Text, Shown>();
  const attributes = new WeakMap<Element, Map<string, Shown>>();
  const proxies = new Map<Element, Partial<Record<Labelled, HTMLElement>>>();
  const alerts = new Set<HTMLElement>();
  const labels = page.createElement("div");
  labels.hidden = true;
  labels.dataset.cryptoLanguage = "";
  const style = page.createElement("style");
  style.nonce = root.querySelector("style")?.nonce ?? "";
  style.dataset.cryptoLanguage = "";
  style.textContent = LOCAL_STYLE;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData") {
        if (record.target instanceof Text) applyText(record.target);
      } else if (record.type === "attributes") {
        if (record.target instanceof Element && record.attributeName) applyAttribute(record.target, record.attributeName);
      } else for (const node of record.addedNodes) applyTree(node);
    }
    for (const [element, held] of proxies) if (!element.isConnected) release(element, held);
    for (const alert of alerts) if (!alert.isConnected) {
      Reflect.deleteProperty(alert, "textContent");
      alerts.delete(alert);
    }
  });
  let observing = false;
  let shown = ENGLISH;
  let enabled = false;
  let translated = false;
  let clock: Intl.DateTimeFormat | undefined;
  let calendar: Intl.DateTimeFormat | undefined;

  function token(name: string, value: string) {
    const { code } = shown;
    try {
      if (name === "duration") {
        const span = /^(\d+) (minute|hour|day)s?$/.exec(value);
        if (span) return new Intl.NumberFormat(code, { style: "unit", unit: span[2], unitDisplay: "long" }).format(Number(span[1]));
      } else if (name === "weekday") {
        const day = WEEKDAYS.indexOf(value);
        if (day >= 0) return new Intl.DateTimeFormat(code, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2024, 0, 1 + day));
      } else if (name === "count" || name === "seconds") {
        if (/^\d+$/.test(value)) return new Intl.NumberFormat(code).format(Number(value));
      } else if (name === "label") return store.state.strings.get(value) ?? value;
    } catch { /* Keep the value as written. */ }
    return value;
  }
  /** The shown form of an English interface string, or undefined for any other text. */
  function render(text: string, element: Element | null) {
    const { strings } = store.state;
    if (INTERFACE.has(text)) return strings.get(text) ?? text;
    if (element?.classList.contains("chat-day") && calendar) {
      const next = element.nextElementSibling;
      const time = next?.matches(".message") ? next.querySelector<HTMLTimeElement>(":scope > time[datetime]") : null;
      const instant = Date.parse(time?.dateTime ?? "");
      if (Number.isFinite(instant)) return calendar.format(instant);
    }
    for (const template of TEMPLATES) {
      const match = template.pattern.exec(text);
      if (!match) continue;
      const translation = strings.get(template.source);
      if (!translation) return text;
      return fillTokens(translation, Object.fromEntries(template.names.map((name, i) => [name, token(name, match[i + 1])])));
    }
  }
  function display(text: string, element: Element | null) {
    const trimmed = text.trim();
    if (!trimmed) return text;
    // A control can copy another control's translated label; read it as its English source.
    const value = render(trimmed, element) ?? render(store.english(trimmed) ?? "", element);
    if (value === undefined) return text;
    const start = text.indexOf(trimmed);
    return text.slice(0, start) + value + text.slice(start + trimmed.length);
  }
  const interfaceText = (element: Element) =>
    !element.closest(KEEP_TEXT) && (!element.closest(MESSAGE) ||
      (!!element.closest(MESSAGE_INTERFACE) && !element.matches(".message > small:has(> .tag)")));

  function applyText(node: Text) {
    const element = node.parentElement;
    if (!element) return;
    const timestamp = element.matches(".message > time[datetime],.system.joined > time[datetime]") &&
      node === element.firstChild;
    if (!timestamp && !interfaceText(element)) return;
    const entry = texts.get(node);
    const source = entry && node.data === entry.shown ? entry.source : node.data;
    const instant = timestamp ? Date.parse((element as HTMLTimeElement).dateTime) : NaN;
    const value = timestamp ? (clock && Number.isFinite(instant) ? clock.format(instant) : source) : display(source, element);
    if (node.data !== value) node.data = value;
    if (value === source) texts.delete(node);
    else texts.set(node, { source, shown: value });
  }
  function applyAttribute(element: Element, name: string) {
    if (!ATTRIBUTES.includes(name) || element.closest("[data-crypto-language]") ||
      (element.closest(KEEP_ATTRIBUTES) && !element.matches(".suggestions[aria-label]"))) return;
    if (name === "aria-label" || name === "aria-description") return label(element, name);
    const value = element.getAttribute(name);
    const held = attributes.get(element);
    const entry = held?.get(name);
    if (value === null) return void held?.delete(name);
    const source = entry && value === entry.shown ? entry.source : value;
    const next = display(source, null);
    if (value !== next) element.setAttribute(name, next);
    if (next === source) held?.delete(name);
    else attributes.set(element, (held ?? new Map()).set(name, { source, shown: next }));
  }
  /** The widget and its styles find controls by their English names, so a translated
   * name reaches assistive technology through a hidden label instead. */
  function label(element: Element, name: Labelled) {
    const reference = REFERENCE[name];
    const held = proxies.get(element) ?? {};
    const proxy = held[name];
    const value = element.getAttribute(name);
    const next = value === null ? null : display(value, null);
    if (value === null || next === value) {
      if (proxy) {
        proxy.remove();
        if (element.getAttribute(reference) === proxy.id) element.removeAttribute(reference);
        delete held[name];
        if (!held["aria-label"] && !held["aria-description"]) proxies.delete(element);
      }
      return;
    }
    const named = element.getAttribute(reference);
    if (named && named !== proxy?.id) return;
    const node = proxy ?? labels.appendChild(page.createElement("span"));
    if (!proxy) {
      node.id = `crypto-language-${++sequence}`;
      held[name] = node;
      proxies.set(element, held);
    }
    if (node.textContent !== next) node.textContent = next;
    if (named !== node.id) element.setAttribute(reference, node.id);
  }
  function release(element: Element, held: Partial<Record<Labelled, HTMLElement>>) {
    for (const name of ["aria-label", "aria-description"] as const) {
      const proxy = held[name];
      if (!proxy) continue;
      proxy.remove();
      if (element.getAttribute(REFERENCE[name]) === proxy.id) element.removeAttribute(REFERENCE[name]);
    }
    proxies.delete(element);
  }
  /** The widget compares its alert with English messages, for example to clear an outage
   * line after a successful read. Reads keep returning the English source. */
  function keepEnglishReads(element: HTMLElement) {
    const native = textContentAccessor(element);
    if (alerts.has(element) || !native?.get || !native.set) return;
    alerts.add(element);
    Object.defineProperty(element, "textContent", {
      configurable: true,
      get(this: HTMLElement) {
        const only = this.childNodes.length === 1 ? this.firstChild : null;
        if (only instanceof Text) {
          const entry = texts.get(only);
          if (entry && only.data === entry.shown) return entry.source;
        }
        return native.get!.call(this);
      },
      set(this: HTMLElement, value: string | null) {
        native.set!.call(this, value);
      },
    });
  }
  function applyTree(node: Node) {
    if (!node.isConnected) return;
    if (node instanceof Text) return applyText(node);
    if (!(node instanceof Element || node instanceof ShadowRoot)) return;
    const walker = page.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) found.push(text as Text);
    for (const text of found) applyText(text);
    const elements = [...node.querySelectorAll(ATTRIBUTES.map(name => `[${name}]`).join())];
    if (node instanceof Element) elements.unshift(node);
    for (const element of elements)
      for (const name of ATTRIBUTES) if (element.hasAttribute(name)) applyAttribute(element, name);
    const alertsHere = [...node.querySelectorAll<HTMLElement>(".error")];
    if (node instanceof HTMLElement && node.classList.contains("error")) alertsHere.push(node);
    for (const alert of alertsHere) keepEnglishReads(alert);
  }
  /** Keeps the visitor's place in the conversation while lines change length. */
  function keepPlace(change: () => void) {
    const body = root.querySelector<HTMLElement>(".panel>.body");
    if (!body) return change();
    const end = body.scrollHeight - body.clientHeight - body.scrollTop <= 2;
    const top = body.getBoundingClientRect().top;
    const anchor = end ? undefined : [...body.querySelectorAll(".message")].find(row => row.getBoundingClientRect().bottom > top);
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    change();
    if (end) body.scrollTop = body.scrollHeight;
    else if (anchor?.isConnected)
      body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
  }
  function update() {
    const state = store.state;
    if (state.enabled === enabled && state.shown === shown) return;
    enabled = state.enabled;
    shown = state.shown;
    const foreign = enabled && shown.code !== ENGLISH.code;
    clock = foreign ? new Intl.DateTimeFormat(shown.code, { hour: "numeric", minute: "2-digit" }) : undefined;
    calendar = foreign ? new Intl.DateTimeFormat(shown.code, { day: "numeric", month: "long" }) : undefined;
    translated ||= foreign;
    if (enabled && !style.isConnected) root.append(style, labels);
    if (foreign) {
      widget.lang = shown.code;
      widget.dir = shown.dir;
    } else {
      widget.removeAttribute("lang");
      widget.removeAttribute("dir");
    }
    if (translated) keepPlace(() => applyTree(root));
    // Once a bundle has loaded, later widget lines may copy a translated label.
    const watch = enabled && translated;
    if (watch && !observing)
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
    else if (!watch && observing) observer.disconnect();
    observing = watch;
    if (!enabled) {
      style.remove();
      labels.remove();
    }
  }
  const unsubscribe = store.subscribe(update);
  update();
  return () => {
    unsubscribe();
    observer.disconnect();
    for (const alert of alerts) Reflect.deleteProperty(alert, "textContent");
    alerts.clear();
  };
}
