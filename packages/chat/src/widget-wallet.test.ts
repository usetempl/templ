import { describe, expect, it } from "vitest";
import {
  isLoopbackOrigin,
  WIDGET_REMEMBER_CREDENTIAL,
  WIDGET_REMEMBER_DAYS,
  WIDGET_REMEMBER_STATEMENT,
  WIDGET_SIGN_IN_STATEMENT,
} from "./widget-wallet";
import type { ChatEvent } from "./events";

describe("remembered widget sign-in", () => {
  it("extends today's statement word for word with the 30-day line", () => {
    expect(WIDGET_REMEMBER_DAYS).toBe(30);
    expect(WIDGET_REMEMBER_STATEMENT.startsWith(`${WIDGET_SIGN_IN_STATEMENT} `)).toBe(true);
    expect(WIDGET_REMEMBER_STATEMENT).toContain(
      "You'll stay signed in on this site for 30 days, or until you sign out.",
    );
    expect(WIDGET_REMEMBER_STATEMENT).not.toMatch(/\n/);
  });
  it("reads a key as a family id and a secret", () => {
    expect(WIDGET_REMEMBER_CREDENTIAL.test(`${"a".repeat(32)}.${"b".repeat(64)}`)).toBe(true);
    for (const value of [
      `${"a".repeat(31)}.${"b".repeat(64)}`,
      `${"A".repeat(32)}.${"b".repeat(64)}`,
      `${"a".repeat(32)}${"b".repeat(64)}`,
    ])
      expect(WIDGET_REMEMBER_CREDENTIAL.test(value), value).toBe(false);
  });
});

describe("development origins", () => {
  it("names only localhost, 127.0.0.1 and [::1], exactly", () => {
    for (const value of [
      "http://localhost:5173",
      "http://localhost",
      "https://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
    ])
      expect(isLoopbackOrigin(value), value).toBe(true);
    for (const value of [
      "http://localhost.evil.example",
      "http://localhost:5173/",
      "http://app.example",
      "http://127.0.0.2",
      "ftp://localhost",
      null,
    ])
      expect(isLoopbackOrigin(value), String(value)).toBe(false);
  });
});

describe("team-only events", () => {
  it("accepts only the team audience", () => {
    const event: ChatEvent = {
      id: "1",
      type: "conversation.updated",
      at: "2026-09-28T00:00:00Z",
      audience: "team",
    };
    expect(event.audience).toBe("team");
    // @ts-expect-error Only "team" names an audience.
    const wrong: ChatEvent = { ...event, audience: "member" };
    expect(wrong).toBeTruthy();
  });
});
