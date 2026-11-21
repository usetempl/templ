import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import TrustPage from "./page";

vi.mock("@/lib/config", () => ({
  getRelease: async () => ({ solana: { signIn: true } }),
}));

it("renders the approved reader and key-custody paragraph verbatim", async () => {
  const opening = "Templ’s servers process Standard chat messages.";
  const approved = [
    opening,
    "In a customer-controlled encrypted chat, approved endpoints use the workspace’s keys to read messages.",
    "The customer controls its recovery keys and backups.",
    "For Templ’s own encrypted support, Templ operates the team and recovery service.",
    "An authorized AI endpoint can share permitted content with its model provider.",
    "With AI off, agents cannot read or work on the case.",
    "Earlier messages keep their original protection.",
  ].join(" ");

  const page = document.createElement("div");
  page.innerHTML = renderToStaticMarkup(await TrustPage());
  const paragraph = Array.from(page.querySelectorAll("p")).find((p) =>
    p.textContent?.startsWith(opening),
  );
  expect(paragraph?.textContent).toBe(approved);
});
