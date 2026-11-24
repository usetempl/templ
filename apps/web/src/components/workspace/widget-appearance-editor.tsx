"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { WidgetAppearance } from "@templ/chat/widget-appearance";
import { SupportWidgetDemo } from "@/components/support-widget-demo";
import {
  WIDGET_DEFAULT_ACCENT,
  widgetContrast,
  widgetSurfaces,
} from "@/lib/support-widget-appearance";
import {
  WIDGET_LIGHT_COLORS,
  WIDGET_DARK_COLORS,
} from "@/lib/support-widget-colors";
import styles from "./workspace-widget.module.css";

const SWATCHES = [
  ["Rose", "#e11d48"],
  ["Red", "#dc2626"],
  ["Orange", "#ea580c"],
  ["Amber", "#d97706"],
  ["Yellow", "#eab308"],
  ["Lime", "#84cc16"],
  ["Green", "#16a34a"],
  ["Emerald", "#059669"],
  ["Teal", "#0d9488"],
  ["Cyan", "#0891b2"],
  ["Sky", "#0284c7"],
  ["Blue", "#2563eb"],
  ["Indigo", "#4f46e5"],
  ["Violet", "#7c3aed"],
  ["Fuchsia", "#c026d3"],
  ["Pink", "#db2777"],
  ["White", "#ffffff"],
  ["Black", "#111111"],
];
const FIELDS = [
  ["background", "Background", "bg"],
  ["surface", "Surface", "s"],
  ["text", "Text", "t"],
  ["muted", "Secondary text", "m"],
  ["border", "Border", "b"],
] as const;
const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
const defaultColor = (mode: "light" | "dark", key: string) =>
  (mode === "light" ? WIDGET_LIGHT_COLORS : WIDGET_DARK_COLORS).match(
    new RegExp(`--${key}:(#[0-9a-f]{6})`),
  )?.[1] ?? "#808080";

function lowButtonContrast(appearance: WidgetAppearance) {
  return (["light", "dark"] as const).flatMap((mode) => {
    const fill = typeof appearance.accent === "string" ? appearance.accent : appearance.accent?.[mode] ?? WIDGET_DEFAULT_ACCENT[mode];
    if (!isHex(fill)) return [];
    const surfaces = widgetSurfaces(mode, appearance.colors?.[mode]);
    const least = Math.min(...surfaces.map((surface) => widgetContrast(fill, surface)));
    return least < 3 ? [{ mode, ratio: (Math.floor(least * 10) / 10).toFixed(1) }] : [];
  });
}
const subscribeDark = (changed: () => void) => {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", changed);
  return () => media?.removeEventListener("change", changed);
};
const readDark = () =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const invalid = !isHex(value);
  return (
    <div className={styles.colorField}>
      <label htmlFor={id}>{label}</label>
      <input
        type="color"
        aria-label={`${label} color`}
        value={invalid ? "#808080" : value}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        className={styles.input}
        id={id}
        aria-label={`${label} hex`}
        value={value}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value.trim())}
      />
      {invalid && <span className={styles.error}>Use #rrggbb.</span>}
    </div>
  );
}

/** Workspace display settings with one preview using the installed widget renderer. */
export function WidgetAppearanceEditor({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: WidgetAppearance;
  onChange(value: WidgetAppearance): void;
  label: string;
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<"auto" | "light" | "dark">("auto");
  const dark = useSyncExternalStore(subscribeDark, readDark, () => false);
  const mode = preview === "auto" ? (dark ? "dark" : "light") : preview;
  const imageMode = value.logo !== undefined;
  const [previewLogo, setPreviewLogo] = useState(value.logo);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewLogo(value.logo), 400);
    return () => clearTimeout(timer);
  }, [value.logo]);
  const patch = (next: Partial<WidgetAppearance>) =>
    onChange({ ...value, ...next });
  const pair = typeof value.accent === "object" ? value.accent : undefined;
  const accent = typeof value.accent === "string" ? value.accent : pair?.light ?? WIDGET_DEFAULT_ACCENT.light;
  const setAccent = (color: string) => patch({ accent: pair ? { ...pair, light: color } : color });
  const palette = value.colors?.[mode] ?? {};
  const notice = value.headerNotice ?? { enabled: false, text: "" };
  const background = palette.background ?? defaultColor(mode, "bg");
  const foreground = palette.text ?? defaultColor(mode, "t");
  const lowContrast =
    isHex(background) &&
    isHex(foreground) &&
    widgetContrast(background, foreground) < 4.5;
  const safePreviewLogo =
    previewLogo &&
    (/^https:\/\//.test(previewLogo) || /^\/(?!\/)/.test(previewLogo))
      ? previewLogo
      : undefined;
  return (
    <div className={styles.editor}>
      <fieldset className={styles.controls} disabled={disabled}>
        <legend className={styles.srOnly}>Widget appearance</legend>
        <section className={styles.section} aria-label="Chat accent color">
          <h3>Chat accent color</h3>
          <p>Pick one color for the chat button and Send. Menu actions, links and visitor messages use shades of it in both themes.</p>
          <ColorField label="Button color" value={accent} onChange={setAccent} />
          <div
            className={styles.swatches}
            role="group"
            aria-label="Button color presets"
          >
            {SWATCHES.map(([name, color]) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                title={name}
                aria-pressed={accent.toLowerCase() === color}
                style={{ background: color }}
                onClick={() => setAccent(color)}
              />
            ))}
          </div>
          <label>
            <input type="checkbox" checked={!!pair}
              onChange={(event) => patch({ accent: event.target.checked
                ? { light: accent, dark: typeof value.accent === "string" ? value.accent : WIDGET_DEFAULT_ACCENT.dark }
                : accent })} />
            Use a different color in dark mode
          </label>
          {pair && <ColorField label="Dark mode button color" value={pair.dark}
            onChange={(dark) => patch({ accent: { ...pair, dark } })} />}
          {lowButtonContrast(value).map(({ mode, ratio }) => (
            <p key={mode} className={styles.contrastWarning} role="status">
              <strong>Low contrast in {mode} mode.</strong>{" "}
              The button can blend into the chat surface ({ratio}:1). Aim for 3:1.
            </p>
          ))}
        </section>
        <section className={styles.section} aria-label="Widget colors">
          <h3>Chat colors <span>{mode === "light" ? "Light" : "Dark"}</span></h3>
          <p>These colors are optional. Switch the preview to edit a theme.</p>
          {FIELDS.map(([key, name, token]) => (
            <ColorField
              key={key}
              label={name}
              value={palette[key] ?? defaultColor(mode, token)}
              onChange={(color) =>
                patch({
                  colors: {
                    ...value.colors,
                    [mode]: { ...palette, [key]: color },
                  },
                })
              }
            />
          ))}
          {lowContrast && (
            <p className={styles.hint}>
              Text is adjusted to stay readable on the background.
            </p>
          )}
        </section>
        <section className={styles.section} aria-label="Widget layout">
          <h3>Type and layout</h3>
          <label>
            Font
            <select
              aria-label="Font"
              className={styles.input}
              value={value.font ?? "inherit"}
              onChange={(event) =>
                patch({ font: event.target.value as WidgetAppearance["font"] })
              }
            >
              <option value="inherit">App font</option>
              <option value="system">System</option>
              <option value="sans">Arial</option>
              <option value="serif">Georgia</option>
              <option value="mono">Monospace</option>
            </select>
          </label>
          <div className={styles.row}>
            <label>
              Theme
              <select
                aria-label="Theme"
                className={styles.input}
                value={value.theme ?? "auto"}
                onChange={(event) =>
                  patch({
                    theme: event.target.value as WidgetAppearance["theme"],
                  })
                }
              >
                <option value="auto">Match app</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label>
              Corners
              <select
                aria-label="Corners"
                className={styles.input}
                value={value.radius ?? "soft"}
                onChange={(event) =>
                  patch({
                    radius: event.target.value as WidgetAppearance["radius"],
                  })
                }
              >
                <option value="square">Square</option>
                <option value="soft">Soft</option>
                <option value="round">Round</option>
              </select>
            </label>
          </div>
          <label>
            Launcher side
            <select
              aria-label="Launcher side"
              className={styles.input}
              value={value.position ?? "right"}
              onChange={(event) =>
                patch({
                  position: event.target.value as WidgetAppearance["position"],
                })
              }
            >
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </label>
        </section>
        <section className={styles.section} aria-label="Widget icon">
          <h3>Icon</h3>
          <div
            className={styles.choices}
            role="group"
            aria-label="Widget icon type"
          >
            <button
              className={styles.choice}
              type="button"
              aria-pressed={!imageMode}
              onClick={() => {
                patch({ logo: undefined });
              }}
            >
              Chat icon
            </button>
            <button
              className={styles.choice}
              type="button"
              aria-pressed={imageMode}
              onClick={() => patch({ logo: value.logo ?? "" })}
            >
              Your image
            </button>
          </div>
          {imageMode && (
            <label>
              Image URL
              <input
                aria-label="Image URL"
                className={styles.input}
                type="text"
                value={value.logo ?? ""}
                maxLength={2048}
                placeholder="https://yourapp.com/logo.svg"
                onChange={(event) => patch({ logo: event.target.value })}
              />
              <span className={styles.hint}>Use a public square image.</span>
            </label>
          )}
          <p className={styles.hint}>
            For custom styles, see the{" "}
            <a
              href="https://docs.usetempl.com/developers/widget#css-overrides"
              target="_blank"
              rel="noreferrer"
            >
              CSS guide
            </a>
            .
          </p>
        </section>
        <section className={styles.section} aria-label="Header notice">
          <h3>Header notice</h3>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={notice.enabled}
              onChange={(event) =>
                patch({
                  headerNotice: { ...notice, enabled: event.target.checked },
                })
              }
            />
            Show a notice to everyone
          </label>
          {notice.enabled && (
            <label>
              Notice text
              <textarea
                aria-label="Notice text"
                className={styles.input}
                rows={3}
                maxLength={280}
                value={notice.text}
                placeholder="Write a notice for your users."
                onChange={(event) =>
                  patch({
                    headerNotice: { enabled: true, text: event.target.value },
                  })
                }
              />
              <span className={styles.hint}>{notice.text.length}/280</span>
            </label>
          )}
        </section>
      </fieldset>
      <div className={styles.preview}>
        <div className={styles.previewHeader}>
          <strong>Preview</strong>
          <div
            className={styles.choices}
            role="group"
            aria-label="Preview theme"
          >
            {(["auto", "light", "dark"] as const).map((theme) => (
              <button
                className={styles.choice}
                key={theme}
                type="button"
                aria-pressed={preview === theme}
                onClick={() => setPreview(theme)}
              >
                {theme === "auto"
                  ? "System"
                  : theme === "light"
                    ? "Light"
                    : "Dark"}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.previewHost} data-theme={mode}>
          <SupportWidgetDemo
            previewLauncher
            className={styles.previewFrame}
            label={label}
            appearance={{
              accent: WIDGET_DEFAULT_ACCENT,
              radius: "soft",
              position: "right",
              font: "inherit",
              colors: undefined,
              headerNotice: { enabled: false, text: "" },
              ...value,
              logo: safePreviewLogo,
              theme: mode,
            }}
          />
        </div>
      </div>
    </div>
  );
}
