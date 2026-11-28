import { afterEach, expect, vi } from "vitest";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_SUPPORT_WORKSPACE as DESK } from "@templ/chat/support-models";

// This portable source has no production workspace identity. Exercise an isolated desk.
vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000003",
}));


const HEX = [..."0123456789abcdef"];
const images = [{ url: "https://usetempl.com/art/og/crypto-help.png", width: 1200, height: 630, alt: "Crypto needs a Help button." }];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The route's share decision with the real name lookup, built for one environment. */
async function build(environment: "production" | "staging") {
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment);
  vi.stubEnv("NEXT_PUBLIC_TEMPL_API_ORIGIN", "https://support.example.org");
  vi.resetModules();
  const { cryptoDeskMetadata } = await import("./crypto-desk-metadata");
  const { namedHostedWorkspace } = await import("@/lib/hosted-support");
  return (slug: string, query: Record<string, string | string[] | undefined> = {}) =>
    cryptoDeskMetadata(slug, query, namedHostedWorkspace);
}

simulate(
  "sim:unit only a visitor link that resolves to the live crypto desk in production shares its card and the fixed /crypto link",
  async (draw) => {
    const lookups: string[] = [];
    let reply = (): Response => Response.json({ id: DESK, hostedName: true });
    vi.stubGlobal("fetch", async (url: string) => {
      lookups.push(url);
      return reply();
    });
    const metadata = await build("production");
    const name = draw.pick(["crypto", "eth", "ethereum"]);
    const visitor = `ref-${draw.text(HEX, 12)}`;
    const card = await metadata(
      draw.pick([name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)]),
      draw.pick([{}, { tab: "" }, { ref: visitor }, { utm_source: visitor, wallet: visitor }]),
    );
    const title = "Crypto help desk by Templ";
    const description = "Free help with Bitcoin, Ethereum, Solana, layer 2s, DeFi and wallets. Ask in your own language.";
    expect(card).toEqual({
      title: { absolute: title },
      description,
      alternates: { canonical: "/crypto" },
      openGraph: { type: "website", title, description, url: "/crypto", images },
      twitter: { card: "summary_large_image", title, description, images },
    });
    expect(JSON.stringify(card)).not.toContain(visitor);
    expect(lookups).toEqual([`https://support.example.org/slugs/${name}`]);

    // A neighboring workspace, an empty or missing desk and a busy service keep the generic title.
    for (const refuse of draw.shuffle<() => Response>([
      () => Response.json({ id: `01990000-0000-7000-8000-${draw.text(HEX, 12)}`, hostedName: true }),
      () => Response.json({ id: DESK }),
      () => Response.json({ hostedName: true }),
      () => new Response(null, { status: draw.pick([400, 404]) }),
      () => new Response(null, { status: draw.pick([429, 500, 503]) }),
      () => new Response("not-json"),
      () => {
        throw new TypeError("Synthetic network failure");
      },
    ])) {
      reply = refuse;
      expect(await metadata(name)).toBeNull();
    }

    // Tab, case and invitation links, other names and dormant staging look nothing up.
    lookups.length = 0;
    reply = () => Response.json({ id: DESK, hostedName: true });
    const key = draw.pick(["tab", "support", "invite"]);
    expect(await metadata(name, { [key]: draw.pick([visitor, [visitor]]) })).toBeNull();
    for (const other of ["flex", "help", "crypto-help", `team-${draw.text(HEX, 6)}`, DESK])
      expect(await metadata(other)).toBeNull();
    expect(await (await build("staging"))(name)).toBeNull();
    expect(lookups).toEqual([]);
  },
);
