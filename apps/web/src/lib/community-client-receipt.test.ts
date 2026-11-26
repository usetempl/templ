import { afterEach, expect, it, vi } from "vitest";
import { communityFetch } from "./community-client";

const receivedType = "application/vnd.templ.received+json";
afterEach(() => vi.unstubAllGlobals());

it("announces an accepted practice send before reading its answer", async () => {
  let finish!: () => void;
  const bytes = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.encode(" "));
      finish = () => {
        controller.enqueue(bytes.encode(JSON.stringify({ answer: "Open settings.", remaining: 4 })));
        controller.close();
      };
    },
  });
  vi.stubGlobal("fetch", async () => new Response(body, { headers: { "Content-Type": receivedType } }));
  const received = vi.fn();
  const result = communityFetch("/onboarding/ask", {}, undefined, received);
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  finish();
  expect(await result).toEqual({ answer: "Open settings.", remaining: 4 });
});

it.each([
  [200, receivedType, true],
  [429, "application/json", false],
])("keeps answer errors distinct from refused sends", async (status, contentType, accepted) => {
  const received = vi.fn();
  vi.stubGlobal("fetch", async () => Response.json(
    { error: "Please try later.", status: 429 },
    { status, headers: { "Content-Type": contentType } },
  ));
  await expect(communityFetch("/onboarding/ask", {}, undefined, received)).rejects.toMatchObject({
    message: "Please try later.", status: 429,
  });
  expect(received).toHaveBeenCalledTimes(accepted ? 1 : 0);
});
