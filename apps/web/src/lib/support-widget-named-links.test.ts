// @vitest-environment happy-dom
import { CRYPTO_PROVIDER_PAGES } from "@templ/chat/crypto-help-links";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { base58Encode } from "@templ/chat/solana";
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
  const provider = draw.pick(Object.values(CRYPTO_PROVIDER_PAGES));
  const cited = desk(`Confirmada.\n\nFontes:\n[${provider.label}](${provider.url})`);
  expect(cited.querySelector("a")?.href).toBe(provider.url);
  expect(cited.querySelector("a")?.referrerPolicy).toBe("no-referrer");
  expect(desk(`[Provider](${provider.url}?tx=private)`).querySelector("a")).toBeNull();
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

simulate("sim:crypto explorer consent shares only the unchanged question and transaction", async (draw) => {
  const hash = draw.text("0123456789abcdef", 64);
  const host = draw.pick(["mempool.space", "blockstream.info", "etherscan.io", "eth.blockscout.com", "solscan.io", "explorer.solana.com"]);
  const id = host === "etherscan.io" || host === "eth.blockscout.com" ? "0x" + hash :
    host.includes("sol") ? "1".repeat(64) : hash;
  const url = `https://${host}/tx/${id}`;
  const question = `O que aconteceu nesta transação? ${url}`;
  const form = document.createElement("form");
  const draft = document.createElement("textarea");
  form.append(draft);
  let thread = "first";
  let account = "one";
  let sessionChanged = () => {};
  const widget = {
    draft, options: { confirmCryptoTransactionLinks: true },
    client: {
      adopt: () => [{ token: account }, async () => ({})],
      onSessionChange: (fn: () => void) => { sessionChanged = fn; return () => {}; },
    },
  } as unknown as TailHost;
  const review = ops({ host: widget, form, thread: () => thread });
  const button = form.querySelector("button")!;
  const sent: string[] = [];
  let submission = Promise.resolve();
  form.requestSubmit = () => { submission = review.beforeSend().then(ok => { if (ok) sent.push(draft.value); }); };
  draft.value = question;
  expect(await review.beforeSend()).toBe(false);
  expect(button.hidden).toBe(false);
  thread = "second";
  button.click();
  expect(sent).toEqual([]);
  expect(await review.beforeSend()).toBe(false);
  account = "two";
  sessionChanged();
  button.click();
  expect(sent).toEqual([]);
  expect(await review.beforeSend()).toBe(false);
  draft.value += "!";
  button.click();
  expect(sent).toEqual([]);
  draft.dispatchEvent(new Event("input"));
  expect(await review.beforeSend()).toBe(false);
  button.click();
  await submission;
  expect(sent).toEqual([question + "!"]);
  expect(await review.beforeSend()).toBe(false);
  const seed = Buffer.from(Array.from({ length: 32 }, () => draw.int(0, 255)));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const publicKey = createPublicKey(createPrivateKey({ key: der, type: "pkcs8", format: "der" })).export({ type: "spki", format: "der" });
  const keypair = base58Encode(Buffer.concat([seed, publicKey.subarray(-32)]));
  for (const text of [
    "https://solscan.io/tx/" + keypair,
    url.replace(host, host + ".invalid"), url + "?q=1", url + "#wrong", url.replace("https:", "http:"),
    url.replace(host, "user@" + host), url + " " + id, url + " " + hash.split("").reverse().join(""), id,
    "private key: " + url, "[0," + "1,".repeat(62) + "2]",
  ]) {
    draft.value = text;
    draft.dispatchEvent(new Event("input"));
    expect(await review.beforeSend()).toBe(false);
    expect(button.hidden).toBe(true);
  }
  widget.options.confirmCryptoTransactionLinks = false;
  draft.value = question;
  expect(await review.beforeSend()).toBe(false);
  expect(button.hidden).toBe(true);
  review.destroy();
});
