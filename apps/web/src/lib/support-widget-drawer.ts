import { brandAsset } from "./brand-assets";
import type { TailHost } from "./support-widget";
import { addVisitorThemeControl } from "./support-widget-visitor-theme";

declare const __TEMPL_WIDGET_DRAWER_NOTICES__: string | undefined;
declare const __TEMPL_WIDGET_DRAWER_WALLET__: string | undefined;
const refreshOptions = new WeakMap<TailHost, () => void>();

/** Both header controls share the panel while the visitor keeps their place. */
export function bindSupportDrawer(host: TailHost, actions: HTMLElement, signal: AbortSignal) {
  const {el} = host;
  const menu = actions.closest<HTMLElement>(".chat-menu")!;
  const disclosure = menu.closest("details")!;
  const trigger = disclosure.querySelector("summary")!;
  const header = disclosure.closest<HTMLElement>(".head")!;
  const menuIcon = host.icon("chat");
  menuIcon.querySelector("path")!.setAttribute("d", "M4 6h16M4 12h16M4 18h16");
  trigger.replaceChildren(menuIcon);
  trigger.setAttribute("aria-label", "Menu");
  const people = header.querySelector<HTMLDetailsElement>(".chat-people")!;
  const peopleTrigger = people.querySelector("summary")!;
  const theme = addVisitorThemeControl(host, people, signal);
  const peopleView = people.querySelector<HTMLElement>(".chat-people-menu")!;
  peopleTrigger.setAttribute("aria-label", "People");

  // The roster already identifies the visitor, including a verified wallet.
  peopleView.querySelector(":scope > .sub")?.remove();
  const history = header.querySelector<HTMLDetailsElement>(".chat-history");
  const historyView = history?.querySelector<HTMLElement>(".member-conversations");
  const panes = [
    {details: disclosure, control: trigger, content: menu, label: "Conversation options"},
    {details: people, control: peopleTrigger, content: peopleView, label: "People"},
  ];
  if (history && historyView)
    panes.push({details: history, control: history.querySelector("summary")!, content: historyView, label: "Conversations"});

  const activePane = () => panes.find(pane => pane.details.open);
  let refreshNotices: ((menuOpen: boolean) => void) | undefined;
  let refreshWallet: (() => void) | undefined;
  const refreshMenu = () => { updateTeamLink(); refreshWallet?.(); refreshNotices?.(activePane()?.details === disclosure); };
  refreshOptions.set(host, refreshMenu);
  const loadNotices = () => typeof __TEMPL_WIDGET_DRAWER_NOTICES__ === "string"
    ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_DRAWER_NOTICES__, import.meta.url).href)
    : import("./support-widget-drawer-notices");
  let loading: Promise<unknown> | undefined;
  let loadingWallet: Promise<unknown> | undefined;
  const drawer = el("div", undefined, "flex-drawer");
  drawer.id = "conversation-drawer";
  drawer.setAttribute("role", "region");
  for (const {control} of panes) control.setAttribute("aria-controls", drawer.id);
  const backdrop = el("span", undefined, "flex-menu-backdrop");
  backdrop.setAttribute("aria-hidden", "true");
  menu.before(backdrop, drawer);
  drawer.append(menu);
  const footer = el("footer", undefined, "flex-brand");
  const brand = el("a");
  brand.href = "https://usetempl.com/";
  brand.target = "_blank";
  brand.rel = "noopener noreferrer";
  brand.setAttribute("aria-label", "Templ home (opens in a new tab)");
  const logo = el("img");
  // Published embeds load art from the script's origin. The first-party app
  // serves it from the page; Next can give bundled modules a file: URL.
  const artBase = typeof __TEMPL_WIDGET_DRAWER_STYLE__ === "string" ? import.meta.url : header.ownerDocument.baseURI;
  logo.src = new globalThis.URL(brandAsset("/art/brand/lockup-for-light.svg"), artBase).href;
  logo.alt = "Templ";
  brand.append(logo);
  const team = el("span");
  footer.append(brand, team);
  drawer.append(footer);
  let shownName: string | undefined;
  let shownWebsite: string | undefined;
  function updateTeamLink() {
    const link = host.policy?.supportProfiles?.teamLink;
    if (link?.name === shownName && link?.website === shownWebsite) return;
    shownName = link?.name;
    shownWebsite = link?.website;
    team.replaceChildren();
    if (!link) return;
    const site = el("a", link.name);
    site.href = link.website;
    site.target = "_blank";
    site.rel = "noopener noreferrer";
    team.append("This is ", site, " secure support");
  }
  let displayedPane = panes[0]!;

  const panel = header.closest<HTMLElement>(".panel")!;
  const body = panel.querySelector<HTMLElement>(".body");
  const form = host.draft.closest("form");
  let keepPlace: (() => void) | undefined;
  function rememberPlace() {
    if (!body) return;
    if (body.scrollHeight - body.clientHeight - body.scrollTop <= 2)
      return () => { body.scrollTop = body.scrollHeight; };
    const top = body.getBoundingClientRect().top;
    const anchor = Array.from(body.querySelectorAll(".message")).find(row => row.getBoundingClientRect().bottom > top);
    if (!anchor) return;
    const offset = anchor.getBoundingClientRect().top - top;
    return () => {
      if (body.contains(anchor)) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
    };
  }
  if (form && body && typeof ResizeObserver !== "undefined") {
    const sizes = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === form)
          panel.style.setProperty("--composer-height", `${form.getBoundingClientRect().height}px`);
        if (entry.target === body) keepPlace?.();
      }
    });
    sizes.observe(form, {box: "border-box"});
    sizes.observe(body);
    signal.addEventListener("abort", () => sizes.disconnect(), {once: true});
    body.addEventListener("transitionend", event => {
      if (event.target === body) { keepPlace?.(); keepPlace = undefined; }
    }, {signal});
    // Let the visitor scroll away even during the short resize.
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
      body.addEventListener(type, () => { keepPlace = undefined; }, {passive: true, signal});
    form.addEventListener("pointerdown", event => {
      if (activePane()) event.stopPropagation();
    }, {signal});
  }

  function syncDrawer() {
    const active = activePane();
    if (active?.details === disclosure && !refreshWallet) {
      loadingWallet ??= (typeof __TEMPL_WIDGET_DRAWER_WALLET__ === "string"
        ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_DRAWER_WALLET__, import.meta.url).href)
        : import("./support-widget-drawer-wallet")).then(module => {
        if (!signal.aborted) refreshWallet = module.drawerWallet(host, menu, signal);
      }).catch(() => { loadingWallet = undefined; });
    }
    if (active?.details === disclosure && host.policy?.replyEmail && !refreshNotices) {
      loading ??= loadNotices().then(module => {
        if (!signal.aborted) {
          refreshNotices = module.drawerNotices(host, menu, signal);
          refreshMenu();
        }
      }).catch(() => { loading = undefined; });
    }
    refreshMenu();
    // Inactive content goes back under its own disclosure. The roster and
    // history keep their original elements and authenticated event handlers.
    if (active && displayedPane !== active) {
      displayedPane.details.append(displayedPane.content);
      active.details.append(backdrop, drawer);
      drawer.prepend(active.content);
      displayedPane = active;
      active.content.scrollTop = 0;
    }
    for (const pane of panes) pane.control.setAttribute("aria-expanded", String(pane === active));
    if (active) drawer.setAttribute("aria-label", active.label);
    const changed = Boolean(active) !== panel.hasAttribute("data-drawer-open");
    if (changed) keepPlace = rememberPlace();
    panel.toggleAttribute("data-drawer-open", Boolean(active));
    drawer.hidden = backdrop.hidden = !active;
    if (changed) {
      const motion = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (active && motion) drawer.animate?.(
        [{transform: "translateX(100%)"}, {transform: "translateX(0)"}],
        {duration: 180, easing: "ease-out"},
      );
      keepPlace?.();
      if (!motion || !body?.getAnimations?.().length) keepPlace = undefined;
      if (!active) host.render?.();
    }
  }
  syncDrawer();
  for (const {details} of panes) details.addEventListener("toggle", syncDrawer, {signal});

  function dismiss() {
    const control = activePane()?.control;
    for (const {details} of panes) details.open = false;
    syncDrawer();
    control?.focus({preventScroll: true});
  }
  // Outside clicks in the shared widget run on pointerdown. Let this header
  // handle the complete click before another control changes the open view.
  header.addEventListener("pointerdown", event => {
    if (activePane()) event.stopPropagation();
  }, {signal});
  header.addEventListener("click", event => {
    const target = event.target as Node;
    if (theme.contains(target)) return;
    const chosen = panes.find(pane => pane.control.contains(target));
    if (chosen) {
      event.preventDefault();
      const opening = !chosen.details.open;
      for (const pane of panes) pane.details.open = pane === chosen && opening;
      syncDrawer();
      chosen.control.focus({preventScroll: true});
      return;
    }
    const active = activePane();
    if (!active) return;
    if (drawer.contains(target) && target !== drawer && target !== active.content && target !== actions) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }, {capture: true, signal});
  header.ownerDocument.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !activePane()) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }, {capture: true, signal});
  panel.classList.add("shared-chat");
  return { menu, panel, disclosure, drawer, refreshMenu };
}


declare const __TEMPL_WIDGET_DRAWER_STYLE__: string | undefined;
const configured = new WeakSet<TailHost>();
/** Each instance owns its listeners until its widget is destroyed. */
export function prepareDrawer(host: TailHost, actions: HTMLElement) {
  if (configured.has(host)) { refreshOptions.get(host)?.(); return; }
  if (!host.lifetime) return;
  configured.add(host);
  const signal = host.lifetime;
  const style = typeof __TEMPL_WIDGET_DRAWER_STYLE__ === "string"
    ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_DRAWER_STYLE__, import.meta.url).href)
    : import("./support-widget-drawer-style");
  void style.then(module => {
    if (signal.aborted || !actions.isConnected) return;
    host.style.textContent += module.drawerStyle;
    bindSupportDrawer(host, actions, signal);
  }).catch(() => configured.delete(host));
}
