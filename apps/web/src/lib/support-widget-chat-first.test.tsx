import { simulate } from "@templ/chat/simulation.test.helpers";
import { expect } from "vitest";
import { extras, type TailHost } from "./support-widget";

function fixture(chatFirst: boolean) {
  const host = {
    options: { chatFirst },
    policy: { chatFirst },
    style: document.createElement("style"),
    draft: document.createElement("textarea"),
    client: { session: { level: "anonymous" } },
    el: (tag: string, text?: string, className?: string) => Object.assign(
      document.createElement(tag), { textContent: text ?? "", className: className ?? "" },
    ),
  } as unknown as TailHost;
  return { host };
}

simulate("a guest sees the human review line only for an open recorded technical handoff, even without an AI message", draw => {
  const message = { id: "1", author: "visitor", text: "My wallet keeps disconnecting.", createdAt: new Date().toISOString() };
  for (const chatFirst of [false, true]) {
    for (const scenario of draw.shuffle(["technical", "ordinary", "unpaged", "closed"])) {
      const { host } = fixture(chatFirst);
      host.own = author => author === message.author;
      host.notice = { at: Date.now(), line: "" };
      const handoff = scenario === "unpaged" ? null : {
        at: message.createdAt, by: "agent" as const, ...(scenario === "ordinary" ? {} : { technical: true as const }),
      };
      const rows = extras.tail(host, [message], null, { state: scenario === "closed" ? "resolved" : "open", handoff },
        {}, "thread", false, true, undefined, true);
      const line = rows.find(([key]) => key === "~technical");
      expect(!!line).toBe(scenario === "technical");
      if (line) {
        const node = document.createElement("div");
        line[2](node);
        expect(node.textContent).toBe("A human support operator will see your message and answer you shortly.");
      }
    }
  }
});
