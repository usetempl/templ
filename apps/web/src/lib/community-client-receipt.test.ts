import { afterEach, expect, vi } from "vitest";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { communityFetch } from "./community-client";

const RECEIVED = "application/vnd.templ.received+json";
const bytes = new TextEncoder();
afterEach(() => vi.unstubAllGlobals());

simulate(
  "sim:unit practice sends are announced once when accepted, before their answers, and never when refused",
  async (draw) => {
    const replies: Response[] = [];
    vi.stubGlobal("fetch", async () => replies.shift()!);

    // Several accepted questions wait at once. Each answer arrives later, in pieces.
    const sends = Array.from({ length: draw.int(2, 4) }, (_, index) => {
      const failed = index === 1 || (index > 1 && draw.chance(0.3));
      const body = failed
        ? { error: "Please try later.", status: 429 }
        : { answer: `Open settings ${index}.`, remaining: draw.int(0, 9) };
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      replies.push(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(bytes.encode(" "));
            },
          }),
          {
            headers: {
              "Content-Type": RECEIVED + draw.pick(["", "; charset=utf-8"]),
            },
          },
        ),
      );
      const received = vi.fn();
      let settled = false;
      const result = communityFetch("/onboarding/ask", {}, undefined, received);
      result.then(
        () => (settled = true),
        () => (settled = true),
      );
      const finish = () => {
        const text = JSON.stringify(body);
        const cut = draw.int(1, text.length - 1);
        stream.enqueue(bytes.encode(text.slice(0, cut)));
        stream.enqueue(bytes.encode(text.slice(cut)));
        stream.close();
      };
      return { failed, body, received, result, finish, settled: () => settled };
    });
    await vi.waitFor(() => {
      for (const send of sends) expect(send.received).toHaveBeenCalledOnce();
    });
    expect(sends.map((send) => send.settled())).not.toContain(true);

    const waiting = new Set(sends);
    for (const send of draw.shuffle(sends)) {
      send.finish();
      // An answer that fails after acceptance keeps its own error and status.
      if (send.failed)
        await expect(send.result).rejects.toMatchObject({
          message: "Please try later.",
          status: 429,
        });
      else expect(await send.result).toEqual(send.body);
      waiting.delete(send);
      expect([...waiting].map((other) => other.settled())).not.toContain(true);
      expect(send.received).toHaveBeenCalledOnce();
    }

    // A refused send is never announced, whatever type the refusal claims.
    for (const status of draw.shuffle([400, 403, 429, 503])) {
      const received = vi.fn();
      const named = draw.chance(0.7);
      const wait = draw.pick(["30", "100000", "0", "soon", null]);
      replies.push(
        Response.json(named ? { error: "Please try later.", status: 429 } : {}, {
          status,
          headers: {
            "Content-Type": draw.pick(["application/json", RECEIVED]),
            ...(wait === null ? {} : { "Retry-After": wait }),
          },
        }),
      );
      await expect(
        communityFetch("/onboarding/ask", {}, undefined, received),
      ).rejects.toMatchObject({
        message: named ? "Please try later." : "The chat service is unavailable.",
        status,
        retryAfterSeconds:
          wait === "30" ? 30 : wait === "100000" ? 86_400 : null,
      });
      expect(received).not.toHaveBeenCalled();
    }

    // An ordinary answer needs no announcement.
    const received = vi.fn();
    replies.push(Response.json({ remaining: 3 }));
    expect(
      await communityFetch("/onboarding/ask", {}, undefined, received),
    ).toEqual({ remaining: 3 });
    expect(received).not.toHaveBeenCalled();
  },
);
