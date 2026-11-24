import {
  WIDGET_LIGHT_ACCENT,
  WIDGET_DARK_ACCENT,
  WIDGET_LIGHT_SURFACES,
  WIDGET_DARK_SURFACES,
  WIDGET_FRAME_COLORS,
} from "./support-widget-theme";
import type { SupportWidgetAppearance } from "./support-widget";

export type WidgetTheme = "light" | "dark";
export type WidgetAccent = string | { light: string; dark: string };
export type WidgetAppearance = Pick<SupportWidgetAppearance, "theme" | "accent" | "radius" | "position" | "colors">;
type Palette = NonNullable<WidgetAppearance["colors"]>[WidgetTheme];
export type WidgetDisplay = { theme: WidgetTheme; font: string };
export const WIDGET_DEFAULT_ACCENT = {
  light: WIDGET_LIGHT_ACCENT,
  dark: WIDGET_DARK_ACCENT,
};
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const linear = (n: number) =>
  n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
const luminance = (rgb: number[]) =>
  0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const ratio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
export const widgetContrast = (a: string, b: string) =>
  ratio(luminance(rgb(a)), luminance(rgb(b)));
const contrastingInk = (level: number) => level > 0.179 ? "#000000" : "#ffffff";
/** Black or white always passes 4.5:1 against an opaque sRGB color. */
export function accentInk(hex: string) {
  return contrastingInk(luminance(rgb(hex)));
}

/** OKLab's a and b retain the OKLCH hue and chroma as lightness changes. */
function lab(hex: string) {
  const [r, g, b] = rgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function channels([L, a, b]: number[]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(clamp);
}
const css = ([L, a, b]: number[]) =>
  `oklch(${L.toFixed(5)} ${Math.hypot(a, b).toFixed(5)} ${((Math.atan2(b, a) * 180) / Math.PI).toFixed(3)})`;
export function widgetSurfaces(mode: WidgetTheme, palette?: Palette) {
  const defaults = mode === "light" ? WIDGET_LIGHT_SURFACES : WIDGET_DARK_SURFACES;
  return defaults.map((fallback, i) => {
    const value = i === 0 ? palette?.background : palette?.surface;
    return value && HEX.test(value) ? value : fallback;
  });
}

/** Keep the fill exact. Adjust the lightness of accent text and focus against the chat surfaces. */
export function widgetAccentTokens(
  accent: WidgetAccent | undefined,
  mode: WidgetTheme,
  palette?: Palette,
) {
  const candidate = typeof accent === "string" ? accent : accent?.[mode];
  const brand =
    typeof candidate === "string" && HEX.test(candidate)
      ? candidate
      : WIDGET_DEFAULT_ACCENT[mode];
  const base = lab(brand);
  const surfaces = widgetSurfaces(mode, palette).map((color) => luminance(rgb(color)));
  const direction = ratio(0, Math.min(...surfaces)) > ratio(1, Math.max(...surfaces)) ? -1 : 1;
  const readableOnSurfaces = (level: number, minimum: number) => surfaces.every((bg) => ratio(level, bg) >= minimum);
  const adjusted = (minimum: number) => {
    if (readableOnSurfaces(luminance(rgb(brand)), minimum))
      return brand;
    const value = [...base];
    // A small margin covers display gamut mapping and decimal rounding.
    for (let i = 1; i <= 200; i++) {
      value[0] = clamp(base[0] + (direction * i) / 200);
      if (readableOnSurfaces(luminance(channels(value)), minimum + 0.2))
        break;
    }
    return css(value);
  };
  const state = (step: number) => {
    const value = [...base];
    const way =
      (direction > 0 && base[0] > 0.9) || (direction < 0 && base[0] < 0.1)
        ? -direction
        : direction;
    value[0] = Number(clamp(base[0] + way * step).toFixed(5));
    return { color: css(value), ink: contrastingInk(luminance(channels(value))) };
  };
  const hover = state(0.035),
    pressed = state(0.07);
  return {
    "--a": brand, "--ah": hover.color, "--aa": pressed.color,
    "--oa": accentInk(brand), "--oh": hover.ink, "--op": pressed.ink,
    "--at": adjusted(4.5), "--af": adjusted(3),
  };
}

/** Page-owned controls outside the widget shadow follow the same accent. */
export function setPageChatAccent(element: HTMLElement, value: WidgetAccent | undefined) {
  const light = widgetAccentTokens(value, "light");
  const dark = widgetAccentTokens(value, "dark");
  for (const key of Object.keys(light) as (keyof typeof light)[])
    if (value) element.style.setProperty(key, `light-dark(${light[key]},${dark[key]})`);
    else element.style.removeProperty(key);
}

function themeParents(doc: Document, parent?: HTMLElement) {
  const nodes: HTMLElement[] = [];
  for (
    let node: HTMLElement | null = parent ?? doc.body;
    node;
    node = node.parentElement
  )
    nodes.push(node);
  if (!nodes.includes(doc.documentElement)) nodes.push(doc.documentElement);
  return nodes;
}

/** Read only host theme signals on html/body and the color-scheme meta tag. */
export function hostWidgetTheme(
  doc = document,
  mediaDark = false,
  parent?: HTMLElement,
): WidgetTheme {
  const nodes = themeParents(doc, parent);
  const mode = (value: string) => {
    const dark = /dark/i.test(value),
      light = /light/i.test(value);
    return dark !== light
      ? dark
        ? ("dark" as const)
        : ("light" as const)
      : undefined;
  };
  for (const node of nodes) {
    const found = mode(getComputedStyle(node).colorScheme);
    if (found) return found;
  }
  const meta = mode(
    doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ??
      "",
  );
  if (meta) return meta;
  for (const node of nodes) {
    for (const attr of [
      "data-theme",
      "data-mode",
      "data-color-scheme",
      "data-color-mode",
      "class",
    ]) {
      const found = mode(node.getAttribute(attr) ?? "");
      if (found) return found;
    }
  }
  // Composite the body over html. The OS owns a transparent page canvas.
  let alpha = 0;
  const page = [0, 0, 0];
  for (const node of nodes) {
    const value = getComputedStyle(node).backgroundColor;
    let pixel: number[] | undefined;
    if (/^rgba?\(/.test(value)) {
      const parts = value.match(/[\d.]+/g)?.map(Number);
      if (parts) pixel = [...parts.slice(0, 3), parts[3] ?? 1];
    } else if (HEX.test(value)) {
      pixel = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
      pixel.push(1);
    } else if (value && value !== "transparent") {
      const context = doc.createElement("canvas").getContext("2d");
      if (context) {
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const bytes = context.getImageData(0, 0, 1, 1).data;
        pixel = [...bytes].slice(0, 3);
        pixel.push(bytes[3] / 255);
      }
    }
    if (pixel) {
      const weight = (1 - alpha) * pixel[3];
      page.forEach((_, i) => (page[i] += pixel![i] * weight));
      alpha += weight;
      if (alpha >= 0.999)
        return luminance(page.map((n) => linear(n / 255))) > 0.179
          ? "light"
          : "dark";
    }
  }
  return mediaDark ? "dark" : "light";
}

export function bindWidgetAppearance(
  host: HTMLElement,
  initial: WidgetAppearance = {},
  changed?: (display: WidgetDisplay) => void,
) {
  const root = host.shadowRoot;
  if (root && !root.querySelector("[data-appearance]")) {
    const style = root.ownerDocument.createElement("style");
    style.dataset.appearance = "";
    style.nonce = root.querySelector("style")?.nonce ?? "";
    style.textContent =
      ".loading-case{display:flex;align-items:center;justify-content:center;gap:12px;min-height:96px}.loading-case::before{content:'';width:24px;height:24px;border:2px solid var(--b2);border-top-color:var(--a);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.head>button[aria-label]{position:relative}.head>button[aria-label]:is(:hover,:focus-visible)::after{content:attr(aria-label);position:absolute;top:calc(100% + 6px);right:0;z-index:2;width:max-content;max-width:200px;padding:5px 8px;background:var(--t);color:var(--bg);font-size:12px;font-weight:500;line-height:1.4;pointer-events:none}";
    root.append(style);
  }
  let appearance = initial;
  const parent = host.parentElement ?? document.body;
  let previous = "";
  const media =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-color-scheme: dark)")
      : undefined;
  const apply = () => {
    const choice = host.dataset.visitorTheme || appearance.theme;
    const mode =
      choice === "light" || choice === "dark"
        ? choice
        : hostWidgetTheme(document, media?.matches, parent);
    host.dataset.theme = mode;
    host.dataset.position = appearance.position === "left" ? "left" : "right";
    const radius =
      appearance.radius === "square"
        ? [0, 0, 0, 0]
        : appearance.radius === "round"
          ? [28, 22, 16, 26]
          : [16, 14, 10, 14];
    ["--rp", "--rb", "--rc", "--rl"].forEach((key, i) =>
      host.style.setProperty(key, `${radius[i]}px`),
    );
    for (const [key, value] of Object.entries(widgetAccentTokens(appearance.accent, mode, appearance.colors?.[mode])))
      host.style.setProperty(key, value);
    const font = getComputedStyle(parent).fontFamily.slice(0, 300);
    if (font) host.style.fontFamily = font;
    const display = { theme: mode, font };
    const next = JSON.stringify(display);
    if (next !== previous) {
      previous = next;
      changed?.(display);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        apply();
      }, 32);
  };
  const observer = new MutationObserver(schedule);
  for (const node of new Set([...themeParents(document, parent), document.body]))
    if (node)
      observer.observe(node, {
        attributes: true,
        attributeFilter: [
          "class",
          "style",
          "data-theme",
          "data-mode",
          "data-color-scheme",
          "data-color-mode",
        ],
      });
  media?.addEventListener("change", schedule);
  host.addEventListener("visitor-theme", apply);
  apply();
  return {
    set(next: WidgetAppearance) {
      appearance = { ...appearance, ...next };
      apply();
    },
    destroy() {
      observer.disconnect();
      clearTimeout(timer);
      media?.removeEventListener("change", schedule);
      host.removeEventListener("visitor-theme", apply);
    },
  };
}

/** The launcher and the frame's box, matching the widget's own panel. */
export const FRAME_STYLE = `${WIDGET_FRAME_COLORS}:host{all:initial;--rl:14px;font-family:inherit;font-size:15px;font-weight:650;line-height:1.5}[hidden]{display:none!important}\
button{position:fixed;right:20px;bottom:36px;z-index:2147483000;display:flex;align-items:center;gap:9px;height:52px;padding:0 20px 0 16px;border:0;border-radius:var(--rl);background:var(--a);color:var(--oa);font:inherit;cursor:pointer;transition:transform .2s cubic-bezier(.3,1.6,.6,1)}button:hover{background:var(--ah);color:var(--oh);transform:translateY(-1px) scale(1.03)}button:active{background:var(--aa);color:var(--op)}button:focus-visible{outline:2px solid var(--af,var(--t));outline-offset:2px}svg{width:18px;height:18px}\
button[data-unread]::after{content:"";position:absolute;inset:8px 10px auto auto;padding:5px;border-radius:99px;background:var(--d);outline:2px solid var(--bg)}\
iframe,p{position:fixed;right:20px;bottom:100px;z-index:2147483001;margin:0}iframe{width:min(392px,calc(100vw - 32px));height:min(480px,calc(100dvh - 124px));border:0;border-radius:var(--rp,16px);color-scheme:normal;background:transparent;box-shadow:0 28px 80px var(--shc)}\
p{max-width:280px;padding:10px 12px;border-radius:12px;background:var(--bg);color:var(--t);font-size:13px;font-weight:400}\
:host([data-position=left]) iframe,:host([data-position=left]) button{right:auto;left:20px}\
@media(max-width:480px){iframe{inset:auto 8px 8px;width:auto;height:calc(100dvh - 16px)}button{right:16px;bottom:16px}:host([data-position=left]) iframe{left:8px;right:8px}:host([data-position=left]) button{left:16px}button[aria-expanded=true]{display:none}}\
@media(prefers-reduced-motion:reduce){button{transition:none}button:hover{transform:none}}`;
