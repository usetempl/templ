import { expect, it, vi } from "vitest";
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
        // The test holds, fails or counts a model call by the question's wording.
        if (input.question?.includes("while the model waits")) await fetch("https://model.fixture/wait");
        if (input.question?.includes("when the model fails")) throw Error("Model fixture failure");
        if (input.answer) await fetch("https://model.fixture/checked");
        const hit = input.passages.find(p => p.text.includes("export a garden journal"));
        if (!hit) throw Error("Missing the linked guide");
        const answer = {
          action: "reply", confidence: "high", handoffReason: null, facts: [], claims: [], comparisons: [],
          sources: [hit.sourceId], text: input.answer ? "Supported." : "Members can export a garden journal from the settings page.",
          summary: "The guide covers this."
        };
        return { model: "gpt-6.1-terra", status: "completed", usage: { input_tokens: 100, output_tokens: 10,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] };
      } } });
    }
  }
`;
/** One held model call: `entered` once the call is running, `open` to let it answer. */
function modelGate() {
  let open = () => {}, enter = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  return { open, enter, opened, entered };
}
const RECEIPT = "application/vnd.templ.received+json";
const decoder = new TextDecoder();
async function rest(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}
const waiting = () => new Promise((done) => setTimeout(done, 400, "waiting"));
const bindings = {
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
};
/** The fixture website, plus the model fixture's held call and its count of checked answers. */
function fixtures() {
  const f = {
    pages: 0,
    docs: 0,
    linkedGuides: 0,
    checked: 0,
    model: modelGate(),
    async outbound(request: Request) {
      const url = new URL(request.url);
      if (url.href === "https://model.fixture/wait") {
        const held = f.model;
        held.enter();
        await held.opened;
        return new Response("ok");
      }
      if (url.href === "https://model.fixture/checked") {
        f.checked++;
        return new Response("ok");
      }
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({
          Answer:
            url.searchParams.get("type") === "A"
              ? [{ type: 1, data: "93.184.216.34" }]
              : [],
        });
      if (url.href === "https://garden.tools/") {
        f.pages++;
        return new Response(
          '<html><head><title>Gardening tools</title><meta name="theme-color" content="#abc"></head><body><main>Track your plants. <a href="/en/reference#start"><span>Documentation</span></a><a href="/en/reference#more">Documentation</a><a href="https://another.tools/about">Docs</a><a href="https://garden.gitbook.io/secrets?token=private">Docs</a><a href="https://garden.gitbook.io/manual" aria-label="User guide">Help</a></main><div hidden><meta property="og:site_name" content="Garden"><link rel="icon" href="/icon.svg"></div></body></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.href === "https://garden.tools/en/reference") {
        f.docs++;
        return new Response("<main><h2>How do I export my journal?</h2><p>Members can export a garden journal from the settings page.</p></main>", { headers: { "content-type": "text/html" } });
      }
      if (url.href === "https://garden.gitbook.io/manual") {
        f.linkedGuides++;
        return new Response("<main>Garden members can record a planting date for each plant.</main>", { headers: { "content-type": "text/html" } });
      }
      if (url.href === "https://garden.tools/icon.svg")
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      throw Error("Unexpected outbound request");
    },
  };
  return f;
}
it("imports linked docs, isolates the preview, and saves its source and edited brand for one signed-in owner", async () => {
  const app = await workerdHarness(entry);
  try {
    const f = fixtures();
    await app.restart(bindings, f.outbound);
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
    ).toMatchObject({
      appearance: { accent: brand.accent, logo: brand.logo },
      minimumLevel: "anyone",
      walletIdentification: { enabled: true, evm: true, solana: true },
    });
    const optedOut = { enabled: false, evm: true, solana: false };
    await data(await app.call("/rooms/" + id + "/widget", owner, { confirmed: true, walletIdentification: optedOut }));
    expect(await data(await claim(owner))).toEqual({ id });
    expect(await data(await app.call("/rooms/" + id + "/widget", owner))).toMatchObject({ walletIdentification: optedOut });
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
    expect(f.pages).toBe(1);
    expect(f.docs).toBe(1);
    expect(f.linkedGuides).toBe(1);
  } finally {
    await app.dispose();
  }
}, 90_000);

it.each([false, true])("streams each practice receipt and checks its private report (reports %s)", async (reports) => {
  const app = await workerdHarness(entry);
  try {
    const f = fixtures();
    await app.restart({ ...bindings, SUPPORT_QUALITY_ENABLED: "true", SUPPORT_PREVIEW_ANSWER_REPORTS_ENABLED: String(reports) }, f.outbound);
    const limit = PRODUCT_LIMITS.freeAiPracticeQuestions;
    const answer = "Members can export a garden journal from the settings page.";
    const start = await app.call("/onboarding/start", undefined, { site: "http://garden.tools" });
    const headers = { Cookie: start.headers.get("set-cookie")!.split(";")[0] };
    const preview = await data(start);
    await data(
      await app.call(
        "/onboarding/confirm",
        undefined,
        { ...preview.brand, previewId: preview.previewId },
        headers,
      ),
    );
    const ask = (question: string, requestId: string, receipt?: boolean) =>
      app.call(
        "/onboarding/ask",
        undefined,
        { question, requestId, previewId: preview.previewId, receipt },
        headers,
      );
    const read = async () =>
      data(await app.call("/onboarding/read", undefined, {}, headers));
    const ordinary = async (response: Response, status: number) => {
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      return data(response, status);
    };

    // A caller that does not ask for a receipt waits for ordinary JSON.
    const plain = await ask("Where can members export a garden journal?", crypto.randomUUID());
    expect(await ordinary(plain, 200)).toEqual({ remaining: limit - 1, answer });
    expect(f.checked).toBe(1);

    // The response starts while the first model call is still running.
    const held = crypto.randomUUID();
    const question = "How can members export a garden journal while the model waits?";
    const delivered = await ask(question, held, true);
    expect(delivered.status).toBe(200);
    expect(delivered.headers.get("content-type")).toBe(RECEIPT);
    expect(delivered.headers.get("access-control-allow-origin")).toBe("https://templ.vip");
    const reader = delivered.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(" ");
    await f.model.entered;
    const result = rest(reader);
    expect(await Promise.race([result, waiting()])).toBe("waiting");
    // The preview's next step still waits for the answer, as it does without a receipt.
    const next = read();
    expect(await Promise.race([next, waiting()])).toBe("waiting");
    expect(f.checked).toBe(1);
    f.model.open();
    expect(JSON.parse(await result)).toEqual({ remaining: limit - 2, answer });
    const report = await app.call("/onboarding/report", undefined, { previewId: preview.previewId, requestId: held, reason: "The settings step is vague." }, headers);
    if (reports) expect(await data(report)).toMatchObject({ reported: true });
    else expect(report.status).toBe(404);
    expect(await next).toMatchObject({ remaining: limit - 2 });
    expect(f.checked).toBe(2);

    // Refusals before the reservation keep their JSON and status, and use no attempt.
    expect(await ordinary(await ask(question, held, true), 409)).toMatchObject({
      error: "This question was already submitted.",
    });
    expect(
      await ordinary(await ask("abandon ".repeat(11) + "about", crypto.randomUUID(), true), 422),
    ).toEqual({
      error: "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone.",
      reason: "secret-refused",
    });
    expect(
      await ordinary(await ask(question, "not-a-request", true), 400),
    ).toMatchObject({ error: "Enter a product question of up to 800 characters." });
    expect(await read()).toMatchObject({ remaining: limit - 2 });

    // A failure after the reservation arrives in the delivered response.
    const failed = await ask(
      "Where can members export a garden journal when the model fails?",
      crypto.randomUUID(),
      true,
    );
    expect(failed.status).toBe(200);
    expect(failed.headers.get("content-type")).toBe(RECEIPT);
    expect(JSON.parse(await failed.text())).toEqual({
      error: "AI could not finish this practice question.",
      status: 503,
    });
    expect(await read()).toMatchObject({ remaining: limit - 3 });

    // The caller leaves after the receipt. The answer is still produced and checked.
    f.model = modelGate();
    const left = await ask(question, crypto.randomUUID(), true);
    expect(left.headers.get("content-type")).toBe(RECEIPT);
    await f.model.entered;
    await left.body!.cancel();
    f.model.open();
    await vi.waitFor(() => expect(f.checked).toBe(3), { timeout: 20_000 });
    expect(await read()).toMatchObject({ remaining: limit - 4 });
  } finally {
    await app.dispose();
  }
}, 90_000);
