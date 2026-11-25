import { afterEach, expect, it, vi } from "vitest";
import { hostedGuestReturn } from "./hosted-guest-return";
import { mountSupportWidget } from "./support-widget";
import { ordinaryGuestReturn, supportStorageKey } from "./support-widget-return";

const workspace = "0199604e-4900-7000-8000-000000000001";
const thread = "tc-" + "1".repeat(32);
const credential = "a".repeat(64);
const token = "b".repeat(64);
const address = "0x" + "1".repeat(40);
const principal = "guest:one";
const key = (name: string) => supportStorageKey(name, workspace);
const lifetime = () => {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  return controller;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function retained() {
  localStorage.setItem(key("guest"), credential);
  localStorage.setItem(key("guest-thread"), thread);
}
function tab(level: string, expires: number) {
  sessionStorage.setItem(key("tab"), JSON.stringify({l: level, e: expires, t: token, p: principal, g: credential.slice(56)}));
}

it("keeps valid tab, signed, remembered and unreadable records on the live restoration path", () => {
  retained();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const prepare = () => hostedGuestReturn(workspace, "test", null, lifetime().signal);
  tab("anonymous", Date.now() + 300_000);
  expect(prepare()).toBeUndefined();
  tab("signed", Date.now() - 500);
  expect(prepare()).toBeUndefined();
  sessionStorage.setItem(key("tab"), "broken");
  expect(prepare()).toBeUndefined();
  sessionStorage.clear();
  localStorage.setItem(key("member"), "legacy");
  expect(prepare()).toBeUndefined();
  localStorage.removeItem(key("member"));
  location.hash = "#templ-guest=opaque";
  expect(prepare()).toBeUndefined();
  location.hash = "";
  localStorage.clear();
  expect(prepare()).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  for (const level of ["anonymous", "connected"]) {
    tab(level, Date.now() - 100);
    expect(ordinaryGuestReturn(workspace)).toBe(true);
  }
});

function server(denied = false) {
  retained();
  const policy = Promise.withResolvers<void>();
  const reads = vi.fn();
  const renew = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/guest")) {
      renew(JSON.parse(String(init?.body)));
      if (denied) return Response.json({}, {status: 401});
      return Response.json({credential, token, principalId: principal, level: "anonymous", expiresAt: Date.now() + 3600_000});
    }
    if (path.endsWith("/auth/policy")) {
      await policy.promise;
      return Response.json({minimumLevel: "anyone", chatFirst: true, live: false});
    }
    if (path.endsWith("/messages")) {
      const bearer = new Headers(init?.headers).get("Authorization");
      const id = path.split("/").at(-2);
      reads(id, bearer);
      if (bearer !== "Bearer " + token) return Response.json({}, {status: 403});
      return Response.json({messages: [{id:"m", text:"Authorized synthetic history", author:principal}], conversation:{id, state:"open"}, nextBefore:null});
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  return {policy, renew, reads, fetcher};
}

it("checks the selected wallet once, restores an expired guest and reads the selected case before mounting", async () => {
  const f = server();
  tab("connected", Date.now() - 10);
  const wallet = {evm: {request: vi.fn(async ({method}: {method: string}) =>
    method === "eth_accounts" ? [address] : method === "eth_chainId" ? "0x1" : Promise.reject(new Error("Unexpected prompt")))}};
  const signal = lifetime().signal;
  const prepared = hostedGuestReturn(workspace, "build", wallet, signal)!;
  await prepared.guest;
  expect(f.renew.mock.calls).toEqual([[{credential, reportedWallet: {address, chainId: 1}}]]);
  expect(wallet.evm.request.mock.calls.map(([args]) => args.method)).toEqual(["eth_accounts", "eth_chainId"]);
  expect(f.reads.mock.calls).toEqual([[thread, "Bearer " + token]]);
  expect(document.body.textContent).not.toContain("Authorized synthetic history");
  // The renderer requests the page through its usual fresh policy and routing rules.
  const widget = mountSupportWidget({workspace, wallet, persistDrafts: false}, undefined, prepared);
  cleanups.push(widget.destroy);
  const opened = widget.open(false);
  const root = document.querySelector("[data-templ-support]")!.shadowRoot!;
  await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([input]) => String(input).endsWith("/auth/policy"))).toBe(true));
  expect(root.textContent).not.toContain("Authorized synthetic history");
  f.policy.resolve();
  await opened;
  expect(root.querySelector(".messages")?.textContent).toContain("Authorized synthetic history");
  expect(f.reads).toHaveBeenCalledTimes(1);
  expect(f.renew).toHaveBeenCalledTimes(1);
  expect(f.fetcher.mock.calls.filter(([input]) => String(input).includes("/auth/policy"))).toHaveLength(1);
});

it("a revoked credential cannot request history or allocate a new guest", async () => {
  const f = server(true);
  const prepared = hostedGuestReturn(workspace, "build", null, lifetime().signal)!;
  await prepared.guest;
  expect(f.renew.mock.calls).toEqual([[{credential}]]);
  expect(f.reads).not.toHaveBeenCalled();
  expect(localStorage.getItem(key("guest"))).toBeNull();
  expect(prepared.client.session).toBeUndefined();
});

it("discards a completed history read when the visitor signs out in another tab", async () => {
  const f = server();
  const prepared = hostedGuestReturn(workspace, "build", null, lifetime().signal)!;
  await prepared.guest;
  localStorage.removeItem(key("guest"));
  window.dispatchEvent(new StorageEvent("storage", {key: key("guest")}));
  await expect(prepared.client.messages(thread, undefined, true)).rejects.toThrow();
  expect(f.reads).toHaveBeenCalledTimes(1);
});

it("cancels a pending wallet account lookup when the opening is abandoned", async () => {
  const f = server();
  const accounts = Promise.withResolvers<string[]>();
  const wallet = {evm: {request: async ({method}: {method: string}) => method === "eth_accounts" ? accounts.promise : "0x1"}};
  const opening = lifetime();
  const prepared = hostedGuestReturn(workspace, "build", wallet, opening.signal)!;
  opening.abort();
  accounts.resolve([address]);
  await expect(prepared.guest).rejects.toThrow();
  expect(f.renew).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});


it("a replaced credential wins even when an earlier response returns in the same document", async () => {
  retained();
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn(() => response.promise));
  const prepared = hostedGuestReturn(workspace, "build", null, lifetime().signal)!;
  const next = "c".repeat(64);
  localStorage.setItem(key("guest"), next);
  response.resolve(Response.json({reason: "guest-expired"}, {status: 401}));
  await expect(prepared.guest).rejects.toThrow();
  expect(prepared.client.session).toBeUndefined();
  expect(localStorage.getItem(key("guest"))).toBe(next);
});

it("reads again when the authorized history was ready more than one second before opening", async () => {
  vi.useFakeTimers();
  try {
    const f = server();
    const prepared = hostedGuestReturn(workspace, "build", null, lifetime().signal)!;
    await prepared.guest;
    await vi.advanceTimersByTimeAsync(1_001);
    await prepared.client.messages(thread, undefined, true);
    expect(f.reads).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
