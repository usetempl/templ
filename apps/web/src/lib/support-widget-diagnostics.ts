import type { SupportDiagnostics } from "@templ/chat/support-app-context";
import type { CardHost } from "./support-widget";
import type { SupportContextInput } from "@templ/chat/support";
import { APP_LABELS, appValue } from "./support-widget-app";

/** Local facts only. No network, storage, permissions or high-entropy UA hints.
 * Values are reported by the browser, not independently verified. */
export function diagnostics(): SupportDiagnostics {
  const out: SupportDiagnostics = {};
  const attempt = (read: () => void) => {
    try {
      read();
    } catch {
      /* Restricted browsers omit unavailable facts. */
    }
  };
  attempt(() => {
    const ua = navigator.userAgent;
    for (const [name, pattern] of [
      ["Edge", /Edg(?:A|iOS)?\/([\d.]+)/],
      ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
      ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
      ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
      ["Safari", /Version\/([\d.]+).*Safari\//],
    ] as const) {
      const version = pattern.exec(ua)?.[1];
      if (version) {
        out.browser = `${name} ${version}`.slice(0, 60);
        break;
      }
    }
    out.operatingSystem = /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /CrOS/.test(ua)
          ? "Chrome OS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Macintosh|Mac OS X/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : undefined;
  });
  const size = (width: number, height: number) =>
    [width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 32768)
      ? { width, height }
      : undefined;
  attempt(() => {
    out.viewport = size(window.innerWidth, window.innerHeight);
  });
  attempt(() => {
    out.screen = size(screen.width, screen.height);
  });
  attempt(() => {
    if (
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(navigator.language) &&
      navigator.language.length <= 60
    )
      out.language = navigator.language;
  });
  attempt(() => {
    out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  });
  attempt(() => {
    if (typeof navigator.onLine !== "boolean") return;
    const hint = (
      navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      }
    ).connection;
    out.connection = {
      online: navigator.onLine,
      ...(hint?.effectiveType &&
      ["slow-2g", "2g", "3g", "4g"].includes(hint.effectiveType)
        ? {
            effectiveType: hint.effectiveType as "slow-2g" | "2g" | "3g" | "4g",
          }
        : {}),
      ...(typeof hint?.saveData === "boolean"
        ? { saveData: hint.saveData }
        : {}),
    };
  });
  return Object.fromEntries(
    Object.entries(out).filter(([, value]) => value !== undefined),
  );
}

/** An ordinary message collects local facts only after the member opens this
 * picker. Every row starts unchecked; pending sends keep their exact values. */
export function picker(widget: CardHost) {
  const { el } = widget;
  const attach = widget.tx.parentElement;
  const button = el("button", "Browser details", "quiet");
  button.type = "button";
  button.hidden = true;
  button.setAttribute("aria-expanded", "false");
  const section = el("section", undefined, "card diagnostic-card");
  section.setAttribute("aria-label", "Browser details");
  section.hidden = true;
  const id = `templ-diagnostics-${Math.random().toString(36).slice(2)}`;
  section.id = id;
  button.setAttribute("aria-controls", id);
  widget.card.before(section);
  attach?.append(button);
  let available = true;
  let expanded = false;
  let revision = 0;
  let rows: {
    field: keyof SupportDiagnostics;
    value: SupportDiagnostics[keyof SupportDiagnostics];
    checked: boolean;
    pending?: boolean;
  }[] = [];
  const permitted = async () => {
    const allowed = widget.policy?.()?.diagnostics;
    button.hidden = !allowed;
    return allowed === true;
  };
  if (attach) void permitted();
  function render() {
    section.hidden = !expanded || !available;
    button.setAttribute("aria-expanded", String(!section.hidden));
    section.replaceChildren(
      el("b", "Browser details"),
      el(
        "p",
        "Choose what to send with your next message. All details are optional.",
        "muted",
      ),
    );
    for (const row of rows) {
      const label = el("label", undefined, "row");
      const value = appValue(row.field, { [row.field]: row.value });
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = row.checked;
      tick.disabled = !!row.pending;
      tick.setAttribute(
        "aria-label",
        `Share ${APP_LABELS[row.field]}: ${value}`,
      );
      tick.addEventListener("change", () => {
        row.checked = tick.checked;
      });
      label.append(tick, el("b", APP_LABELS[row.field]), el("span", value));
      section.append(label);
    }
    if (!rows.length)
      section.append(el("p", "No browser details are available.", "muted"));
    const clear = el("button", "Clear all", "quiet");
    clear.type = "button";
    clear.setAttribute("aria-label", "Clear all browser details");
    clear.addEventListener("click", () => {
      for (const row of rows) if (!row.pending) row.checked = false;
      section
        .querySelectorAll<HTMLInputElement>("input:not(:disabled)")
        .forEach((tick) => {
          tick.checked = false;
        });
    });
    section.append(clear);
  }
  button.addEventListener("click", () => {
    const current = revision;
    void permitted().then((allowed) => {
      if (current !== revision) return;
      expanded = allowed && !expanded;
      if (expanded && !rows.length)
        rows = Object.entries(diagnostics()).map(([field, value]) => ({
          field: field as keyof SupportDiagnostics,
          value,
          checked: false,
        }));
      render();
      if (expanded) section.querySelector<HTMLInputElement>("input")?.focus();
    });
  });
  return {
    available(next: boolean) {
      available = next;
      if (attach) void permitted();
      render();
    },
    clear() {
      revision++;
      rows = [];
      expanded = false;
      render();
    },
    destroy() {
      revision++;
      section.remove();
      button.remove();
    },
    ticked(): SupportContextInput | undefined {
      if (!available) return;
      const picked = rows.filter((row) => row.checked && !row.pending);
      if (!picked.length) return;
      for (const row of picked) row.pending = true;
      render();
      return {
        app: Object.fromEntries(picked.map((row) => [row.field, row.value])),
      };
    },
    confirmed(context?: SupportContextInput) {
      if (!context?.app) return;
      rows = rows.filter((row) => !row.pending);
      expanded = rows.length > 0;
      render();
    },
    cancelled(context?: SupportContextInput) {
      if (!context?.app) return;
      for (const row of rows) row.pending = false;
      render();
    },
  };
}

export async function allowed(
  read?: () => Promise<{ diagnostics?: boolean }>,
  cached?: CardHost["policy"],
) {
  return (
    (read ? await read().catch(() => undefined) : cached?.())?.diagnostics ===
    true
  );
}
