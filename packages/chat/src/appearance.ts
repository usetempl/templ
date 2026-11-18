export const DEFAULT_ACCENT = "#76a1ff";
/**
 * Each preset pairs an action color with a highlight for focus and selection.
 * Workspace records store only the primary color.
 */
export const ACCENT_PRESETS = [
  { name: "Cobalt", primary: DEFAULT_ACCENT, highlight: "#c5d8fd" },
  { name: "Sky", primary: "#44d7ff", highlight: "#8cffe1" },
  { name: "Violet", primary: "#aa9cff", highlight: "#d2c2ff" },
  { name: "Pink", primary: "#ff83c7", highlight: "#ffb3d9" },
  { name: "Orange", primary: "#ffb45c", highlight: "#ffd27a" },
  { name: "Yellow", primary: "#ffe366", highlight: "#fff19c" },
  { name: "Coral", primary: "#ff8585", highlight: "#ffb39c" },
] as const;
export const COMMUNITY_ACCENTS: readonly string[] = ACCENT_PRESETS.map(
  (preset) => preset.primary,
);
export type CommunityPalette = {
  primary: string;
  highlight: string;
  onPrimary: "#131313" | "#ffffff";
  onHighlight: "#131313" | "#ffffff";
  subtleBackground: string;
  subtleBorder: string;
  primaryRgb: string;
  highlightRgb: string;
};
/** Dark background beneath a workspace's accent tints. */
const SUBTLE_BASE = "#131313";
/** Minimum per-channel distance (0-255) for a highlight to read as its own color. */
const DISTINCT_CHANNEL_DISTANCE = 24;
function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) =>
    Number.parseInt(hex.slice(index, index + 2), 16),
  ) as [number, number, number];
}
function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}
function toHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) =>
      clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}
function luminance(hex: string) {
  const parts = channels(hex)
    .map((value) => value / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}
/** Community accents remain readable as text on the app's darkest card surface. */
export function validAccent(value: unknown): value is string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))
    return false;
  return (luminance(value) + 0.05) / (luminance("#282828") + 0.05) >= 4.5;
}
export function communityAccent(value?: unknown): string {
  if (value === undefined || value === null) return DEFAULT_ACCENT;
  if (!validAccent(value))
    throw new Error("Choose a brighter color so text stays readable.");
  return value.toLowerCase();
}
export function accentForeground(value: string) {
  const light = luminance(communityAccent(value));
  return (light + 0.05) / (luminance(SUBTLE_BASE) + 0.05) >=
    1.05 / (light + 0.05)
    ? "#131313"
    : "#ffffff";
}
function toHsl(hex: string): [number, number, number] {
  const [red, green, blue] = channels(hex).map((value) => value / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const light = (max + min) / 2;
  if (max === min) return [0, 0, light * 100];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  let hue: number;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return [hue, saturation * 100, light * 100];
}
function fromHsl(hue: number, saturation: number, light: number) {
  const s = saturation / 100;
  const l = light / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return toHex((red + m) * 255, (green + m) * 255, (blue + m) * 255);
}
function distinct(a: string, b: string) {
  const left = channels(a);
  const right = channels(b);
  return left.some(
    (value, index) =>
      Math.abs(value - right[index]) >= DISTINCT_CHANNEL_DISTANCE,
  );
}
function usableHighlight(candidate: string, primary: string) {
  return (
    candidate !== primary &&
    validAccent(candidate) &&
    distinct(candidate, primary)
  );
}
function nearestPresetHighlight(primary: string) {
  const origin = channels(primary);
  const ranked = [...ACCENT_PRESETS]
    .map((preset) => ({
      highlight: preset.highlight,
      distance: channels(preset.primary).reduce(
        (sum, value, index) => sum + (value - origin[index]) ** 2,
        0,
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
  return (
    ranked.find((entry) => usableHighlight(entry.highlight, primary)) ??
    ranked.find((entry) => entry.highlight !== primary) ??
    ranked[0]
  ).highlight;
}
/**
 * Companion highlight for a custom primary. Pure and deterministic: greens,
 * cyans and blues turn toward yellow-green and lighten; every other hue
 * lightens and saturates. The result never equals the primary, stays readable
 * on the darkest card surface and differs on at least one channel.
 */
export function deriveHighlight(primaryHex: string): string {
  const primary = communityAccent(primaryHex);
  let [hue, saturation, light] = toHsl(primary);
  if (hue >= 60 && hue <= 200) {
    hue = (hue - 25 + 360) % 360;
    light += 10;
  } else {
    light += 14;
    saturation += 10;
  }
  saturation = clamp(saturation, 0, 100);
  for (let step = 0; step <= 3; step += 1) {
    const candidate = fromHsl(hue, saturation, clamp(light + 6 * step, 0, 100));
    if (usableHighlight(candidate, primary)) return candidate;
  }
  return nearestPresetHighlight(primary);
}
function mixOverBase(primary: string, weight: number) {
  const base = channels(SUBTLE_BASE);
  const [red, green, blue] = channels(primary).map(
    (value, index) => base[index] * (1 - weight) + value * weight,
  );
  return toHex(red, green, blue);
}
function rgbTriplet(hex: string) {
  return channels(hex).join(" ");
}
/**
 * Full palette for a validated accent. Presets use their curated highlight;
 * custom colors derive one. Throws the same message as `communityAccent()` for
 * anything that is not a readable `#rrggbb` color.
 */
export function resolvePalette(accent?: unknown): CommunityPalette {
  const primary = communityAccent(accent);
  const preset = ACCENT_PRESETS.find((entry) => entry.primary === primary);
  const highlight = preset ? preset.highlight : deriveHighlight(primary);
  return {
    primary,
    highlight,
    onPrimary: accentForeground(primary),
    onHighlight: accentForeground(highlight),
    subtleBackground:
      primary === DEFAULT_ACCENT ? "#0d1934" : mixOverBase(primary, 0.1),
    subtleBorder:
      primary === DEFAULT_ACCENT ? "#30477a" : mixOverBase(primary, 0.28),
    primaryRgb: rgbTriplet(primary),
    highlightRgb: rgbTriplet(highlight),
  };
}
