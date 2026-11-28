import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import TrustPage from "./page";

const release = vi.hoisted(() => ({ solana: { signIn: true }, bitcoinAccountSignInVerified: false }));
vi.mock("@/lib/config", () => ({ getRelease: async () => release }));

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

it("shows the approved wallet wording as each capability becomes available", async () => {
  const approvedWording = {
    "chatWalletProof": "In chat, you can sign a message to show support that you control a wallet address. This does not sign you in to Templ or send a transaction.",
    "bitcoinAccountSignIn": "To sign in with Bitcoin, use the sign-in button and approve a separate message in your wallet."
  };
  for (const enabled of [false, true, false]) {
    release.bitcoinAccountSignInVerified = enabled;
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(await TrustPage());
    const lines = Array.from(page.querySelectorAll("#never li"), (li) => li.textContent);
    expect(lines).toContain(approvedWording.chatWalletProof);
    expect(lines.includes(approvedWording.bitcoinAccountSignIn)).toBe(enabled);
    expect(lines).not.toContain("The widget asks your wallet only to connect and sign in.");
  }
});
