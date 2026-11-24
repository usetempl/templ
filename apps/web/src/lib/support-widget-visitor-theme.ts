import type { TailHost } from "./support-widget";

/** Save only an explicit appearance choice, scoped to this site and workspace. */
export function addVisitorThemeControl(host: TailHost, menu: HTMLElement, signal: AbortSignal) {
  const widget = (menu.getRootNode() as ShadowRoot).host as HTMLElement;
  const key = `templ:chat-theme:${host.options.workspace}`;
  const siteAppearance = widget.closest("[data-templ-site-appearance]");
  const control = host.el("button", undefined, "visitor-theme");
  control.type = "button";
  control.setAttribute("aria-label", "Dark mode");
  host.style.append(document.createTextNode(`
    .shared-chat .head .visitor-theme{display:grid;place-items:center;flex:0 0 44px;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--t);cursor:pointer}
    .shared-chat .head .visitor-theme:focus-visible{outline:2px solid var(--af);outline-offset:-3px}
    .shared-chat .head .visitor-theme::after{display:none}
    .visitor-theme svg{width:18px;height:18px;transition:transform .14s ease-out}
    .visitor-theme path{transition:opacity .16s ease-out}
    .visitor-theme[aria-pressed=false] path:last-child,.visitor-theme[aria-pressed=true] path:first-child{opacity:0}
    .visitor-theme:active svg{transform:scale(.88) rotate(12deg)}
    @media(prefers-reduced-motion:reduce){.visitor-theme svg,.visitor-theme path{transition:none}.visitor-theme:active svg{transform:none}}
  `));
  const icon = host.icon("chat");
  const path = icon.querySelector("path")!;
  const sun = "M16 12a4 4 0 1 1-8 0 4 4 0 1 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19";
  const moon = "M20.4 14A8.6 8.6 0 0 1 10 3.6 8.8 8.8 0 1 0 20.4 14Z";
  path.setAttribute("d", sun);
  const moonPath = path.cloneNode(false) as SVGPathElement;
  moonPath.setAttribute("d", moon);
  icon.append(moonPath);
  const display = () => {
    const dark = widget.dataset.theme === "dark";
    control.setAttribute("aria-pressed", String(dark));
  };
  const apply = (value: string | null) => {
    if (value !== "light" && value !== "dark") return;
    widget.dataset.visitorTheme = value;
    widget.dispatchEvent(new Event("visitor-theme"));
    display();
  };
  if (!siteAppearance) {
    try { apply(localStorage.getItem(key)); } catch { /* Storage is optional. */ }
  }
  display();
  const observer = new MutationObserver(display);
  observer.observe(widget, { attributes: true, attributeFilter: ["data-theme"] });
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  control.append(icon);
  menu.before(control);
  control.addEventListener("click", () => {
    const value = widget.dataset.theme === "dark" ? "light" : "dark";
    if (siteAppearance) {
      siteAppearance.dispatchEvent(new CustomEvent("templ:visitor-appearance", {bubbles: true, detail: value}));
      return;
    }
    apply(value);
    try { localStorage.setItem(key, value); } catch { /* The open chat keeps the choice. */ }
  }, { signal });
  return control;
}
