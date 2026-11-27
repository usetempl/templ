import type {
  ProductChargeState,
  ProductChargeView,
  ProductDisputeReason,
  ProductFinanceEmailView,
  ProductMonthActivity,
  ProductStatement,
} from "@templ/chat/product-catalog";
import type {
  ProductPaymentIntent,
  ProductRailId,
  ProductPaymentReceipt,
} from "@templ/chat/product-payment";
import type { ChatRoomId } from "@templ/chat/index";
import type { MonthlySupportPlan } from "@templ/chat/standard-plan";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { COMMUNITY_API, communityFetch, roomPath } from "./community-client";
import { chatMutation } from "./chat-api";
import type { ProductView } from "./product-offer";

export type ProductUsage = ProductView & {
  features?: Partial<
    Record<import("@templ/chat/workspace-flags").WorkspaceFlagKey, boolean>
  >;
};
export function readProduct(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<ProductUsage> {
  return communityFetch(roomPath(room, "product"), undefined, signal);
}
export function prepareProductPayment(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  input: {
    rail: ProductRailId;
    usdCents: number;
    payer: string;
    purpose?: "standard-period" | "standard-annual" | "standard-credit";
    monthlyPlan?: MonthlySupportPlan;
    reviewedPriceVersion?: string;
    reviewedAiRateCardVersion?: string;
    expectedPeriod?: string | null;
    confirmed?: true;
  },
  assertCurrent?: () => void,
): Promise<{ intent: ProductPaymentIntent }> {
  return chatMutation(
    account,
    roomPath(room, "product/crypto/prepare"),
    input,
    assertCurrent,
  );
}
export function saveStarterAiLimit(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  input: { cents: number; expectedCents: number; expectedPeriod: string },
): Promise<{ cents: number }> {
  return chatMutation(account, roomPath(room, "product/starter-ai-limit"), {
    ...input,
    confirmed: true,
  });
}
/** A verified receipt credits once; a transaction that doesn't match its
 * request goes to Templ's review instead. */
export type SettledProductPayment =
  | { receipt: ProductPaymentReceipt; intent?: ProductPaymentIntent }
  | { intent: ProductPaymentIntent; receipt?: ProductPaymentReceipt }
  | { unmatched: { txHash: string; message: string } };
export function submitProductReceipt(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  input: { requestId: string; tx: string },
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<SettledProductPayment> {
  return chatMutation(
    account,
    roomPath(room, "product/crypto/receipt"),
    input,
    assertCurrent,
    signal,
  );
}
export function readProductPaymentRequests(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<{ requests: ProductPaymentIntent[] }> {
  return communityFetch(
    roomPath(room, "product/crypto/requests"),
    undefined,
    signal,
  );
}
export function refreshProductPaymentTransaction(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  requestId: string,
  assertCurrent?: () => void,
): Promise<{ intent: ProductPaymentIntent }> {
  return chatMutation(
    account,
    roomPath(room, "product/crypto/transaction"),
    { requestId },
    assertCurrent,
  );
}
export function checkProductPayment(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  requestId: string,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<{ intent: ProductPaymentIntent }> {
  return chatMutation(
    account,
    roomPath(room, "product/crypto/check"),
    { requestId },
    assertCurrent,
    signal,
  );
}
export function readProductReceipts(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<{ receipts: ProductPaymentReceipt[] }> {
  return communityFetch(roomPath(room, "product/receipts"), undefined, signal);
}
export type ChargePage = { charges: ProductChargeView[]; next: string | null };
export function readCharges(
  room: ChatRoomId,
  input: {
    state?: ProductChargeState | "billing-soon";
    cursor?: string | null;
  } = {},
  signal?: AbortSignal,
): Promise<ChargePage> {
  const query = new URLSearchParams();
  if (input.state) query.set("state", input.state);
  if (input.cursor) query.set("cursor", input.cursor);
  const suffix = query.size ? `?${query}` : "";
  return communityFetch(
    roomPath(room, `product/charges${suffix}`),
    undefined,
    signal,
  );
}
/** Disputes need a valid wallet session and the manager's confirmation,
 * like every other billing write. */
export function disputeCharge(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  input: { ref: string; reason: ProductDisputeReason; text: string | null },
  assertCurrent?: () => void,
): Promise<{
  dispute: {
    ref: string;
    status: "open" | "credited";
    reason: ProductDisputeReason;
  };
}> {
  return chatMutation(
    account,
    roomPath(room, `product/charges/${input.ref}/dispute`),
    { reason: input.reason, text: input.text, confirmed: true },
    assertCurrent,
  );
}
export function readBudget(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<{ budget: number | null }> {
  return communityFetch(roomPath(room, "product/budget"), undefined, signal);
}
export function saveBudget(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  cents: number | null,
  assertCurrent?: () => void,
): Promise<{ budget: number | null }> {
  return chatMutation(
    account,
    roomPath(room, "product/budget"),
    { cents, confirmed: true },
    assertCurrent,
  );
}
/** A month's statement as CSV text, for the Plan tab's download. */
export async function readStatementCsv(
  room: ChatRoomId,
  month: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    `${COMMUNITY_API}${roomPath(room, `product/statement?month=${month}&format=csv`)}`,
    { credentials: "include", signal },
  );
  if (!response.ok) throw new Error("The statement could not load. Try again.");
  return response.text();
}
/** A UTC month's cases from the case ledger: counts and times only. */
export function readActivity(
  room: ChatRoomId,
  month: string,
  signal?: AbortSignal,
): Promise<ProductMonthActivity> {
  return communityFetch(
    roomPath(room, `product/activity?month=${month}`),
    undefined,
    signal,
  );
}
/** A month's statement for the printable page. */
export function readStatement(
  room: ChatRoomId,
  month: string,
  signal?: AbortSignal,
): Promise<ProductStatement> {
  return communityFetch(
    roomPath(room, `product/statement?month=${month}`),
    undefined,
    signal,
  );
}
export function readFinanceEmail(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<{ financeEmail: ProductFinanceEmailView }> {
  return communityFetch(
    roomPath(room, "product/finance-email"),
    undefined,
    signal,
  );
}
/** Names the finance address (a code goes there) or removes it (`null`). */
export function saveFinanceEmail(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  email: string | null,
  assertCurrent?: () => void,
): Promise<{ financeEmail: ProductFinanceEmailView }> {
  return chatMutation(
    account,
    roomPath(room, "product/finance-email"),
    { email, confirmed: true },
    assertCurrent,
  );
}
export function verifyFinanceEmail(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  code: string,
  assertCurrent?: () => void,
): Promise<{ financeEmail: ProductFinanceEmailView }> {
  return chatMutation(
    account,
    roomPath(room, "product/finance-email/verify"),
    { code, confirmed: true },
    assertCurrent,
  );
}

export function readUsageCharges(
  room: ChatRoomId,
  input: { after?: string; month?: string } = {},
  signal?: AbortSignal,
): Promise<import("@templ/chat/usage-billing").ProductUsagePage> {
  const query = new URLSearchParams(input);
  return communityFetch(
    roomPath(room, `product/usage${query.size ? `?${query}` : ""}`),
    undefined,
    signal,
  );
}
