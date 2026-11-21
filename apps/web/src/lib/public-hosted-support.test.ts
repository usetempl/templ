import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readWorkspaceSetup } from "../components/workspace/workspace-reads";
import { SITE } from "./site-environment";
import { installPrompt } from "./support-integration-prompt";
import { hostedSupportUrl, supportPageWorkspace } from "./support-page-config";
import { memberConversationsPath } from "./support-widget-conversations";

it("resolves a hosted page by workspace ID and rejects arbitrary names", () => {
  const uuid = randomUUID();
  const id = uuid.slice(0, 14) + "7" + uuid.slice(15);
  expect(supportPageWorkspace(id)).toBe(id);
  expect(supportPageWorkspace("example-team")).toBeNull();
  for (const origin of ["https://usetempl.com", "https://support.example"]) {
    const link = `${origin}/help/${id}`;
    expect(hostedSupportUrl(origin, id)).toBe(link);
    expect(
      installPrompt({
        release: {},
        workspaceId: id,
        hosts: { ...SITE, origin },
      }),
    ).toContain(link);
  }
});

it.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
])(
  "reports hosted setup for saved=%s, available=%s as %s",
  async (saved, available, expected) => {
    const api = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/widget")) {
          return Response.json({
            origins: [],
            hostedPage: saved,
            options: { hostedPage: available },
          });
        }
        if (path.endsWith("/moderation"))
          return Response.json({ moderators: [] });
        return Response.json({ report: { requests: 1 } });
      });
    try {
      const setup = await readWorkspaceSetup(`room:${randomUUID()}`, true);
      expect(setup.hostedPage).toBe(expected);
    } finally {
      api.mockRestore();
    }
  },
);

it("keeps the member view and encodes the pagination cursor", () => {
  const path = "/conversations?view=member&filter=all";
  expect(memberConversationsPath()).toBe(path);
  expect(memberConversationsPath("next&view=team")).toBe(
    path + "&cursor=next%26view%3Dteam",
  );
});
