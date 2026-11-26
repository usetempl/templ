import { expect, it } from "vitest";
import { data, workerdHarness } from "./workerd-harness";
import { PRODUCT_LIMITS } from "@templ/chat/plans";

// The test uses real room storage, session verification, source import, spend meter
// and answer verification. Only the website and model are local fixtures.
const entry = `
  import { SupportKnowledge as Knowledge } from "./worker";
  export { default, CommunityRoom, AuthRecord, SubscriptionList, MediaQuota, SafetyStore, FeedbackStore } from "./worker";
  export class SupportKnowledge extends Knowledge {
    constructor(state, env) {
      super(state, { ...env, AI: { run: async (_model, body) => {
        const input = JSON.parse(body.input[0].content[0].text);
        const hit = input.passages.find(p => p.text.includes("export a garden journal"));
        if (!hit) throw Error("Missing the linked guide");
        const answer = {
          action: "reply", confidence: "high", handoffReason: null, facts: [], claims: [], comparisons: [],
          sources: [hit.sourceId], text: input.answer ? "Supported." : "Members can export a garden journal from the settings page.",
          summary: "The guide covers this."
        };
        return { model: "gpt-6.1-sol", status: "completed", usage: { input_tokens: 100, output_tokens: 10,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] };
      } } });
    }
  }
`;
it("imports linked docs, isolates the preview, and saves its source and edited brand for one signed-in owner", async () => {
  const app = await workerdHarness(entry);
  try {
    let pages = 0, docs = 0, linkedGuides = 0;
    await app.restart(
      {
        SUPPORT_SELF_SERVE_SETUP_ENABLED: "true",
        SUPPORT_TRIAL_AI_PRACTICE_ENABLED: "true",
        MANAGED_AGENT_ENABLED: "true",
        MANAGED_AGENT_GATEWAY_ID: "local-test",
        MANAGED_AGENT_SPEND_CAP_USD_CENTS: "50000",
        SUPPORT_HOSTED_PAGE_ENABLED: "true",
        RELEASED_FEATURES: JSON.stringify([
          "hostedSupportPage",
          "managedAgent",
          "supportSingleConversation",
        ]),
      },
      async (request) => {
        const url = new URL(request.url);
        if (url.hostname === "cloudflare-dns.com")
          return Response.json({
            Answer:
              url.searchParams.get("type") === "A"
                ? [{ type: 1, data: "93.184.216.34" }]
                : [],
          });
        if (url.href === "https://garden.tools/") {
          pages++;
          return new Response(
            '<html><head><title>Gardening tools</title><meta property="og:site_name" content="Garden"><meta name="theme-color" content="#abc"><link rel="icon" href="/icon.svg"></head><body><main>Track your plants. <a href="/en/reference#start"><span>Documentation</span></a><a href="/en/reference#more">Documentation</a><a href="https://another.tools/about">Docs</a><a href="https://garden.gitbook.io/secrets?token=private">Docs</a><a href="https://garden.gitbook.io/manual" aria-label="User guide">Help</a></main></body></html>',
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.href === "https://garden.tools/en/reference") {
          docs++;
          return new Response("<main><h2>How do I export my journal?</h2><p>Members can export a garden journal from the settings page.</p></main>", { headers: { "content-type": "text/html" } });
        }
        if (url.href === "https://garden.gitbook.io/manual") {
          linkedGuides++;
          return new Response("<main>Garden members can record a planting date for each plant.</main>", { headers: { "content-type": "text/html" } });
        }
        if (url.href === "https://garden.tools/icon.svg")
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>',
            { headers: { "content-type": "image/svg+xml" } },
          );
        throw Error("Unexpected outbound request");
      },
    );
    const site = "http://garden.tools";
    const start = await app.call("/onboarding/start", undefined, { site });
    expect((await app.call("/onboarding/start", undefined, {site:"https://community.usetempl.com/"})).status).toBe(400);
    const cookie = start.headers.get("set-cookie")?.split(";")[0];
    const preview = await data(start);
    expect(cookie).toBeTruthy();
    expect(preview).toMatchObject({
      site: "https://garden.tools/",
      ready: true,
      suggestion: "How do I export my journal?",
      brand: {
        name: "Garden",
        accent: "#aabbcc",
        logo: "https://garden.tools/icon.svg",
      },
      remaining: PRODUCT_LIMITS.freeAiPracticeQuestions,
    });
    expect(preview.icon).toMatch(/^data:image\/svg/);
    expect(preview).not.toHaveProperty("room");
    const headers = { Cookie: cookie! };
    expect(
      await data(await app.call("/onboarding/read", undefined, {})),
    ).toBeNull();
    const brand = {
      ...preview.brand,
      previewId: preview.previewId,
      name: "Garden Help",
      accent: "#023481",
    };
    expect(
      (await app.call("/onboarding/confirm", undefined, brand)).status,
    ).toBe(410);
    expect(
      (
        await app.call("/onboarding/confirm", undefined, brand, {
          ...headers,
          Origin: "https://other.tools",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.call(
          "/onboarding/confirm",
          undefined,
          { ...brand, previewId: crypto.randomUUID() },
          headers,
        )
      ).status,
    ).toBe(409);
    await data(
      await app.call("/onboarding/confirm", undefined, brand, headers),
    );
    expect(
      (await app.call("/onboarding/claim", undefined, {}, headers)).status,
    ).toBe(401);
    const question = {
      question: "Where can members export a garden journal?",
      requestId: crypto.randomUUID(),
      previewId: preview.previewId,
    };
    expect(
      await data(
        await app.call("/onboarding/ask", undefined, question, headers),
      ),
    ).toEqual({
      remaining: PRODUCT_LIMITS.freeAiPracticeQuestions - 1,
      answer: "Members can export a garden journal from the settings page.",
    });
    expect(
      (await app.call("/onboarding/ask", undefined, question, headers)).status,
    ).toBe(409);
    expect(
      await data(await app.call("/onboarding/read", undefined, {}, headers)),
    ).toMatchObject({ remaining: PRODUCT_LIMITS.freeAiPracticeQuestions - 1 });
    const owner = await app.signIn(),
      other = await app.signIn();
    const claim = (actor: typeof owner) =>
      app.call(
        "/onboarding/claim",
        actor,
        { previewId: preview.previewId },
        { Cookie: actor.cookie + "; " + cookie },
      );
    const { id } = await data(await claim(owner));
    expect(await data(await claim(owner))).toEqual({ id });
    expect((await claim(other)).status).toBe(409);
    expect(
      (await app.call("/onboarding/confirm", undefined, brand, headers)).status,
    ).toBe(409);
    expect(await data(await app.call("/rooms/" + id, owner))).toMatchObject({
      name: "Garden Help",
    });
    expect(
      await data(await app.call("/rooms/" + id + "/widget", owner)),
    ).toMatchObject({ appearance: { accent: brand.accent, logo: brand.logo } });
    const sources = await data(await app.call("/rooms/" + id + "/conversations/knowledge", owner));
    expect(sources.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://garden.tools/", status: "ready" }),
      expect.objectContaining({ url: "https://garden.tools/en/reference", status: "ready" }),
      expect.objectContaining({ url: "https://garden.gitbook.io/manual", status: "ready" }),
    ]));
    expect(sources.counts.sources).toBe(3);
    // Both the source and the charged practice attempt belong to the claimed room.
    const restored = await app.call(
      "/rooms/" + id + "/conversations/knowledge/practice",
      owner,
    );
    expect(await data(restored)).toMatchObject({
      remaining: PRODUCT_LIMITS.freeAiPracticeQuestions - 1,
    });
    const billing = await app.call(
      "/rooms/" + id + "/product",
      undefined,
      undefined,
      headers,
    );
    expect([401, 403]).toContain(billing.status);
    expect(pages).toBe(1);
    expect(docs).toBe(1);
    expect(linkedGuides).toBe(1);
  } finally {
    await app.dispose();
  }
}, 90_000);
