import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = new URL("../src/widget/tokens.css", import.meta.url);
const colorTarget = new URL("../src/lib/support-widget-colors.ts", import.meta.url);
const themeTarget = new URL("../src/lib/support-widget-theme.ts", import.meta.url);

/** Only color values enter the widget; the host owns its font and layout. */
export function generateWidgetColors(check = false) {
  const css = readFileSync(source, "utf8");
  const theme = (name) => {
    const selector = name === "light" ? ':root,\\s*\\[data-theme="light"\\]' : '\\[data-theme="dark"\\]';
    const body = css.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1];
    if (!body) throw new Error(`Missing ${name} widget tokens.`);
    return new Map(
      [...body.matchAll(/--widget-([\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]),
    );
  };
  const value = (tokens, key) => {
    const found = tokens.get(key);
    if (!found) throw new Error(`Missing widget color token: ${key}.`);
    return found;
  };
  const mapping = {
    a: "accent", ah: "accent-hover", aa: "accent-active", oa: "on-accent",
    at: "accent-text", af: "accent-focus",
    bg: "bg", s: "surface", s2: "raised", b: "line", b2: "border-strong",
    t: "text", m: "muted", f: "muted", d: "danger-text", db: "danger-soft",
  };
  const header = [
    "// Generated from src/widget/tokens.css. Do not edit.",
    "// Color adapter only. The widget inherits the host font.",
  ];
  const colors = [...header];
  const themes = [...header];
  const frames = {};
  for (const name of ["light", "dark"]) {
    const tokens = theme(name);
    const declarations = (keys) => keys.map((key) => `--${key}:${value(tokens, mapping[key]).replace(/^#(.)\1(.)\2(.)\3$/, "#$1$2$3")}`).join(";");
    const prefix = `WIDGET_${name.toUpperCase()}`;
    const shadow = value(tokens, "shadow-lg")
      .slice(value(tokens, "shadow-lg").indexOf("rgb("))
      .replace("var(--widget-shadow-color)", value(tokens, "shadow-color"))
      .replace(/\s*\/\s*/, "/")
      .replace(/0\.(\d+)/, ".$1");
    colors.push(
      `export const ${prefix}_COLORS = ${JSON.stringify(`${declarations(Object.keys(mapping))};--shc:${shadow};color-scheme:${name}`)};`,
    );
    themes.push(
      `export const ${prefix}_BASE = ${JSON.stringify(`${declarations(["bg", "t"])};color-scheme:${name}`)};`,
      `export const ${prefix}_ACCENT = ${JSON.stringify(value(tokens, "accent"))};`,
      `export const ${prefix}_SURFACES = ${JSON.stringify(["bg", "surface", "raised"].map(key => value(tokens, key)))};`,
    );
    frames[name] = `${declarations(["a", "oa", "bg", "t", "d"])};--shc:${shadow}`;
  }
  themes.push(`export const WIDGET_FRAME_COLORS = ${JSON.stringify(`:host{${frames.dark}}:host([data-theme=light]){${frames.light}}@media(prefers-color-scheme:light){:host([data-theme=auto]){${frames.light}}}`)};`);
  for (const [target, output] of [[colorTarget, colors], [themeTarget, themes]]) {
    const generated = `${output.join("\n")}\n`;
    if (check) {
      if (readFileSync(target, "utf8") !== generated)
        throw new Error("Widget colors are stale. Run node apps/web/scripts/build-support-widget.mjs.");
    } else writeFileSync(target, generated);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  generateWidgetColors(process.argv.includes("--check"));
