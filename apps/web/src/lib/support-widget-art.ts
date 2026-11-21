import type { SupportWidgetAppearance } from "./support-widget";
import { accentInk, widgetContrast } from "./support-widget-appearance";

type Pose = "default" | "happy" | "tight" | "crump" | "talk-a" | "talk-b";
const widgetOrigin = import.meta.url;

const FONTS = {
  inherit: "inherit",
  system: "system-ui, sans-serif",
  sans: "Arial, sans-serif",
  serif: "Georgia, serif",
  mono: "ui-monospace, monospace",
};
const color = (value: unknown) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : undefined;

/** Public appearance data changes display only. Notice text never becomes HTML. */
export function bindWidgetBranding(
  host: HTMLElement,
  initial: SupportWidgetAppearance,
) {
  const root = host.shadowRoot!;
  let appearance = initial;
  const style = document.createElement("style");
  style.nonce = root.querySelector("style")?.nonce ?? "";
  style.textContent =
    ".header-notice{flex:none;margin:0;padding:10px 16px;border-bottom:1px solid var(--b);background:var(--bg);color:var(--t);font-size:12px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}.avatar.logo{background:transparent}.avatar.logo img{width:100%;height:100%;object-fit:contain}.launcher-logo{width:20px;height:20px;object-fit:contain;flex:none}";
  root.append(style);
  const notice = document.createElement("p");
  notice.className = "header-notice";
  notice.setAttribute("role", "note");
  notice.hidden = true;
  root.querySelector(".head")?.after(notice);
  const targets = [
    root.querySelector<HTMLElement>(".avatar"),
    root.querySelector<HTMLElement>(".launcher,button[aria-expanded]"),
  ].filter((item): item is HTMLElement => !!item);
  const originals = targets.map((target) =>
    target.querySelector("svg")?.cloneNode(true),
  );
  let previousLogo: string | null | undefined;
  const property = (name: string, value?: string) => {
    if (value) {
      if (host.style.getPropertyValue(name) !== value)
        host.style.setProperty(name, value);
    } else if (host.style.getPropertyValue(name))
      host.style.removeProperty(name);
  };
  const apply = () => {
    const mode = host.dataset.theme === "light" ? "light" : "dark";
    const palette = appearance.colors?.[mode];
    const background = color(palette?.background);
    const bg = background ?? (mode === "light" ? "#f5f5f5" : "#161616");
    const readable = (candidate: unknown) => {
      const value = color(candidate);
      return value && widgetContrast(value, bg) >= 4.5 ? value : accentInk(bg);
    };
    property("--bg", background);
    property("--s", color(palette?.surface));
    property("--s2", color(palette?.surface));
    property(
      "--t",
      background || color(palette?.text) ? readable(palette?.text) : undefined,
    );
    property(
      "--m",
      background || color(palette?.muted)
        ? readable(palette?.muted)
        : undefined,
    );
    property("--b", color(palette?.border));
    property("--b2", color(palette?.border));
    const accent =
      typeof appearance.accent === "string"
        ? appearance.accent
        : appearance.accent?.[mode];
    if (background) {
      property("--at", readable(accent));
      property("--af", readable(accent));
    }
    const font =
      appearance.font &&
      Object.hasOwn(FONTS, appearance.font) &&
      FONTS[appearance.font];
    if (font) property("font-family", font);
    const text =
      appearance.headerNotice?.enabled === true &&
      typeof appearance.headerNotice.text === "string"
        ? appearance.headerNotice.text.trim().slice(0, 280)
        : "";
    if (notice.textContent !== text) notice.textContent = text;
    notice.hidden = !text;
    let logo: string | null = null;
    try {
      if (
        typeof appearance.logo === "string" &&
        appearance.logo.length <= 2048 &&
        appearance.logo.trim()
      ) {
        const url = new URL(appearance.logo, location.href);
        if (
          (url.protocol === "https:" || url.origin === location.origin) &&
          !url.username &&
          !url.password &&
          !(
            url.origin === location.origin && url.pathname === location.pathname
          )
        )
          logo = url.href;
      }
    } catch {
      /* Keep the chat icon. */
    }
    if (logo === previousLogo) return;
    previousLogo = logo;
    targets.forEach((target, index) => {
      const prior = target.querySelector("svg,img");
      if (!logo) {
        target.classList.remove("logo");
        if (prior && originals[index])
          prior.replaceWith(originals[index]!.cloneNode(true));
        return;
      }
      const image = document.createElement("img");
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.className = "launcher-logo";
      if (target.classList.contains("avatar")) target.classList.add("logo");
      image.addEventListener(
        "error",
        () => {
          if (originals[index] && image.isConnected) {
            target.classList.remove("logo");
            image.replaceWith(originals[index]!.cloneNode(true));
          }
        },
        { once: true },
      );
      image.src = logo;
      if (prior) prior.replaceWith(image);
      else target.prepend(image);
    });
  };
  const observer = new MutationObserver(apply);
  observer.observe(host, {
    attributes: true,
    attributeFilter: ["data-theme", "style"],
  });
  apply();
  return {
    set(next: SupportWidgetAppearance) {
      appearance = next;
      apply();
    },
    destroy() {
      observer.disconnect();
      notice.remove();
      style.remove();
    },
  };
}

/** Decorative art loads from the widget's origin and leaves text intact on failure. */
export function art(name: Pose) {
  const image = document.createElement("img");
  image.loading = "lazy";
  image.decoding = "async";
  image.alt = "";
  image.width = image.height = 48;
  image.src = new URL(`/art/widget/${name}.webp`, widgetOrigin).href;
  image.addEventListener("error", () => image.remove(), { once: true });
  return image;
}

/** Templ's own page mounts this after checking its support workspace. */
export function mount(root: ShadowRoot) {
  const style = document.createElement("style");
  style.nonce = root.querySelector("style")?.nonce ?? "";
  style.textContent =
    ".stamp-talk{display:grid;float:left;margin-right:10px}.stamp-talk img{grid-area:1/1;object-fit:contain;animation:stamp-talk .44s steps(1,end) infinite}.stamp-talk img+img{animation-delay:-.22s}.typing:has(.stamp-talk img) .dots{display:none}@keyframes stamp-talk{0%,49%{visibility:visible}50%,100%{visibility:hidden}}@media(prefers-reduced-motion:reduce){.stamp-talk img{animation:none}.stamp-talk img+img{display:none}}.stamp-state{display:block;object-fit:contain;margin:0 auto 12px}.stamp-offline{filter:grayscale(1)}.stamp-signed{animation:stamp-signed 1s ease-out}@keyframes stamp-signed{from{opacity:.4}to{opacity:1}}@media(prefers-reduced-motion:reduce){.stamp-signed{animation:none}}";
  root.append(style);
  const slot = document.createElement("div");
  slot.setAttribute("aria-hidden", "true");
  slot.hidden = true;
  root.querySelector(".messages")?.before(slot);
  let state = "",
    image: HTMLImageElement | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    received: Element | null = null,
    signed =
      root.querySelector(".sub")?.getAttribute("data-level") === "signed";
  const talks = new WeakSet<Element>();
  const show = (next: string, parent?: Element | null, pose?: Pose) => {
    if (next === state) return;
    state = next;
    image?.remove();
    image = undefined;
    clearTimeout(timer);
    slot.hidden = parent !== slot || !pose;
    if (parent && pose) {
      image = art(pose);
      image.className = `stamp-state stamp-${next}`;
      parent.prepend(image);
    }
  };
  const update = () => {
    for (const row of root.querySelectorAll('[data-state="typing agent"]')) {
      if (talks.has(row)) continue;
      talks.add(row);
      const frames = document.createElement("span");
      frames.className = "stamp-talk";
      frames.setAttribute("aria-hidden", "true");
      frames.append(art("talk-a"), art("talk-b"));
      row.prepend(frames);
    }
    const error = root.querySelector(".error"),
      receipt = root.querySelector('[data-state="received"]'),
      waiting = root.querySelector('[data-state="wait"], [data-state="slow"]'),
      identity = root.querySelector(".sub"),
      nowSigned = identity?.getAttribute("data-level") === "signed";
    if (error?.textContent?.trim()) {
      show(
        error.textContent.includes("Signature cancelled.")
          ? "cancelled"
          : "offline",
        error,
        "crump",
      );
    } else if (nowSigned && !signed) {
      signed = true;
      show("signed", slot, "happy");
      timer = setTimeout(() => {
        show("");
        update();
      }, 1000);
    } else if (receipt && receipt !== received) {
      received = receipt;
      show("sent", receipt, "happy");
      timer = setTimeout(() => {
        show("");
        update();
      }, 1000);
    } else if (state !== "sent" && state !== "signed") {
      if (waiting) show("waiting", waiting, "tight");
      else show("");
    }
    if (!nowSigned) signed = false;
  };
  const observer = new MutationObserver(update);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-level", "data-state"],
  });
  update();
  return () => {
    observer.disconnect();
    clearTimeout(timer);
    image?.remove();
    root.querySelectorAll(".stamp-talk").forEach((row) => row.remove());
    style.remove();
    slot.remove();
  };
}
