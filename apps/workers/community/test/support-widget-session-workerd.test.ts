/** Guest resume after a reload and development
 * origins on this computer, through the production
 * worker in Workerd. A guest credential and a guest bearer stay with their
 * website and workspace; unlisted HTTPS websites can open the widget; an http
 * development origin works only while Templ allows them, gets member
 * authority only, and is never offered a remembered sign-in. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { workerdHarness, data, uuid, type Actor } from "./workerd-harness";

const origin = "https://app.protocol.example";
const second = "https://second.protocol.example";
const local = "http://localhost:5173";

describe.sequential("widget sessions in production Workerd", () => {
  let app: Awaited<ReturnType<typeof workerdHarness>>;
  let manager: Actor, workspace: string, other: string;
  let ip = 40;
  const call = (
    path: string,
    body?: object,
    headers: Record<string, string> = {},
    from = origin,
  ) =>
    app.call(path, undefined, body, {
      Origin: from,
      "CF-Connecting-IP": `203.0.113.${ip++ % 250}`,
      ...headers,
    });
  const refusals = async () =>
    JSON.stringify(
      await data(
        await app.call(`/rooms/${workspace}/conversations/refusals`, manager),
      ),
    );

  beforeAll(async () => {
    app = await workerdHarness(
      'export { default, CommunityRoom, AuthRecord, SubscriptionList, MediaQuota, SafetyStore, FeedbackStore } from "./worker";',
    );
    await app.restart({
      SUPPORT_WORKFLOW_ENABLED: "true",
      RELEASED_FEATURES: '["rememberSignIn"]',
      SUPPORT_WIDGET_REMEMBER: "true",
      WIDGET_REMEMBER_KEY: "55".repeat(32),
    });
    manager = await app.signIn();
    workspace = uuid();
    other = uuid();
    for (const id of [workspace, other]) {
      await data(
        await app.call("/rooms", manager, {
          id,
          name: "Session test",
          visibility: "public",
        }),
        201,
      );
      await data(
        await app.call(`/rooms/${id}/widget`, manager, {
          origins: [origin],
          confirmed: true,
        }),
      );
    }
  }, 30000);
  afterAll(async () => {
    await app?.dispose();
  });

  it("starts, sends and resumes a guest case on an unlisted HTTPS website with scoped credentials", async () => {
    const started = await data(
      await call(`/widget/${workspace}/auth/guest`, {}, {}, second),
    );
    const opened = await data(
      await call(
        `/widget/${workspace}/conversations/ask`,
        { text: "My withdrawal needs help.", clientId: uuid() },
        { Authorization: `Bearer ${started.token}` },
        second,
      ),
      201,
    );
    const path = `/rooms/${workspace}/conversations/${opened.conversation.id}/messages`;
    const team = await data(await app.call(path, manager));
    expect(team.messages.map((message: {text: string}) => message.text)).toContain("My withdrawal needs help.");
    await data(await app.call(path, manager, {text: "The team read your message.", replyIntent: "answer"}), 201);
    // Resumed on the same site: the same guest.
    const resumed = await data(
      await call(
        `/widget/${workspace}/auth/guest`,
        { credential: started.credential },
        {},
        second,
      ),
    );
    expect(resumed.principalId).toBe(started.principalId);
    const history = await data(
      await call(
        `/widget/${workspace}/conversations/${opened.conversation.id}/messages`,
        undefined,
        { Authorization: `Bearer ${resumed.token}` },
        second,
      ),
    );
    expect(history.messages[0].text).toBe("My withdrawal needs help.");
    expect(history.messages.map((message: {text: string}) => message.text))
      .toEqual(["My withdrawal needs help.", "The team read your message."]);
    // A valid second website or workspace grants no access to this guest.
    for (const [ws, from] of [
      [workspace, origin],
      [other, second],
    ] as const) {
      const refused = await call(
        `/widget/${ws}/auth/guest`,
        { credential: started.credential },
        {},
        from,
      );
      expect(refused.status).toBe(401);
      expect((await refused.json()).reason).toBe("guest-expired");
    }
    const bearer = { Authorization: `Bearer ${started.token}` };
    expect(
      (
        await call(
          `/widget/${workspace}/conversations/status`,
          undefined,
          bearer,
          origin,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          `/widget/${other}/conversations/status`,
          undefined,
          bearer,
          second,
        )
      ).status,
    ).toBe(401);
  });

  it("keeps guest resume available when the saved website list changes", async () => {
    const started = await data(
      await call(`/widget/${workspace}/auth/guest`, {}, {}, second),
    );
    await data(
      await app.call(`/rooms/${workspace}/widget`, manager, {
        origins: [],
        confirmed: true,
      }),
    );
    const resumed = await data(
      await call(
        `/widget/${workspace}/auth/guest`,
        { credential: started.credential },
        {},
        second,
      ),
    );
    expect(resumed.principalId).toBe(started.principalId);
    await data(
      await app.call(`/rooms/${workspace}/widget`, manager, {
        origins: [origin],
        confirmed: true,
      }),
    );
  });

  it("accepts unlisted HTTPS policy reads without recording origin refusals", async () => {
    const before = await refusals();
    const unlisted = "https://unlisted.example";
    expect(
      (
        await call(
          `/widget/${workspace}/auth/policy?bg=1`,
          undefined,
          {},
          unlisted,
        )
      ).status,
    ).toBe(200);
    expect(await refusals()).toEqual(before);
    expect(
      (await call(`/widget/${workspace}/auth/policy`, undefined, {}, unlisted))
        .status,
    ).toBe(200);
    expect(await refusals()).toEqual(before);
  });

  it("accepts a public workspace ID before any websites or widget settings are saved", async () => {
    const fresh = uuid();
    await data(
      await app.call("/rooms", manager, {
        id: fresh,
        name: "Fresh workspace",
        visibility: "public",
      }),
      201,
    );
    expect(
      (await call(`/widget/${fresh}/auth/policy`, undefined, {}, second))
        .status,
    ).toBe(200);
    const guest = await data(
      await call(`/widget/${fresh}/auth/guest`, {}, {}, second),
    );
    const asked = await data(
      await call(
        `/widget/${fresh}/conversations/ask`,
        { text: "Is support available?", clientId: uuid() },
        { Authorization: `Bearer ${guest.token}` },
        second,
      ),
      201,
    );
    expect(asked.conversation.id).toMatch(/^tc-[0-9a-f]{32}$/);
  });

  it.each([
    "",
    "null",
    "not an origin",
    "http://app.protocol.example",
    "https://app.protocol.example/",
    "https://app.protocol.example/path",
    "https://app.protocol.example?secret=value",
    "https://app.protocol.example#section",
    "https://user:pass@app.protocol.example",
    "https://localhost:5173",
  ])(
    "refuses an invalid or gated origin without CORS permission: %s",
    async (from) => {
      for (const path of ["/auth/policy", "/auth/guest", "/auth/nonce"]) {
        const response = await call(
          `/widget/${workspace}${path}`,
          path === "/auth/policy" ? undefined : {},
          {},
          from,
        );
        expect(response.status).toBe(403);
        expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
      }
    },
  );

  it("refuses a missing Origin header and a nonexistent workspace", async () => {
    const missing = await app.fetch(
      `https://community.templ.vip/widget/${workspace}/auth/policy`,
    );
    expect(missing.status).toBe(403);
    expect(missing.headers.has("Access-Control-Allow-Origin")).toBe(false);
    const unknown = await call(`/widget/${uuid()}/auth/guest`, {}, {}, second);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("requires private workspace membership after the manager opens widget settings", async () => {
    const privateWorkspace = uuid();
    await data(
      await app.call("/rooms", manager, {
        id: privateWorkspace,
        name: "Private workspace",
        visibility: "private",
      }),
      201,
    );
    await data(await app.call(`/rooms/${privateWorkspace}/widget`, manager));
    const guest = await data(await call(`/widget/${privateWorkspace}/auth/guest`, {}, {}, second));
    const refused = await call(
      `/widget/${privateWorkspace}/conversations/ask`,
      { text: "Please open a case.", clientId: uuid() },
      { Authorization: `Bearer ${guest.token}` },
      second,
    );
    expect(refused.status).toBe(404);
    expect(
      (
        await data(
          await app.call(`/rooms/${privateWorkspace}/conversations`, manager),
        )
      ).conversations,
    ).toEqual([]);
    await app.restart({
      SUPPORT_WIDGET_SOLANA_ENABLED: "true",
      RELEASED_FEATURES: '["rememberSignIn","solanaSignIn"]',
    });
    try {
      const member = await app.signIn();
      const invitation = await data(await app.call(`/rooms/${privateWorkspace}/invites`, manager, {}), 201);
      await data(await app.call(`/rooms/${privateWorkspace}/invites/accept`, member, { secret: invitation.secret }));
      const signed = await app.widgetSession(member, privateWorkspace, second);
      const opened = await data(await signed.call("/conversations/ask", { text: "My invited case.", clientId: uuid() }), 201);
      expect(opened.conversation.member).toBe(member.principalId);
      expect((await data(await signed.call(`/conversations/${opened.conversation.id}/messages`))).messages[0].text).toBe("My invited case.");
    } finally {
      await app.restart({
        SUPPORT_WIDGET_SOLANA_ENABLED: "false",
        RELEASED_FEATURES: '["rememberSignIn"]',
      });
    }
  }, 15_000);

  it("refuses http development origins while Templ doesn't allow them", async () => {
    const saved = await app.call(`/rooms/${workspace}/widget`, manager, {
      origins: [origin, local],
      confirmed: true,
    });
    expect(saved.status).toBe(400);
    expect(
      (await call(`/widget/${workspace}/auth/policy`, undefined, {}, local))
        .status,
    ).toBe(403);
  });

  it("allows an unsaved development origin through its gate with member authority only", async () => {
    await app.restart({
      SUPPORT_WIDGET_LOOPBACK: "true",
      CONTACT_ADMIN_PRINCIPALS: manager.principalId,
    });
    expect(
      (
        await app.call(`/rooms/${workspace}/widget`, manager, {
          origins: [origin, local],
          confirmed: true,
        })
      ).status,
    ).toBe(400);
    await data(
      await app.call("/operator/flags", manager, {
        workspace,
        key: "loopbackOrigins",
        on: true,
        until: new Date(Date.now() + 60_000).toISOString(),
        reason: "Test the approved localhost origin",
      }),
    );
    const saved = await data(
      await app.call(`/rooms/${workspace}/widget`, manager, {
        origins: [origin],
        confirmed: true,
      }),
    );
    expect(saved.origins).not.toContain(local);
    expect(saved.options.loopback).toBe(true);
    // A plain http site stays refused.
    expect(
      (
        await app.call(`/rooms/${workspace}/widget`, manager, {
          origins: ["http://app.protocol.example"],
          confirmed: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(`/widget/${workspace}/auth/policy`, undefined, {}, local))
        .status,
    ).toBe(200);
    const account = privateKeyToAccount(generatePrivateKey());
    const proof = await data(
      await call(
        `/widget/${workspace}/auth/nonce`,
        { address: account.address, chainId: 1, remember: true },
        {},
        local,
      ),
    );
    // The SIWE text names the http site, and offers no 30-day line here.
    expect(proof.message.startsWith("http://localhost:5173 wants you")).toBe(
      true,
    );
    expect(proof.message).not.toContain("30 days");
    const signed = await data(
      await call(
        `/widget/${workspace}/auth/verify`,
        {
          ...proof,
          signature: await account.signMessage({ message: proof.message }),
        },
        {},
        local,
      ),
    );
    expect(signed.remember).toBeUndefined();
    const bearer = { Authorization: `Bearer ${signed.token}` };
    for (const path of ["/widget", "/roles", "/product"])
      expect(
        (await call(`/widget/${workspace}${path}`, undefined, bearer, local))
          .status,
      ).toBe(404);
    expect(
      (
        await data(
          await call(
            `/widget/${workspace}/conversations/status`,
            undefined,
            bearer,
            local,
          ),
        )
      ).team,
    ).toBe(false);
    // Turning development origins off refuses the stored one at once.
    await app.restart({ SUPPORT_WIDGET_LOOPBACK: "false" });
    expect(
      (
        await call(
          `/widget/${workspace}/conversations/status`,
          undefined,
          bearer,
          local,
        )
      ).status,
    ).toBe(403);
  }, 60_000);
});
