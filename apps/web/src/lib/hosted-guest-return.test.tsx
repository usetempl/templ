import { afterEach, expect, vi } from "vitest";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { hostedGuestReturn } from "./hosted-guest-return";
import { mountSupportWidget } from "./support-widget";
import {
  ordinaryGuestReturn,
  supportStorageKey,
} from "./support-widget-return";

vi.mock("./site-environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./site-environment")>();
  return {
    ...actual,
    SITE: { ...actual.SITE, community: "https://api.example.test" },
  };
});

const workspace = "0199604e-4900-7000-8000-000000000001";
const HEX = [..."0123456789abcdef"];
const key = (name: string) => supportStorageKey(name, workspace);
const lifetime = () => {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  return controller;
};
const cleanups: (() => void)[] = [];
function leave() {
  for (const stop of cleanups.splice(0).reverse()) stop();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
}
afterEach(leave);

/** A returning visitor: the guest this browser retained and what the service
 * issues for it. Every value is synthetic and drawn from the scenario seed. */
function visitor(draw: Rng) {
  return {
    thread: "tc-" + draw.text(HEX, 32),
    credential: draw.text(HEX, 64),
    token: draw.text(HEX, 64),
    address: "0x" + draw.text([..."123456789"], 40),
    principal: "guest:" + draw.text(HEX, 8),
  };
}
type Visitor = ReturnType<typeof visitor>;
function retain(v: Visitor) {
  localStorage.setItem(key("guest"), v.credential);
  localStorage.setItem(key("guest-thread"), v.thread);
}
function tab(v: Visitor, level: unknown, expires: unknown) {
  sessionStorage.setItem(
    key("tab"),
    JSON.stringify({
      l: level,
      e: expires,
      t: v.token,
      p: v.principal,
      g: v.credential.slice(56),
    }),
  );
}

simulate(
  "sim:browser a hosted opening prepares a return only for a stored guest whose tab has no live, signed, remembered or unreadable record",
  (draw) => {
    vi.useFakeTimers({
      now: new Date("2026-11-26T12:00:00Z"),
      toFake: ["Date"],
    });
    const now = Date.now();
    const v = visitor(draw);
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);

    for (let opening = 0; opening < 40; opening++) {
      localStorage.clear();
      sessionStorage.clear();
      location.hash = "";
      const stored = draw.pick([
        v.credential,
        v.credential,
        v.credential,
        null,
        v.credential + "0",
        v.credential.slice(1),
        "G" + v.credential.slice(1),
      ]);
      if (stored !== null) localStorage.setItem(key("guest"), stored);
      localStorage.setItem(key("guest-thread"), v.thread);
      const remembered = draw.chance(0.15);
      if (remembered) localStorage.setItem(key("member"), "legacy");

      const level = draw.pick(["anonymous", "connected", "signed", "member"]);
      const expires = draw.pick<unknown>([
        now - draw.int(1, 600_000),
        now,
        now + 1,
        now + draw.int(2, 300_000),
        0,
        -1,
        String(now - 1),
      ]);
      const record = draw.pick(["none", "none", "saved", "saved", "broken"]);
      if (record === "saved") tab(v, level, expires);
      if (record === "broken")
        sessionStorage.setItem(key("tab"), draw.pick(["broken", "null", "7"]));
      const ordinary =
        !remembered &&
        (record === "none" ||
          (record === "saved" &&
            (level === "anonymous" || level === "connected") &&
            typeof expires === "number" &&
            expires > 0 &&
            expires <= now));

      const emailed = draw.chance(0.15);
      location.hash = emailed
        ? "#templ-guest=opaque"
        : draw.pick(["", "#pricing"]);
      const abandoned = draw.chance(0.1);
      const controller = lifetime();
      if (abandoned) controller.abort();

      const at = JSON.stringify({
        opening,
        stored: stored === v.credential,
        remembered,
        record,
        level,
        expires: typeof expires === "number" ? expires - now : expires,
        emailed,
        abandoned,
      });
      expect(ordinaryGuestReturn(workspace), at).toBe(ordinary);
      const requests = fetcher.mock.calls.length;
      const prepared = hostedGuestReturn(
        workspace,
        "test",
        null,
        controller.signal,
      );
      const expected =
        ordinary && !emailed && !abandoned && stored === v.credential;
      expect(prepared !== undefined, at).toBe(expected);
      if (!expected) expect(fetcher, at).toHaveBeenCalledTimes(requests);
      controller.abort();
    }
  },
);

function server(v: Visitor, denied = false) {
  retain(v);
  const policy = Promise.withResolvers<void>();
  const reads = vi.fn();
  const renew = vi.fn();
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/auth/guest")) {
        renew(JSON.parse(String(init?.body)));
        if (denied) return Response.json({}, { status: 401 });
        return Response.json({
          credential: v.credential,
          token: v.token,
          principalId: v.principal,
          level: "anonymous",
          expiresAt: Date.now() + 3600_000,
        });
      }
      if (path.endsWith("/auth/policy")) {
        await policy.promise;
        return Response.json({
          minimumLevel: "anyone",
          chatFirst: true,
          live: false,
        });
      }
      if (path.endsWith("/messages")) {
        const bearer = new Headers(init?.headers).get("Authorization");
        const id = path.split("/").at(-2);
        reads(id, bearer);
        if (bearer !== "Bearer " + v.token)
          return Response.json({}, { status: 403 });
        return Response.json({
          messages: [
            {
              id: "m",
              text: "Authorized synthetic history",
              author: v.principal,
            },
          ],
          conversation: { id, state: "open" },
          nextBefore: null,
        });
      }
      return Response.json({});
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return { policy, renew, reads, fetcher };
}

const openings: Record<string, (draw: Rng, v: Visitor) => Promise<void>> = {
  async "an expired guest is restored with one passive wallet check and its selected case is read once"(
    draw,
    v,
  ) {
    const f = server(v);
    tab(
      v,
      draw.pick(["anonymous", "connected"]),
      Date.now() - draw.int(1, 60_000),
    );
    const [chain, chainId] = draw.pick([
      ["0x1", 1],
      ["0x2105", 8453],
    ] as const);
    const wallet = {
      evm: {
        request: vi.fn(async ({ method }: { method: string }) =>
          method === "eth_accounts"
            ? [v.address]
            : method === "eth_chainId"
              ? chain
              : Promise.reject(new Error("Unexpected prompt")),
        ),
      },
    };
    const signal = lifetime().signal;
    const prepared = hostedGuestReturn(workspace, "build", wallet, signal)!;
    await prepared.guest;
    expect(f.renew.mock.calls).toEqual([
      [
        {
          credential: v.credential,
          reportedWallet: { address: v.address, chainId },
        },
      ],
    ]);
    expect(wallet.evm.request.mock.calls.map(([args]) => args.method)).toEqual([
      "eth_accounts",
      "eth_chainId",
    ]);
    expect(f.reads.mock.calls).toEqual([[v.thread, "Bearer " + v.token]]);
    expect(document.body.textContent).not.toContain(
      "Authorized synthetic history",
    );
    const widget = mountSupportWidget(
      { workspace, wallet, persistDrafts: false },
      undefined,
      prepared,
    );
    cleanups.push(widget.destroy);
    const opened = widget.open(false);
    const root = document.querySelector("[data-templ-support]")!.shadowRoot!;
    const policies = () =>
      f.fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/auth/policy"),
      );
    await vi.waitFor(() => expect(policies()).toHaveLength(1));
    expect(root.textContent).not.toContain("Authorized synthetic history");
    f.policy.resolve();
    await opened;
    expect(root.querySelector(".messages")?.textContent).toContain(
      "Authorized synthetic history",
    );
    expect(f.reads).toHaveBeenCalledTimes(1);
    expect(f.renew).toHaveBeenCalledTimes(1);
    expect(policies()).toHaveLength(1);
  },

  async "a revoked credential cannot request history or allocate a new guest"(
    _draw,
    v,
  ) {
    const f = server(v, true);
    const prepared = hostedGuestReturn(
      workspace,
      "build",
      null,
      lifetime().signal,
    )!;
    await prepared.guest;
    expect(f.renew.mock.calls).toEqual([[{ credential: v.credential }]]);
    expect(f.reads).not.toHaveBeenCalled();
    expect(localStorage.getItem(key("guest"))).toBeNull();
    expect(prepared.client.session).toBeUndefined();
  },

  async "a completed history read is discarded when the visitor signs out in another tab"(
    draw,
    v,
  ) {
    const f = server(v);
    const prepared = hostedGuestReturn(
      workspace,
      "build",
      null,
      lifetime().signal,
    )!;
    await prepared.guest;
    localStorage.removeItem(key("guest"));
    window.dispatchEvent(
      new StorageEvent("storage", { key: draw.pick([key("guest"), null]) }),
    );
    await expect(
      prepared.client.messages(v.thread, undefined, true),
    ).rejects.toThrow();
    expect(f.reads).toHaveBeenCalledTimes(1);
  },

  async "an abandoned opening cancels its pending wallet lookup"(_draw, v) {
    const f = server(v);
    const accounts = Promise.withResolvers<string[]>();
    const wallet = {
      evm: {
        request: async ({ method }: { method: string }) =>
          method === "eth_accounts" ? accounts.promise : "0x1",
      },
    };
    const opening = lifetime();
    const prepared = hostedGuestReturn(
      workspace,
      "build",
      wallet,
      opening.signal,
    )!;
    opening.abort();
    accounts.resolve([v.address]);
    await expect(prepared.guest).rejects.toThrow();
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
  },

  async "a replaced credential survives an earlier refusal that returns late"(
    draw,
    v,
  ) {
    retain(v);
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const prepared = hostedGuestReturn(
      workspace,
      "build",
      null,
      lifetime().signal,
    )!;
    const next = draw.text(HEX, 64);
    localStorage.setItem(key("guest"), next);
    response.resolve(
      Response.json({ reason: "guest-expired" }, { status: 401 }),
    );
    await expect(prepared.guest).rejects.toThrow();
    expect(prepared.client.session).toBeUndefined();
    expect(localStorage.getItem(key("guest"))).toBe(next);
  },

  async "the authorized history serves one opener for one second after it is ready"(
    draw,
    v,
  ) {
    vi.useFakeTimers({ now: new Date("2026-11-26T12:00:00Z") });
    const f = server(v);
    const prepared = hostedGuestReturn(
      workspace,
      "build",
      null,
      lifetime().signal,
    )!;
    await prepared.guest;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reads).toHaveBeenCalledTimes(1);
    const late = draw.chance(0.5);
    await vi.advanceTimersByTimeAsync(
      late ? draw.pick([1_000, 1_001, 19_000]) : draw.int(0, 999),
    );
    await prepared.client.messages(v.thread, undefined, true);
    expect(f.reads).toHaveBeenCalledTimes(late ? 2 : 1);
    await prepared.client.messages(v.thread, undefined, true);
    expect(f.reads).toHaveBeenCalledTimes(late ? 3 : 2);
  },
};

simulate(
  "sim:browser a returning hosted guest is restored once, and revocation, sign-out elsewhere, abandonment, replacement and delay each discard the prepared history",
  async (draw) => {
    for (const name of draw.shuffle(Object.keys(openings))) {
      try {
        await openings[name](draw, visitor(draw));
      } catch (error) {
        if (error instanceof Error) error.message = `${name}: ${error.message}`;
        throw error;
      } finally {
        leave();
      }
    }
  },
);
