import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { CommunityApiError } from "@/lib/community-client";
import { simulate } from "@templ/chat/simulation.test.helpers";

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
import { WebsitePracticeChat } from "@/components/website-practice-chat";

type Props = Parameters<typeof WebsitePracticeChat>[0];
type History = {
  conversation: { id: string; aiReplyExpected: boolean };
  messages: { text: string }[];
};
const shadow = () =>
  document.querySelector("[data-templ-support]")!.shadowRoot!;
const composer = () => shadow().querySelector("textarea")!;
const sendButton = () => shadow().querySelector(".send")!;
const chip = () => screen.queryByRole("button", { name: "Send test question" });
async function mount(props: Props) {
  const view = render(<WebsitePracticeChat {...props} />);
  await waitFor(() => expect(composer()).toBeTruthy());
  return view;
}
const conversations = () =>
  "https://preview.invalid/widget/" + widget.workspace + "/conversations/";
// The widget posts each send to its transport with the message's retry ID.
const send = (text: string, clientId: string, route = "ask") =>
  widget.fetch!(conversations() + route, {
    method: "POST",
    body: JSON.stringify({ text, clientId }),
  });
const post = (text: string, clientId: string) =>
  act(() => send(text, clientId));
const read = async (thread: string): Promise<History> =>
  (
    await widget.fetch!(conversations() + thread + "/messages", {
      method: "GET",
    })
  ).json();
const texts = (history: History) =>
  history.messages.map((message) => message.text);

afterEach(() => {
  widget.fetch = undefined;
  widget.submitted.length = 0;
});

simulate(
  "sim:browser a visitor's practice questions wait for the preview, survive a website change and are delivered once each",
  async (draw) => {
    const [written, second, third, suggestion] = draw.shuffle([
      "How do I export?",
      "Where is my deposit?",
      "Can I change my plan?",
      "How do I export my journal?",
    ]);
    const id = () => `client-${draw.text("0123456789abcdef", 8)}`;
    const ask = vi.fn<Props["ask"]>();
    const draft = { current: "" };
    const props: Props = {
      name: "Garden",
      icon: "",
      canSend: false,
      suggestion,
      draft,
      ask,
    };

    const scanning = await mount(props);
    await waitFor(() =>
      expect(sendButton().getAttribute("aria-disabled")).toBe("true"),
    );
    composer().value = written;
    fireEvent.input(composer());
    shadow().querySelector("form")!.requestSubmit();
    expect(widget.submitted).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    expect(chip()).toBeNull();
    expect(draft.current).toBe(written);

    scanning.unmount();
    const ready = await mount(props);
    await waitFor(() => expect(composer().value).toBe(written));
    await waitFor(() =>
      expect(sendButton().getAttribute("aria-disabled")).toBe("true"),
    );
    shadow().querySelector("form")!.requestSubmit();
    expect(widget.submitted).toEqual([]);
    ready.rerender(<WebsitePracticeChat {...props} canSend />);
    await waitFor(() =>
      expect(sendButton().getAttribute("aria-disabled")).toBe("false"),
    );
    shadow().querySelector("form")!.requestSubmit();
    expect(widget.submitted).toEqual([written]);
    expect(chip()).toBeNull();

    // A retried message keeps one request ID, and a delivered one is not asked again.
    const first = id();
    ask.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(post(written, first)).rejects.toThrow(TypeError);
    expect(draft.current).toBe("");
    ask.mockResolvedValueOnce("From the settings page.");
    expect((await post(written, first)).status).toBe(200);
    expect(ask.mock.calls[1]?.slice(0, 2)).toEqual(
      ask.mock.calls[0]?.slice(0, 2),
    );
    expect((await post(written, first)).status).toBe(200);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(chip()).toBeNull();

    // The widget learns why a secret was refused, and nothing about trial limits.
    const refusal =
      "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone.";
    ask.mockRejectedValueOnce(
      new CommunityApiError(refusal, 422, {
        error: refusal,
        reason: "secret-refused",
      }),
    );
    const refused = await post("A synthetic refused draft.", id());
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
    const spent = await post("One more question.", id());
    expect(spent.status).toBe(409);
    expect(await spent.json()).toEqual({
      error: "You’ve used your free AI questions.",
    });

    // Delivery is acknowledged while the AI is still working, once for a repeated send.
    let accept!: () => void;
    let answer!: (text: string) => void;
    ask.mockImplementationOnce((_text, _id, received) => {
      accept = received;
      return new Promise<string>((resolve) => {
        answer = resolve;
      });
    });
    const answered = id();
    let delivered = false;
    const [sending, duplicate] = [send(second, answered), send(second, answered)];
    void sending.then(() => {
      delivered = true;
    });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(5));
    expect(delivered).toBe(false);
    accept();
    const receipt = await (await sending).json();
    expect(await (await duplicate).json()).toEqual(receipt);
    expect(receipt.message.text).toBe(second);
    expect(receipt.conversation.aiReplyExpected).toBe(true);
    const thread: string = receipt.conversation.id;
    const waiting = read(thread);
    answer("Open the settings page.");
    const history = await waiting;
    expect(texts(history)).toEqual([
      written,
      "From the settings page.",
      second,
      "Open the settings page.",
    ]);
    expect(history.conversation.aiReplyExpected).toBe(true);
    expect((await (await send(second, answered)).json()).message).toEqual(
      receipt.message,
    );
    expect(ask).toHaveBeenCalledTimes(5);

    let fail!: () => void;
    ask.mockImplementationOnce((_text, _id, received) => {
      accept = received;
      return new Promise<string>((_, reject) => {
        fail = () => reject(new CommunityApiError("AI could not finish.", 503));
      });
    });
    const failing = id();
    const unanswered = send(third, failing);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(6));
    accept();
    const kept = await (await unanswered).json();
    expect(kept.message.text).toBe(third);
    const stopped = read(thread);
    fail();
    const afterFailure = await stopped;
    expect(texts(afterFailure).slice(-2)).toEqual([
      "Open the settings page.",
      third,
    ]);
    expect(afterFailure.conversation.aiReplyExpected).toBe(false);
    expect((await (await send(third, failing)).json()).message).toEqual(
      kept.message,
    );
    expect(ask).toHaveBeenCalledTimes(6);
    ask.mockImplementationOnce((_text, _id, received) => {
      received();
      return new Promise<string>((resolve) => {
        answer = resolve;
      });
    });
    await send("Try a new question", id(), thread + "/messages");
    expect((await read(thread)).conversation.aiReplyExpected).toBe(true);
    answer("Here is the answer.");
    expect(texts(await read(thread)).at(-1)).toBe("Here is the answer.");

    ready.unmount();
    await mount({ ...props, canSend: true });
    const suggest = await screen.findByRole("button", {
      name: "Send test question",
    });
    expect(
      document.getElementById(suggest.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe(suggestion);
    fireEvent.click(suggest);
    expect(widget.submitted).toEqual([written, suggestion]);
    expect(chip()).toBeNull();
  },
);
