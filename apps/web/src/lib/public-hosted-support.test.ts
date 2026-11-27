import { simulate } from "@templ/chat/simulation.test.helpers";
import { expect, vi } from "vitest";
import { readWorkspaceSetup } from "../components/workspace/workspace-reads";
import { SITE } from "./site-environment";
import { installPrompt } from "./support-integration-prompt";
import { hostedSupportUrl, supportPageWorkspace } from "./support-page-config";
import { memberConversationsPath } from "./support-widget-conversations";

simulate(
  "a team sets up its chat, shares the link and reopens its member history",
  async (draw) => {
    const hex = (length: number) => draw.text("0123456789abcdef", length);
    const id = [
      hex(8),
      hex(4),
      "7" + hex(3),
      draw.pick(["8", "9", "a", "b"]) + hex(3),
      hex(12),
    ].join("-");
    const hosts = draw.shuffle([
      "https://usetempl.com",
      "https://support.example",
    ]);
    let saved = false;
    let available = false;
    const reads: string[] = [];
    const api = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        reads.push(path);
        if (path.endsWith("/widget"))
          return Response.json({
            origins: [],
            hostedPage: saved,
            options: { hostedPage: available },
          });
        if (path.endsWith("/moderation"))
          return Response.json({ moderators: [] });
        if (path.endsWith("/conversations/report"))
          return Response.json({ report: { requests: 1 } });
        throw new Error("Unexpected setup read " + path);
      });
    try {
      for (const enableFirst of draw.shuffle([false, true])) {
        for (const change of [
          "reset",
          enableFirst ? "enable" : "save",
          enableFirst ? "save" : "enable",
          "disable",
        ] as const) {
          if (change === "reset") {
            saved = false;
            available = false;
          }
          if (change === "save") saved = true;
          if (change === "enable") available = true;
          if (change === "disable") available = false;
          reads.length = 0;
          const setup = await readWorkspaceSetup(`room:${id}`, true);
          expect(setup.hostedPage).toBe(saved && available);
          expect(
            reads.some((path) => path.endsWith(`/rooms/${id}/widget`)),
          ).toBe(true);
          if (!setup.hostedPage) continue;
          for (const origin of hosts) {
            const link = new URL(hostedSupportUrl(origin, id));
            expect(link.origin).toBe(origin);
            expect(link.pathname).toBe("/help/" + id);
            expect(
              installPrompt({
                release: {},
                workspaceId: id,
                hosts: { ...SITE, origin },
              }),
            ).toContain(link.href);
            expect(
              supportPageWorkspace(link.pathname.slice("/help/".length)),
            ).toBe(id);
            expect(supportPageWorkspace("example-team")).toBeNull();
            for (const cursor of [
              undefined,
              hex(8) + "&view=team",
              hex(6) + "+/?=",
            ]) {
              const page = new URL(memberConversationsPath(cursor), origin);
              expect(page.pathname).toBe("/conversations");
              expect(page.searchParams.getAll("view")).toEqual(["member"]);
              expect(page.searchParams.get("filter")).toBe("all");
              expect(page.searchParams.get("cursor")).toBe(cursor ?? null);
            }
          }
        }
      }
    } finally {
      api.mockRestore();
    }
  },
);
