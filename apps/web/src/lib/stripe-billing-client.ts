import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { chatMutation } from "./chat-api";
import { roomPath } from "./community-client";

/** Fixed worker reasons explain recovery without exposing provider error text. */
export function stripeBillingFailure(error: unknown): {
  cause: string;
  message: string;
} {
  const fallback = {
    cause: "request-failed",
    message: "The billing action failed. Try again.",
  };
  if (!error || typeof error !== "object") return fallback;
  const value = error as { status?: unknown; details?: unknown };
  if (
    value.status !== 409 ||
    !value.details ||
    typeof value.details !== "object"
  )
    return fallback;
  const reason = (value.details as { reason?: unknown }).reason;
  switch (reason) {
    case "stripe-owner-workspace-limit":
      return {
        cause: reason,
        message:
          "Your account already pays by card for another workspace. Ask its billing manager to choose Prepay with stablecoins. Wait until its card period ends.",
      };
    case "stripe-card-already-active":
      return {
        cause: reason,
        message:
          "Card billing is already on for this workspace. Use Manage card to change your card.",
      };
    case "stripe-setup-other-workspace":
      return {
        cause: reason,
        message:
          "Another workspace has card setup open. Finish that setup or wait for it to expire.",
      };
    case "stripe-setup-checking":
      return {
        cause: reason,
        message:
          "Stripe is checking your card setup. Refresh Plan to check again.",
      };
    case "stripe-retry-review":
      return {
        cause: reason,
        message:
          "Templ needs to check this billing request. Ask Templ through Talk to us.",
      };
    default:
      return fallback;
  }
}

/** Labels for the invoice state recorded by a signed Stripe webhook. */
export function stripeInvoiceStatus(status: string): string {
  return (
    (
      {
        draft: "Draft",
        open: "Waiting for payment",
        paid: "Paid",
        uncollectible: "Unpaid",
        payment_failed: "Unpaid",
        void: "Canceled",
      } as Record<string, string>
    )[status] ?? "Checking"
  );
}

/** Stripe handles card setup and card changes on its own pages. */
export function startCardSetup(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
) {
  return chatMutation<{ url: string }>(
    account,
    roomPath(room, "product/card/setup"),
    {
      confirmed: true,
    },
  );
}

export function openCardPortal(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
) {
  return chatMutation<{ url: string }>(
    account,
    roomPath(room, "product/card/portal"),
    {
      confirmed: true,
    },
  );
}

/** The current invoice keeps its cases until the card period ends. */
export function requestUsdcBilling(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
) {
  return chatMutation<{ cancelAtPeriodEnd: boolean }>(
    account,
    roomPath(room, "product/card/method"),
    {
      method: "usdc",
      confirmed: true,
    },
  );
}

/** Refuse a destination outside Stripe's hosted billing pages. */
export function stripeHostedUrl(
  value: string,
  kind: "setup" | "portal",
): string {
  const url = new URL(value);
  const hostname =
    kind === "setup" ? "checkout.stripe.com" : "billing.stripe.com";
  if (
    url.protocol !== "https:" ||
    url.hostname !== hostname ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("The Stripe page could not open. Try again.");
  return url.href;
}
