import { cryptoLanguage, isCryptoLanguage, type CryptoChatLanguage } from "@templ/chat/crypto-languages";
import { CRYPTO_CHAT_STRINGS, type CryptoChatString } from "./crypto-chat-strings";
import { supportStorageKey } from "./support-widget-return";

export type CryptoChatLanguageState = Readonly<{
  /** The workspace's latest public policy turned the language choice on. */
  enabled: boolean;
  /** The visitor's explicit choice. Replies follow the question's language until there is one. */
  chosen?: CryptoChatLanguage;
  /** The language the interface shows now. */
  shown: CryptoChatLanguage;
  /** English interface strings mapped to the shown language. */
  strings: ReadonlyMap<string, string>;
  loading?: CryptoChatLanguage;
  failed?: CryptoChatLanguage;
}>;

export type CryptoChatLanguageStore = ReturnType<typeof createCryptoChatLanguage>;

export const ENGLISH = cryptoLanguage("en")!;
const KEYS: ReadonlySet<string> = new Set(CRYPTO_CHAT_STRINGS);
const TOKEN = /\{[a-zA-Z]\w*\}/g;
const MAX_BUNDLE = 256 * 1024;
const MAX_TEXT = 600;
/** C0 and C1 controls, and bidi embeddings and overrides that could reorder a wallet
 * address. Bidi isolates and marks stay allowed. */
const unsafe = (text: string) => [...text].some(character => {
  const code = character.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e);
});
/** Ordinary visitor sends. Handoffs, leads, checks and encrypted records stay unchanged. */
const SEND_FIELDS: ReadonlySet<string> = new Set(["text", "clientId", "context", "contextConsent", "newCaseFrom"]);

const tokens = (text: string) => (text.match(TOKEN) ?? []).sort().join();

/** Keeps the entries that translate a catalog string as plain text with the same tokens. */
export function checkedLanguageBundle(value: unknown): ReadonlyMap<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid language bundle.");
  const strings = new Map<string, string>();
  for (const [source, text] of Object.entries(value)) {
    if (!KEYS.has(source) || typeof text !== "string") continue;
    const shown = text.trim();
    if (shown && shown.length <= MAX_TEXT && !unsafe(shown) && tokens(shown) === tokens(source))
      strings.set(source, shown);
  }
  if (!strings.size) throw new Error("Invalid language bundle.");
  return strings;
}

/** Fills {tokens} from values; a missing value keeps its token. */
export function fillTokens(text: string, values?: Readonly<Record<string, string>>) {
  return values ? text.replace(TOKEN, token => {
    const name = token.slice(1, -1);
    return Object.hasOwn(values, name) ? values[name] : token;
  }) : text;
}

/** An interface string in a state's language; English without a state. */
export const cryptoChatText = (
  state: CryptoChatLanguageState | undefined,
  text: CryptoChatString,
  values?: Readonly<Record<string, string>>,
) => fillTokens(state?.strings.get(text) ?? text, values);

/** One hosted crypto chat's language: off until its policy says so, English until the
 * visitor chooses. Only an explicit choice is saved, for this workspace. */
export function createCryptoChatLanguage(workspace: string, apiUrl: string, load: typeof fetch = fetch) {
  const key = supportStorageKey("language", workspace);
  const api = new URL(apiUrl).origin;
  const base = `/widget/${workspace}`;
  const sends = new RegExp(`^/widget/${workspace}/conversations/(?:ask|tc-[0-9a-f]{32}/messages)$`);
  const listeners = new Set<() => void>();
  const bundles = new Map<string, Promise<ReadonlyMap<string, string>>>();
  const english = new Map<string, string>();
  let request = 0;
  let loading: AbortController | undefined;
  let state: CryptoChatLanguageState = { enabled: false, chosen: saved(), shown: ENGLISH, strings: new Map() };

  function saved() {
    try {
      return cryptoLanguage(localStorage.getItem(key));
    } catch {
      return undefined;
    }
  }
  function set(next: Partial<CryptoChatLanguageState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }
  function bundle(code: string) {
    let found = bundles.get(code);
    if (!found) {
      loading = new AbortController();
      const { signal } = loading;
      found = load(`/chat-languages/${code}.json`, { credentials: "omit", cache: "no-cache", signal })
        .then(async response => {
          if (!response.ok) throw new Error("Language unavailable.");
          const text = await response.text();
          if (text.length > MAX_BUNDLE) throw new Error("Invalid language bundle.");
          const strings = checkedLanguageBundle(JSON.parse(text));
          if (strings.size !== KEYS.size) throw new Error("Incomplete language bundle.");
          for (const [source, shown] of strings) if (!english.has(shown)) english.set(shown, source);
          return strings;
        });
      found.catch(() => {
        if (bundles.get(code) === found) bundles.delete(code);
      });
      bundles.set(code, found);
    }
    return found;
  }
  function cancelPending() {
    if (state.loading && loading) {
      bundles.delete(state.loading.code);
      loading.abort();
    }
    loading = undefined;
  }
  /** Shows a language. A new choice is saved only once its interface is ready. */
  async function show(language: CryptoChatLanguage, choice: boolean) {
    const current = ++request;
    if (state.loading?.code !== language.code) cancelPending();
    if (language.code === ENGLISH.code) {
      if (choice) remember(language);
      set({ shown: language, strings: new Map(), loading: undefined, failed: undefined, ...(choice ? { chosen: language } : {}) });
      return;
    }
    set({ loading: language, failed: undefined });
    try {
      const strings = await bundle(language.code);
      if (current !== request || !state.enabled) return;
      if (choice) remember(language);
      set({ shown: language, strings, loading: undefined, ...(choice ? { chosen: language } : {}) });
    } catch {
      if (current === request) set({ loading: undefined, failed: language });
    }
  }
  function remember(language: CryptoChatLanguage) {
    try {
      localStorage.setItem(key, language.code);
    } catch { /* The choice still applies while this chat is open. */ }
  }
  function policy(enabled: boolean) {
    if (enabled === state.enabled) return;
    if (!enabled) {
      ++request;
      cancelPending();
      set({ enabled, shown: ENGLISH, strings: new Map(), loading: undefined, failed: undefined });
      return;
    }
    set({ enabled });
    if (state.chosen && state.chosen.code !== ENGLISH.code) void show(state.chosen, false);
  }
  function withLanguage(path: string, body: string) {
    const code = state.enabled && state.chosen === state.shown ? state.chosen.code : undefined;
    if (!code || !sends.test(path) || !body.startsWith('{"')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      typeof (parsed as { text?: unknown }).text !== "string" ||
      !Object.keys(parsed).every(field => SEND_FIELDS.has(field))) return;
    // The visitor's text keeps its exact bytes; only the leading field is new.
    return `{"preferredLanguage":${JSON.stringify(code)},${body.slice(1)}`;
  }

  return {
    get state() {
      return state;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The visitor picked a language from the list. */
    choose(code: string) {
      const language = isCryptoLanguage(code) ? cryptoLanguage(code) : undefined;
      return language && state.enabled ? show(language, true) : Promise.resolve();
    },
    t: (text: CryptoChatString, values?: Readonly<Record<string, string>>) => cryptoChatText(state, text, values),
    /** The English source of a string from any bundle loaded in this chat. */
    english: (text: string) => english.get(text),
    /** The widget's transport: it reads the flag from each policy answer and adds the
     * explicit choice to ordinary sends. Every other request passes through as it was. */
    transport(inner: typeof fetch = fetch): typeof fetch {
      return async (input, init) => {
        let url: URL | undefined;
        try {
          if (typeof input === "string") url = new URL(input);
        } catch { /* Not an API address. */ }
        if (url?.origin !== api) return inner(input, init);
        if (url.pathname === `${base}/auth/policy` && (init?.method ?? "GET") === "GET") {
          const response = await inner(input, init);
          if (response.ok)
            void response.clone().json().then(
              (answer: { cryptoChatLanguage?: unknown } | null) => policy(answer?.cryptoChatLanguage === true),
              () => {},
            );
          return response;
        }
        const body = init?.method === "POST" && typeof init.body === "string"
          ? withLanguage(url.pathname, init.body) : undefined;
        return inner(input, body ? { ...init, body } : init);
      };
    },
  };
}
