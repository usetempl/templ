// @vitest-environment happy-dom
import { simulate } from "@templ/chat/simulation.test.helpers";
import { expect } from "vitest";
import { cryptoDeskLink, cryptoDeskSources } from "./crypto-desk";
import type { TailHost } from "./support-widget";
import { ops } from "./support-widget-ops";

const LOWER = "abcdefghijklmnopqrstuvwxyz";

function bubbles(namedLinks?: (href: string) => string | undefined) {
  const form = document.createElement("form");
  const draft = document.createElement("textarea");
  form.append(draft);
  const host = {
    options: { workspace: "01990000-0000-7000-8000-000000000001", namedLinks },
    draft,
    el: (tag: string, text?: string, className?: string) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    },
    client: { adopt: () => [undefined, async () => ({})], onSessionChange: () => () => {} },
    refresh: async () => {},
  } as unknown as TailHost;
  const links = ops({ host, form, thread: () => null });
  return (text: string, own = false) => {
    const node = document.createElement("div");
    node.className = own ? "message own" : "message";
    links.linkify(node, { author: own ? "member" : "agent", text });
    return node;
  };
}

simulate("sim:unit the crypto desk names its reviewed links and keeps every other address as text", (draw) => {
  const [page, second] = draw.shuffle([
    "https://bluewallet.io/", "https://bitcoin.org/en/faq", "https://metamask.com/download",
    "https://phantom.com/download", "https://securityalliance.org/sos",
  ]);
  const { hostname } = new URL(page);
  const name = cryptoDeskLink(page)!;
  const secondName = cryptoDeskLink(second)!;
  const other = `https://${draw.text(LOWER, 8)}.example/bogus`;
  const desk = bubbles(cryptoDeskLink);
  const shown = desk(`Open [Unofficial mirror](${page}). Skip [Unreviewed site](${other}).`);
  expect(shown.textContent).toBe(`Open ${name}. Skip Unreviewed site.`);
  expect([...shown.querySelectorAll("a")].map(link => [link.textContent, link.href, link.rel, link.referrerPolicy]))
    .toEqual([[name, page, "noopener noreferrer nofollow ugc", "no-referrer"]]);
  const bullet = draw.pick(["- ", "* ", "+ ", ""]);
  const sources = desk(`Answer.\n\nSources:\n${bullet}[A](${page})\n${bullet}[B](${second})`);
  expect(sources.textContent).toBe(`Answer.\n\nSources:\n${name}\n${secondName}`);
  expect([...sources.querySelectorAll("a")].map(link => link.href)).toEqual([page, second]);
  expect(desk(`Visit <${page}>.`).textContent).toBe(`Visit ${name}.`);
  for (const href of [
    page + "?to=other", page + "#ref", page.replace("https:", "http:"), page + "unknown",
    page.replace(hostname, "member@" + hostname), page.replace(hostname, hostname + ":8443"),
    page.replace(hostname, hostname + ".example"), other,
  ]) {
    const rejected = desk(`[Wallet](${href})`);
    expect(rejected.querySelector("a")).toBeNull();
    expect(rejected.textContent).toBe("Wallet");
  }
  const evidence = [{ title: "Mirror", url: page }, { title: "Wrong", url: page }, { title: "Unknown", url: other }, { title: "No link" }];
  expect(cryptoDeskSources(evidence, "")).toEqual([{ title: name, url: page }]);
  expect(cryptoDeskSources(evidence, `Sources:\n- [${name}](${page})`)).toEqual([]);
  const own = desk(`Is [${name}](${page}) right?`, true);
  expect(own.textContent).toBe(`Is ${name}: ${page} right?`);
  const neighbor = bubbles()(`Open [${name}](${page}) or ${other}.`);
  expect([...neighbor.querySelectorAll("a")].map(link => link.textContent)).toEqual([page, other]);
});
