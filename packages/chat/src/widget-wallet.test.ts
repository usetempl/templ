import { expect } from "vitest";
import type { ChatEvent } from "./events";
import { simulate } from "./simulation.test.helpers";
import {
  isLoopbackOrigin,
  WIDGET_REMEMBER_CREDENTIAL,
  WIDGET_REMEMBER_DAYS,
  WIDGET_REMEMBER_STATEMENT,
  WIDGET_SIGN_IN_STATEMENT,
} from "./widget-wallet";

const HEX = "0123456789abcdef";

simulate(
  "a remembered sign-in extends today's statement and reads only a family id and a secret",
  (random) => {
    expect(WIDGET_REMEMBER_DAYS).toBe(30);
    expect(
      WIDGET_REMEMBER_STATEMENT.startsWith(`${WIDGET_SIGN_IN_STATEMENT} `),
    ).toBe(true);
    expect(WIDGET_REMEMBER_STATEMENT).toContain(
      "You'll stay signed in on this site for 30 days, or until you sign out.",
    );
    expect(WIDGET_REMEMBER_STATEMENT).not.toMatch(/\n/);

    for (let key = 0; key < 20; key++) {
      const family = random.text(HEX, 32);
      const secret = random.text(HEX, 64);
      const credential = `${family}.${secret}`;
      expect(WIDGET_REMEMBER_CREDENTIAL.test(credential), credential).toBe(
        true,
      );
      const at = random.int(0, credential.length - 1);
      for (const damaged of [
        credential.slice(0, at) + credential.slice(at + 1),
        credential.slice(0, at) + random.pick([...HEX]) + credential.slice(at),
        credential.slice(0, at) +
          random.pick([..."ABCDEFg -_"]) +
          credential.slice(at + 1),
        `${family}${secret}`,
        `${secret}.${family}`,
        ` ${credential}`,
        `${credential}\n`,
      ])
        expect(WIDGET_REMEMBER_CREDENTIAL.test(damaged), damaged).toBe(false);
    }

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
  },
);

simulate(
  "only localhost, 127.0.0.1 and [::1] name a development origin, exactly",
  (random) => {
    for (let project = 0; project < 20; project++) {
      const scheme = random.pick(["http", "https"]);
      const host = random.pick(["localhost", "127.0.0.1", "[::1]"]);
      const port = random.chance(0.3) ? "" : `:${random.int(1_024, 65_535)}`;
      const origin = `${scheme}://${host}${port}`;
      expect(isLoopbackOrigin(origin), origin).toBe(true);
      for (const other of [
        `${scheme}://${host}.evil.example${port}`,
        `${scheme}://evil.example.${host}${port}`,
        `${scheme}://user@${host}${port}`,
        `${scheme}://${random.pick(["127.0.0.2", "0.0.0.0", "[::2]", "app.example"])}${port}`,
        `${random.pick(["ftp", "ws", "file"])}://${host}${port}`,
        `${origin}${random.pick(["/", "/widget", "?next=1", "#top"])}`,
        origin.toUpperCase(),
        ` ${origin}`,
      ])
        expect(isLoopbackOrigin(other), other).toBe(false);
    }
    for (const value of [null, undefined, 5_173, ["http://localhost"]])
      expect(isLoopbackOrigin(value), String(value)).toBe(false);
  },
);
