import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { APP_THEME_KEY, APP_THEME_SCRIPT } from "@/lib/app-theme";
import { simulate } from "@templ/chat/simulation.test.helpers";

const route = vi.hoisted(() => ({ pathname: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
import { AppTheme, AppThemeSwitch } from "@/components/app-theme";

const html = document.documentElement;
const control = () => screen.getByRole("button", { name: "Dark mode" });
const saved = () => localStorage.getItem(APP_THEME_KEY);
function open(path: string) {
  history.replaceState(null, "", path);
  route.pathname = location.pathname;
}
/** A full page load: a new document, the layout's first-paint script, then the app. */
function load(path: string, page: ReactElement) {
  cleanup();
  delete html.dataset.appearance;
  delete html.dataset.theme;
  open(path);
  new Function(APP_THEME_SCRIPT)();
  const painted = html.dataset.theme;
  return { painted, view: render(page) };
}
const onboarding = (
  <>
    <AppTheme />
    <AppThemeSwitch />
  </>
);

beforeEach(() => {
  // The visitor's system is dark and no choice is saved.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete html.dataset.appearance;
  delete html.dataset.theme;
  history.replaceState(null, "", "/");
});

simulate(
  "sim:browser a dark-system visitor starts onboarding light, chooses a theme and keeps it across pages and reloads",
  (draw) => {
    const create = draw.pick(["/create", "/create?manual=1"]);
    const elsewhere = draw.pick(["/inbox", "/billing", "/settings/account"]);

    // Onboarding starts light, and the system theme applies everywhere else.
    const first = load(create, <AppTheme />);
    expect(first.painted).toBe("light");
    expect(html.dataset.theme).toBe("light");
    expect(html.dataset.appearance).toBe("system");
    open(elsewhere);
    first.view.rerender(<AppTheme />);
    expect(html.dataset.theme).toBe("dark");
    expect(load(elsewhere, <AppTheme />).painted).toBe("dark");

    // The page switch saves each choice.
    expect(load(create, onboarding).painted).toBe("light");
    expect(control().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(control());
    expect(html.dataset.theme).toBe("dark");
    expect(saved()).toBe("dark");
    expect(control().getAttribute("aria-pressed")).toBe("true");

    // The saved dark choice outlives a reload, in onboarding too.
    expect(load(create, onboarding).painted).toBe("dark");
    expect(html.dataset.theme).toBe("dark");
    expect(html.dataset.appearance).toBe("dark");
    expect(control().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(control());
    expect(html.dataset.theme).toBe("light");
    expect(saved()).toBe("light");
    expect(control().getAttribute("aria-pressed")).toBe("false");

    // A saved light choice now overrides the dark system on the other pages.
    expect(load(elsewhere, <AppTheme />).painted).toBe("light");
    expect(html.dataset.appearance).toBe("light");
  },
);
