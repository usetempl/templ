import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_THEME_KEY, APP_THEME_SCRIPT } from "@/lib/app-theme";

const route = vi.hoisted(() => ({ pathname: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
import { AppTheme, AppThemeSwitch } from "./app-theme";

const html = document.documentElement;
// The layout runs this script before the page first paints.
const firstPaint = () => new Function(APP_THEME_SCRIPT)();
function open(path: string) {
  history.replaceState(null, "", path);
  route.pathname = location.pathname;
}
const control = () => screen.getByRole("button", { name: "Dark mode" });

beforeEach(() => {
  // The visitor's system is dark and no choice is saved.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  open("/create?manual=1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete html.dataset.appearance;
  delete html.dataset.theme;
  history.replaceState(null, "", "/");
});

it("starts onboarding light on a dark system and keeps the system theme on other pages", () => {
  firstPaint();
  expect(html.dataset.theme).toBe("light");
  const view = render(<AppTheme />);
  expect(html.dataset.theme).toBe("light");
  expect(html.dataset.appearance).toBe("system");

  open("/inbox");
  view.rerender(<AppTheme />);
  expect(html.dataset.theme).toBe("dark");
  delete html.dataset.theme;
  firstPaint();
  expect(html.dataset.theme).toBe("dark");
});

it("keeps a saved dark choice in onboarding", () => {
  localStorage.setItem(APP_THEME_KEY, "dark");
  firstPaint();
  render(
    <>
      <AppTheme />
      <AppThemeSwitch />
    </>,
  );
  expect(html.dataset.theme).toBe("dark");
  expect(control().getAttribute("aria-pressed")).toBe("true");
});

it("saves the theme chosen with the page switch", () => {
  firstPaint();
  render(<AppThemeSwitch />);
  expect(control().getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(control());
  expect(html.dataset.theme).toBe("dark");
  expect(localStorage.getItem(APP_THEME_KEY)).toBe("dark");
  expect(control().getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(control());
  expect(html.dataset.theme).toBe("light");
  expect(localStorage.getItem(APP_THEME_KEY)).toBe("light");
  expect(control().getAttribute("aria-pressed")).toBe("false");
});
