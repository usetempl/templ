import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { simulate } from "@templ/chat/simulation.test.helpers";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ChatSignInCanceledError } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";

type ChatProps = {
  name: string;
  icon: string;
  canSend: boolean;
  suggestion?: string;
  ask(question: string, requestId: string, onReceipt: () => void): Promise<string>;
};
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  signIn: vi.fn(),
  push: vi.fn(),
  answered: vi.fn(),
  failed: vi.fn(),
}));
vi.mock("@/lib/community-client", async (original) => ({
  ...(await original<typeof import("@/lib/community-client")>()),
  communityFetch: mocks.api,
}));
vi.mock("@/lib/chat-auth", () => ({
  useChatAuth: () => ({
    session: undefined,
    restoring: false,
    signIn: mocks.signIn,
  }),
}));
vi.mock("@/lib/release-context", () => ({ useRelease: () => ({}) }));
vi.mock("@/lib/release-public", () => ({
  workspaceCreationEnabled: () => true,
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("./website-practice-chat", () => ({
  WebsitePracticeChat: (props: ChatProps) => (
    <div
      data-testid="chat"
      data-name={props.name}
      data-icon={props.icon}
      data-can-send={String(props.canSend)}
    >
      <span data-testid="suggestion">{props.suggestion}</span>
      <button
        type="button"
        onClick={() =>
          void props
            .ask("Where can members export a journal?", "request-1", () => {})
            .then(mocks.answered, mocks.failed)
        }
      >
        Ask in chat
      </button>
    </div>
  ),
}));
import { WebsiteOnboarding } from "./website-onboarding";

type Body = Record<string, unknown>;
function api(routes: Record<string, (body: Body) => unknown>) {
  mocks.api.mockImplementation(async (path: string, body: Body) => {
    const route = routes[path.replace("/onboarding/", "")];
    if (!route) throw new Error("Unexpected request: " + path);
    return route(body);
  });
}
const calls = (op: string) =>
  mocks.api.mock.calls
    .filter(([path]) => path === "/onboarding/" + op)
    .map(([, body]) => body);
const garden = (changes: Body = {}) => ({
  previewId: "preview-1",
  site: "https://garden.tools/",
  brand: {
    name: "Garden",
    accent: "#aabbcc",
    logo: "https://garden.tools/icon.svg",
  },
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
  ready: true,
  suggestion: "How do I export my journal?",
  remaining: 25,
  confirmed: true,
  ...changes,
});
const chat = () => screen.getByTestId("chat").dataset;
const website = () => screen.getByLabelText("Your website") as HTMLInputElement;
function enterWebsite(value: string) {
  fireEvent.change(website(), { target: { value } });
  fireEvent.submit(website().closest("form")!);
}

beforeEach(() => {
  vi.resetAllMocks();
});

simulate("a visitor retries a failed scan and replaces a preview if its site differs", async draw => {
  const input = draw.pick(["garden.tools", "http://garden.tools", "https://garden.tools"]);
  let failures = draw.int(1, 2);
  const attempts = failures;
  const conflict = draw.chance(0.5);
  const expected: Body[] = [];
  api({
    read: () => null,
    start: body => {
      if (failures-- > 0) throw new SyntaxError("Unexpected token '<'");
      if (conflict && !body.restart)
        throw new CommunityApiError("Start a new preview to change websites.", 409);
      return garden({ confirmed: false });
    },
  });
  render(<WebsiteOnboarding nextPlan={false} />);
  for (let failure = 0; failure < attempts; failure++) {
    enterWebsite(input);
    expected.push({site: input, restart: false});
    expect((await screen.findByRole("alert")).textContent).toBe("Templ could not be reached. Try again.");
    expect(website().value).toBe(input);
    await waitFor(() => expect(document.activeElement).toBe(website()));
  }
  enterWebsite(input);
  expected.push({site: input, restart: false});
  if (conflict) expected.push({site: input, restart: true});
  expect(await screen.findByText("25 of 25 free questions left")).toBeTruthy();
  expect(calls("start")).toEqual(expected);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(chat().name).toBe("Garden");
  await waitFor(() => expect(chat().canSend).toBe("true"));
  expect(screen.getByTestId("suggestion").textContent).toBe("How do I export my journal?");
});

it("answers a question without applying unfinished appearance edits, then shows why the next one failed", async () => {
  let remaining = 25;
  let fails = false;
  api({
    read: () => garden({ remaining }),
    ask: () => {
      if (fails) {
        remaining = 23;
        throw new CommunityApiError(
          "AI could not finish this practice question.",
          503,
        );
      }
      remaining = 24;
      return {
        answer: "Members can export a garden journal from the settings page.",
        remaining,
      };
    },
  });
  render(<WebsiteOnboarding nextPlan={false} />);
  await screen.findByText("25 of 25 free questions left");
  const saveIndex = () => screen.getAllByRole("button").indexOf(screen.getByRole("button", { name: "Sign in to keep your workspace" }));
  const editIndex = () => screen.getAllByRole("button").indexOf(screen.getByRole("button", { name: "Apply changes" }));
  expect(saveIndex()).toBeGreaterThan(editIndex());
  fireEvent.change(screen.getByLabelText(/Icon URL/), {
    target: { value: "https://garden.tools/large.png" },
  });
  expect(chat().icon).toBe("");
  expect(screen.getByText("Apply changes to see this icon.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Ask in chat" }));
  await waitFor(() =>
    expect(mocks.answered).toHaveBeenCalledWith(
      "Members can export a garden journal from the settings page.",
    ),
  );
  expect(calls("confirm")).toEqual([]);
  expect(calls("ask")).toEqual([
    {
      question: "Where can members export a journal?",
      requestId: "request-1",
      receipt: true,
      previewId: "preview-1",
    },
  ]);
  expect(await screen.findByText("24 of 25 free questions left")).toBeTruthy();

  expect(saveIndex()).toBeLessThan(editIndex());

  fails = true;
  fireEvent.click(screen.getByRole("button", { name: "Ask in chat" }));
  await waitFor(() => expect(mocks.failed).toHaveBeenCalled());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "AI could not finish this practice question.",
  );
  expect(await screen.findByText("23 of 25 free questions left")).toBeTruthy();
});

it("applies appearance edits on request and reports a failed icon beside the fields", async () => {
  const logo = "https://garden.tools/large.png";
  const icon = "data:image/png;base64,iVBORw==";
  let loads = false;
  api({
    read: () => garden(),
    confirm: (body) => {
      if (!loads)
        throw new CommunityApiError(
          "That icon could not load. Try another image or leave it blank.",
          400,
        );
      return garden({
        brand: { name: body.name, accent: body.accent, logo: body.logo },
        icon,
      });
    },
  });
  render(<WebsiteOnboarding nextPlan={false} />);
  await screen.findByText("25 of 25 free questions left");
  const apply = () =>
    screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement;
  expect(apply().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Icon URL/), {
    target: { value: logo },
  });
  expect(apply().disabled).toBe(false);
  const form = apply().closest("form")!;

  fireEvent.submit(form);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "That icon could not load.",
  );
  expect(calls("ask")).toEqual([]);

  loads = true;
  fireEvent.submit(form);
  await waitFor(() => expect(chat().icon).toBe(icon));
  expect(calls("confirm").at(-1)).toEqual({
    name: "Garden",
    accent: "#aabbcc",
    logo,
    previewId: "preview-1",
  });
  await waitFor(() => expect(apply().disabled).toBe(true));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the fallback question about the website while the chat name changes", async () => {
  api({ read: () => garden({ suggestion: undefined }) });
  render(<WebsiteOnboarding nextPlan={false} />);
  await screen.findByText("25 of 25 free questions left");
  const name = screen.getByLabelText("Chat name");
  fireEvent.change(name, { target: { value: "Help" } });
  expect(chat().name).toBe("Help");
  expect(screen.getByTestId("suggestion").textContent).toBe(
    "What can I do with garden.tools?",
  );

  fireEvent.change(name, { target: { value: " " } });
  expect(screen.getByRole("alert").textContent).toBe("Enter a chat name.");
  expect(chat().canSend).toBe("false");
  const save = screen.getByRole("button", {
    name: "Sign in to keep your workspace",
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
});

it("keeps the preview after a dismissed sign-in and follows the service once an account holds it", async () => {
  let held = false;
  api({
    read: () => (held ? { claiming: true, previewId: "preview-1" } : garden()),
    claim: () => {
      held = true;
      throw new CommunityApiError(
        "Workspace setup could not finish. Try again.",
        503,
      );
    },
  });
  render(<WebsiteOnboarding nextPlan={false} />);
  await screen.findByText("25 of 25 free questions left");
  const save = () =>
    screen.getByRole("button", {
      name: "Sign in to keep your workspace",
    }) as HTMLButtonElement;

  mocks.signIn.mockRejectedValueOnce(new ChatSignInCanceledError());
  fireEvent.click(save());
  await waitFor(() => expect(mocks.signIn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(save().disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls("claim")).toEqual([]);
  expect(screen.getByText("25 of 25 free questions left")).toBeTruthy();

  mocks.signIn.mockResolvedValueOnce({ principalId: "wallet:owner" });
  fireEvent.click(save());
  expect(
    await screen.findByRole("heading", { name: "Save your workspace" }),
  ).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Workspace setup could not finish. Try again.",
  );
  expect(calls("claim")).toEqual([
    { previewId: "preview-1", expectedPrincipalId: "wallet:owner" },
  ]);
  expect(mocks.push).not.toHaveBeenCalled();

  const change = () =>
    screen.getByRole("button", { name: "Change website" }) as HTMLButtonElement;
  await waitFor(() => expect(change().disabled).toBe(false));
  fireEvent.click(change());
  expect(
    screen.getByRole("heading", { name: "Try Templ with your website" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("restores a confirmed wallet opt-out if sign-in needs to resume after reload", async () => {
  let wallets = true;
  api({
    read: () => garden({ visitorWallets: wallets }),
    confirm: body => {
      wallets = body.visitorWallets !== false;
      return garden({ visitorWallets: wallets });
    },
    claim: () => ({ id: "workspace-1" }),
  });
  const choice = () => screen.getByRole("checkbox", { name: "Let visitors verify a wallet in the saved chat" }) as HTMLInputElement;
  const save = () => screen.getByRole("button", { name: "Sign in to keep your workspace" });
  const first = render(<WebsiteOnboarding nextPlan={false} />);
  await screen.findByText("25 of 25 free questions left");
  fireEvent.click(choice());
  mocks.signIn.mockRejectedValueOnce(new ChatSignInCanceledError());
  fireEvent.click(save());
  await waitFor(() => expect(mocks.signIn).toHaveBeenCalledTimes(1));
  first.unmount();
  render(<WebsiteOnboarding nextPlan={false} />);
  await screen.findByText("25 of 25 free questions left");
  expect(choice().checked).toBe(false);
  mocks.signIn.mockResolvedValueOnce({ principalId: "wallet:owner" });
  fireEvent.click(save());
  await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());
  expect(calls("claim")).toEqual([{ previewId: "preview-1", expectedPrincipalId: "wallet:owner", visitorWallets: false }]);
});

it("confirms the shown appearance before sign-in and opens the saved workspace", async () => {
  api({
    read: () => garden({ confirmed: false }),
    confirm: body => garden({ visitorWallets: body.visitorWallets }),
    claim: () => ({ id: "workspace-1" }),
  });
  mocks.signIn.mockResolvedValue({ principalId: "wallet:owner" });
  render(<WebsiteOnboarding nextPlan />);
  await screen.findByText("25 of 25 free questions left");
  const wallets = screen.getByRole("checkbox", { name: "Let visitors verify a wallet in the saved chat" }) as HTMLInputElement;
  expect(wallets.checked).toBe(true);
  fireEvent.click(wallets);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in to keep your workspace" }),
  );
  await waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith("/inbox/workspace-1?tab=plan"),
  );
  expect(calls("claim")).toEqual([{ previewId: "preview-1", expectedPrincipalId: "wallet:owner", visitorWallets: false }]);
  expect(calls("confirm")).toEqual([
    {
      name: "Garden",
      visitorWallets: false,
      accent: "#aabbcc",
      logo: "https://garden.tools/icon.svg",
      previewId: "preview-1",
    },
  ]);
  expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
    "/onboarding/read",
    "/onboarding/confirm",
    "/onboarding/claim",
  ]);
});
