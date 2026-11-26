import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityApiError } from "@/lib/community-client";

// A stand-in with only the parts of the published widget that practice touches.
const widget = vi.hoisted(() => ({
  fetch: undefined as typeof fetch | undefined,
  workspace: "",
  submitted: [] as string[],
}));
vi.mock("@/lib/templ-support", () => ({
  loadTemplSupportWidget: async () => ({
    createSupportClient(
      options: { workspace: string },
      runtime: { fetch: typeof fetch },
    ) {
      widget.fetch = runtime.fetch;
      widget.workspace = options.workspace;
      return { adopt() {} };
    },
    mountSupportWidget(options: { container: HTMLElement }) {
      const host = document.createElement("div");
      host.setAttribute("data-templ-support", "");
      const root = host.attachShadow({ mode: "open" });
      const panel = document.createElement("section");
      panel.className = "panel";
      const titles = document.createElement("div");
      titles.className = "titles";
      titles.append(document.createElement("strong"));
      const form = document.createElement("form");
      form.className = "form";
      const draft = document.createElement("textarea");
      const send = document.createElement("button");
      send.className = "send";
      send.type = "submit";
      form.append(draft, send);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        widget.submitted.push(draft.value);
      });
      panel.append(titles, form);
      root.append(panel);
      options.container.append(host);
      return {
        open: async () => {},
        destroy: () => host.remove(),
        setAppearance() {},
        setQuestion(text: string) {
          draft.value = text;
        },
      };
    },
  }),
}));
import { WebsitePracticeChat } from "./website-practice-chat";

type Props = Parameters<typeof WebsitePracticeChat>[0];
const suggestion = "How do I export my journal?";
const shadow = () =>
  document.querySelector("[data-templ-support]")!.shadowRoot!;
const composer = () => shadow().querySelector("textarea")!;
const chip = () => screen.queryByRole("button", { name: "Send test question" });
function chatProps(changes: Partial<Props> = {}): Props {
  return {
    name: "Garden",
    icon: "",
    canSend: true,
    suggestion,
    ask: vi.fn(async () => "From the settings page."),
    ...changes,
  };
}
async function mount(props: Props) {
  const view = render(<WebsitePracticeChat {...props} />);
  await waitFor(() => expect(composer()).toBeTruthy());
  return view;
}
// The widget posts each send to its transport with the message's retry ID.
const post = (text: string, clientId: string) =>
  act(() =>
    widget.fetch!(
      "https://preview.invalid/widget/" +
        widget.workspace +
        "/conversations/ask",
      { method: "POST", body: JSON.stringify({ text, clientId }) },
    ),
  );

afterEach(() => {
  widget.fetch = undefined;
  widget.submitted.length = 0;
});

it("sends nothing while the visitor writes and holds a send until the preview is ready", async () => {
  const props = chatProps({ canSend: false });
  const view = await mount(props);
  const send = shadow().querySelector(".send")!;
  await waitFor(() => expect(send.getAttribute("aria-disabled")).toBe("true"));
  composer().value = "How do I export?";
  fireEvent.input(composer());
  shadow().querySelector("form")!.requestSubmit();
  expect(widget.submitted).toEqual([]);
  expect(props.ask).not.toHaveBeenCalled();
  expect(chip()).toBeNull();

  view.rerender(<WebsitePracticeChat {...props} canSend />);
  await waitFor(() => expect(send.getAttribute("aria-disabled")).toBe("false"));
  shadow().querySelector("form")!.requestSubmit();
  expect(widget.submitted).toEqual(["How do I export?"]);
  // A written question hides the suggestion, so a click cannot replace it.
  expect(chip()).toBeNull();
});

it("sends the suggested question once", async () => {
  await mount(chatProps());
  const send = await screen.findByRole("button", { name: "Send test question" });
  expect(document.getElementById(send.getAttribute("aria-describedby")!)?.textContent).toBe(suggestion);
  fireEvent.click(send);
  expect(widget.submitted).toEqual([suggestion]);
  expect(chip()).toBeNull();
});

it("gives a retried message one request ID and lets the widget delete a refused secret", async () => {
  const ask = vi.fn<Props["ask"]>();
  await mount(chatProps({ ask }));
  ask.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(post("Where is export?", "client-1")).rejects.toThrow(
    TypeError,
  );
  ask.mockResolvedValueOnce("From the settings page.");
  expect((await post("Where is export?", "client-1")).status).toBe(200);
  expect(ask.mock.calls[1]?.slice(0, 2)).toEqual(ask.mock.calls[0]?.slice(0, 2));
  // A delivered message is acknowledged again without another question.
  expect((await post("Where is export?", "client-1")).status).toBe(200);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(chip()).toBeNull();

  const refusal =
    "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone.";
  ask.mockRejectedValueOnce(
    new CommunityApiError(refusal, 422, {
      error: refusal,
      reason: "secret-refused",
    }),
  );
  const refused = await post("A synthetic refused draft.", "client-2");
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({
    error: refusal,
    reason: "secret-refused",
  });
  ask.mockRejectedValueOnce(
    new CommunityApiError("You’ve used your free AI questions.", 409, {
      reason: "trial-ai-practice",
    }),
  );
  const spent = await post("One more question.", "client-3");
  expect(spent.status).toBe(409);
  expect(await spent.json()).toEqual({
    error: "You’ve used your free AI questions.",
  });
});

it("brings an unsent question back after the website changes", async () => {
  const draft = { current: "" };
  const first = await mount(chatProps({ draft, canSend: false }));
  composer().value = "How do I export?";
  fireEvent.input(composer());
  expect(draft.current).toBe("How do I export?");
  first.unmount();

  await mount(chatProps({ draft }));
  await waitFor(() => expect(composer().value).toBe("How do I export?"));
  expect(chip()).toBeNull();
  await post("How do I export?", "client-4");
  expect(draft.current).toBe("");
});

it.each(["answered", "failed"])("acknowledges delivery while the AI is still working (%s)", async (outcome) => {
  let accept!: () => void;
  let finish!: () => void;
  const answer = new Promise<string>((resolve, reject) => {
    finish = () => outcome === "answered"
      ? resolve("Open the settings page.")
      : reject(new CommunityApiError("AI could not finish.", 503));
  });
  const ask = vi.fn<Props["ask"]>((_text, _id, received) => {
    accept = received;
    return answer;
  });
  await mount(chatProps({ ask }));
  const base = "https://preview.invalid/widget/" + widget.workspace + "/conversations/";
  const send = () => widget.fetch!(base + "ask", {
    method: "POST", body: JSON.stringify({ text: suggestion, clientId: "same-question" }),
  });
  let delivered = false;
  const [first, duplicate] = [send(), send()];
  void first.then(() => { delivered = true; });
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(delivered).toBe(false);
  accept();
  const receipt = await (await first).json();
  expect(await (await duplicate).json()).toEqual(receipt);
  expect(receipt.message.text).toBe(suggestion);
  expect(receipt.conversation.aiReplyExpected).toBe(true);

  const read = widget.fetch!(base + receipt.conversation.id + "/messages", { method: "GET" });
  finish();
  const history = await (await read).json();
  expect(history.messages.map((m: { text: string }) => m.text)).toEqual(
    outcome === "answered" ? [suggestion, "Open the settings page."] : [suggestion],
  );
  expect(history.conversation.aiReplyExpected).toBe(outcome === "answered");
  expect((await (await send()).json()).message).toEqual(receipt.message);
  expect(ask).toHaveBeenCalledTimes(1);
  if (outcome === "failed") {
    let next!: (value: string) => void;
    ask.mockImplementationOnce((_text, _id, received) => {
      received();
      return new Promise(resolve => { next = resolve; });
    });
    await widget.fetch!(base + receipt.conversation.id + "/messages", {
      method: "POST", body: JSON.stringify({ text: "Try a new question", clientId: "another" }),
    });
    const refreshed = await widget.fetch!(base + receipt.conversation.id + "/messages", { method: "GET" });
    expect((await refreshed.json()).conversation.aiReplyExpected).toBe(true);
    next("Here is the answer.");
  }
});
