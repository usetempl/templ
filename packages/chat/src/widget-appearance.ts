/** Public display settings. These fields grant no account or wallet access. */
export type WidgetAppearance = {
  theme?: "auto" | "light" | "dark";
  accent?: string | { light: string; dark: string };
  radius?: "square" | "soft" | "round";
  position?: "left" | "right";
  logo?: string;
  font?: "inherit" | "system" | "sans" | "serif" | "mono";
  colors?: Partial<
    Record<
      "light" | "dark",
      Partial<
        Record<"background" | "surface" | "text" | "muted" | "border", string>
      >
    >
  >;
  headerNotice?: { enabled: boolean; text: string };
};

const HEX = /^#[0-9a-f]{6}$/i;
function object(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError("Check the widget settings.");
  return value as Record<string, unknown>;
}
function hex(value: unknown) {
  if (typeof value !== "string" || !HEX.test(value))
    throw new TypeError("Enter a six-digit hex color, such as #2563eb.");
  return value.toLowerCase();
}

/** Validates the complete saved value. Unknown fields and executable URLs are refused. */
export function checkedWidgetAppearance(
  value: unknown,
): WidgetAppearance | null {
  if (value === null) return null;
  const input = object(value, [
    "theme",
    "accent",
    "radius",
    "position",
    "logo",
    "font",
    "colors",
    "headerNotice",
  ]);
  const result: WidgetAppearance = {};
  for (const [key, allowed] of Object.entries({
    theme: ["auto", "light", "dark"],
    radius: ["square", "soft", "round"],
    position: ["left", "right"],
    font: ["inherit", "system", "sans", "serif", "mono"],
  })) {
    if (input[key] === undefined) continue;
    if (
      typeof input[key] !== "string" ||
      !allowed.includes(input[key] as string)
    )
      throw new TypeError("Choose a valid widget appearance option.");
    Object.assign(result, { [key]: input[key] });
  }
  if (input.accent !== undefined) {
    if (typeof input.accent === "string") result.accent = hex(input.accent);
    else {
      const pair = object(input.accent, ["light", "dark"]);
      result.accent = { light: hex(pair.light), dark: hex(pair.dark) };
    }
  }
  if (input.logo !== undefined && input.logo !== "") {
    if (
      typeof input.logo !== "string" ||
      input.logo.length > 2048 ||
      /[\s\\]/.test(input.logo)
    )
      throw new TypeError("Use a public image URL or a path on your site.");
    let url: URL;
    try {
      url = new URL(input.logo, "https://widget.example");
    } catch {
      throw new TypeError("Use a public image URL or a path on your site.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      input.logo.startsWith("//") ||
      (!input.logo.startsWith("/") && !input.logo.startsWith("https://"))
    )
      throw new TypeError("Use an HTTPS image URL or a path starting with /.");
    result.logo = input.logo;
  }
  if (input.colors !== undefined) {
    const modes = object(input.colors, ["light", "dark"]);
    const colors: NonNullable<WidgetAppearance["colors"]> = {};
    for (const mode of ["light", "dark"] as const) {
      if (modes[mode] === undefined) continue;
      const palette = object(modes[mode], [
        "background",
        "surface",
        "text",
        "muted",
        "border",
      ]);
      const parsed: NonNullable<
        NonNullable<WidgetAppearance["colors"]>["light"]
      > = {};
      for (const key of [
        "background",
        "surface",
        "text",
        "muted",
        "border",
      ] as const)
        if (palette[key] !== undefined) parsed[key] = hex(palette[key]);
      colors[mode] = parsed;
    }
    result.colors = colors;
  }
  if (input.headerNotice !== undefined) {
    const notice = object(input.headerNotice, ["enabled", "text"]);
    if (
      typeof notice.enabled !== "boolean" ||
      typeof notice.text !== "string" ||
      notice.text.length > 280 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(notice.text)
    )
      throw new TypeError("Write a header notice of up to 280 characters.");
    const text = notice.text.trim();
    if (notice.enabled && !text)
      throw new TypeError("Write the header notice before turning it on.");
    result.headerNotice = { enabled: notice.enabled, text };
  }
  return result;
}

/** Disabled draft text stays in the manager's settings. */
export function publicWidgetAppearance(
  value: WidgetAppearance | null,
  origin?: string,
) {
  const shown =
    value?.headerNotice && !value.headerNotice.enabled
      ? { ...value, headerNotice: { enabled: false, text: "" } }
      : value;
  return shown?.logo?.startsWith("/") && origin
    ? { ...shown, logo: new URL(shown.logo, origin).href }
    : shown;
}
