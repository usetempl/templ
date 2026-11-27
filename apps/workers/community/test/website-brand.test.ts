import { expect, vi } from "vitest";
import { fetchWebsiteAsset, publicIcon, websiteUrl } from "../src/website-brand";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";

const TEMPL = "https://usetempl.com/";
const TEMPL_ASSETS = [
  TEMPL,
  "https://docs.usetempl.com/",
  TEMPL + "favicon.svg",
  TEMPL + "apple-touch-icon.png",
];
const host = (random: Rng) =>
  [
    ...(random.chance(0.3) ? ["www"] : []),
    ...Array.from({ length: random.int(1, 2) }, () =>
      random.pick(["garden", "vault", "my-app", "docs", "app", "x9"]),
    ),
    random.pick(["com", "io", "tools", "org", "finance", "xyz"]),
  ].join(".");
const mixedCase = (random: Rng, text: string) =>
  [...text]
    .map((character) =>
      random.chance(0.3) ? character.toUpperCase() : character,
    )
    .join("");
const padded = (random: Rng, text: string) =>
  random.pick(["", " ", "\n", "\t "]) + text + random.pick(["", " ", " \n"]);
// Local, reserved, numeric, credentialed and non-web addresses, and every
// Templ page other than the two public ones.
const REFUSED_SITES = [
  "https://usetempl.com/inbox",
  "https://community.usetempl.com/",
  "https://docs.usetempl.com/guide",
  "app.templ.fun",
  "https://templ.vip/pricing",
  "http://localhost/",
  "printer.local",
  "wiki.corp",
  "host.internal",
  "docs.example",
  "garden",
  "192.168.1.10",
  "2130706433",
  "0x7f.1",
  "https://[::1]/",
  "https://staff@garden.tools/",
  "https://staff:secret@garden.tools/",
  "https://garden.tools:8443/",
  "http://garden.tools:8080/",
  "garden.tools:8443",
  "ftp://garden.tools/",
  "javascript:alert(1)",
  "mailto:team@garden.tools",
  "https://",
  "a".repeat(2_045) + ".com",
];

simulate(
  "a typed website becomes one public HTTPS page, or is refused",
  (random) => {
    for (let sites = 0; sites < 20; sites++) {
      const name = host(random);
      const path = random.pick([
        "",
        "/",
        "/guide",
        "/docs/getting-started",
        "/a_b/c-d.html",
      ]);
      const typed =
        random.pick(["", "http://", "https://", "HTTP://", "Https://"]) +
        mixedCase(random, name) +
        path +
        random.pick(["", "?lang=en", "?utm_source=x&token=1"]) +
        random.pick(["", "#setup"]);
      const site = `https://${name}${path || "/"}`;
      expect(websiteUrl(padded(random, typed)), typed).toBe(site);
      expect(websiteUrl(site)).toBe(site);

      const cdn = host(random);
      expect(publicIcon(`/favicon.svg?v=${sites}`, site)).toBe(
        `https://${name}/favicon.svg`,
      );
      expect(publicIcon(`https://${cdn}/logo.png?size=64#top`, site)).toBe(
        `https://${cdn}/logo.png`,
      );
      expect(publicIcon(`//${cdn}/logo.png`, site)).toBe(
        `https://${cdn}/logo.png`,
      );
      const icon = random.pick([
        `http://${cdn}/logo.png`,
        "data:image/png;base64,AAAA",
        "javascript:alert(1)",
        "https://localhost/icon.png",
        "https://10.0.0.1/icon.png",
        "https://usetempl.com/inbox.png",
        "https://community.usetempl.com/favicon.svg",
        `https://staff@${cdn}/logo.png`,
        `https://${cdn}:8443/logo.png`,
      ]);
      expect(publicIcon(icon, site), icon).toBe("");
    }
    for (const typed of [
      "usetempl.com",
      "http://usetempl.com",
      "https://www.usetempl.com/",
      "HTTPS://UseTempl.com/?ref=nav#top",
    ])
      expect(websiteUrl(padded(random, typed)), typed).toBe(TEMPL);
    expect(websiteUrl(padded(random, "docs.usetempl.com"))).toBe(
      "https://docs.usetempl.com/",
    );
    for (const icon of ["/favicon.svg?v=1", "/apple-touch-icon.png#x"])
      expect(publicIcon(icon, TEMPL)).toBe(
        TEMPL + icon.slice(1).split(/[?#]/)[0],
      );
    expect(publicIcon("/logo.png", TEMPL)).toBe("");
    for (const typed of random.shuffle(REFUSED_SITES))
      expect(() => websiteUrl(padded(random, typed)), typed).toThrow(
        expect.objectContaining({
          status: 400,
          message: "Enter a public website, like example.com.",
        }),
      );
    for (const typed of ["", "   ", "\n", 5, null, undefined, ["garden.tools"]])
      expect(() => websiteUrl(typed)).toThrow(
        expect.objectContaining({ status: 400, message: "Enter your website." }),
      );
  },
  { runs: 8 },
);

simulate(
  "a fixed public Templ file is read once, without the caller's credentials or a followed redirect",
  async (random) => {
    const asset = random.pick(TEMPL_ASSETS);
    const maxBytes = random.int(16, 256);
    const sent = Uint8Array.from({ length: random.int(1, 320) }, () =>
      random.int(0, 255),
    );
    const status = random.pick([200, 200, 200, 301, 302, 307, 304, 404, 500]);
    const remote = vi.fn(async () =>
      status === 200
        ? new Response(sent)
        : status === 404 || status === 500
          ? new Response("not here", { status })
          : new Response(null, {
              status,
              headers: { location: "https://usetempl.com/inbox" },
            }),
    );
    const accept = random.pick([undefined, "", "text/html", "image/svg+xml"]);
    const etag = random.pick([undefined, '"v1"']);
    const read = fetchWebsiteAsset(
      asset,
      {
        maxBytes,
        timeoutMs: 1_000,
        maxRedirects: random.int(0, 5),
        headers: {
          cookie: "session=example",
          authorization: "Bearer example",
          "x-forwarded-for": "203.0.113.7",
          ...(accept === undefined ? {} : { accept }),
          ...(etag === undefined ? {} : { "if-none-match": etag }),
        },
      },
      { fetch: remote as unknown as typeof fetch },
    );
    if (status === 200 && sent.length > maxBytes)
      await expect(read).rejects.toMatchObject({ status: 413 });
    else {
      const result = await read;
      expect(result.url).toBe(asset);
      expect(result.status).toBe(status);
      expect([...result.body]).toEqual(status === 200 ? [...sent] : []);
    }
    expect(remote).toHaveBeenCalledOnce();
    const [url, init] = remote.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(asset);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      accept: accept || "image/*",
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    });
  },
  { runs: 24 },
);
