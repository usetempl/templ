declare const __TEMPL_WIDGET_CONVERSATION__: string | undefined;
declare const __TEMPL_WIDGET_CONVERSATION_STYLE__: string | undefined;
declare const __TEMPL_WIDGET_CONVERSATIONS__: string | undefined;
const loadConversation = () => typeof __TEMPL_WIDGET_CONVERSATION__ === "string"
  ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_CONVERSATION__, import.meta.url).href)
  : import("./support-widget-chat-first");
const loadConversationStyle = () => typeof __TEMPL_WIDGET_CONVERSATION_STYLE__ === "string"
  ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_CONVERSATION_STYLE__, import.meta.url).href)
  : import("./support-widget-chat-style");
const loadConversations = () => typeof __TEMPL_WIDGET_CONVERSATIONS__ === "string"
  ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_CONVERSATIONS__, import.meta.url).href)
  : import("./support-widget-conversations");
declare const __TEMPL_WIDGET_DRAWER__: string | undefined;
const loadDrawer = () => typeof __TEMPL_WIDGET_DRAWER__ === "string"
  ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_DRAWER__, import.meta.url).href)
  : import("./support-widget-drawer");

let loading: ReturnType<typeof loadModules> | undefined;
function loadModules() {
  return Promise.all([loadConversation(), loadConversationStyle(), loadConversations(), loadDrawer()]);
}
/** Only static UI code can be warmed. The server policy still selects the controls. */
export function conversationModules() {
  return loading ??= loadModules().catch(error => {
    loading = undefined;
    throw error;
  });
}
