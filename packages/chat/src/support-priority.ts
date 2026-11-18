import type { ProfileContract, ProfileRef } from "./protocol-profile";
import type { TeamConversation } from "./index";
import type { SupportHandoffReason } from "./support";

export type PrioritySettings = {
  topHolderUsd: number;
  largeHolderUsd: number;
  replyTargetMinutes: number;
  contracts: ProfileRef[];
};

export const PRIORITY_DEFAULTS: Readonly<PrioritySettings> = {
  topHolderUsd: 100_000,
  largeHolderUsd: 10_000,
  replyTargetMinutes: 15,
  contracts: [],
};
export const PRIORITY_CACHE_MS = 6 * 60 * 60 * 1_000;
export const PRIORITY_CONTRACT_LIMIT = 16;

export type PriorityPosition = {
  wallet: { network: string; address: string };
  usd: number | null;
  asOf: string;
  state: "ready" | "unavailable";
  estimated: boolean;
};

export type PriorityTier = "Top depositor" | "Large depositor";
export type PriorityCase = {
  thread: string;
  caseSeq: number;
  score: number;
  reasons: string[];
  position?: PriorityPosition;
  tier?: PriorityTier;
  claimedWallet: boolean;
  conversation?: TeamConversation;
};
export type PriorityFeed = {
  cases: PriorityCase[];
  settings: PrioritySettings;
};

export const PRIORITY_COPY = {
  title: "Priorities",
  empty: "No cases need your team.",
  verified: "Verified",
  claimed: "Claimed, not verified",
  verifyAction: "Ask to verify wallet",
  topHolder: "Top depositor",
  largeHolder: "Large depositor",
  reopened: "Reopened",
  repeat: "Repeat contact",
  transaction: "Transaction failed",
  safety: "Safety check",
  person: "Asked for a person",
  settings: "Priority settings",
  topThreshold: "Top deposits USD",
  largeThreshold: "Large deposits USD",
  replyTarget: "Reply target minutes",
  contracts: "Deposit contracts",
} as const;

export const PRIORITY_HANDOFF_LABELS: Readonly<
  Record<SupportHandoffReason, string>
> = {
  quote: "Quote request",
  privacy: "Privacy request",
  account: "Account help",
  billing: "Billing help",
  legal: "Legal request",
  safety: PRIORITY_COPY.safety,
  transaction: PRIORITY_COPY.transaction,
  bug: "App issue",
  person: PRIORITY_COPY.person,
  unsure: "AI needs help",
  other: "Team help",
  strategy: "Position help",
  access: "Access help",
  recovery: "Recovery help",
  decision: "Team decision",
  internal: "Team details needed",
};

/** A manager chooses deposit contracts from this customer's app profile. */
export function priorityDepositAdapter(
  entry: Pick<
    ProfileContract,
    "network" | "address" | "kind" | "conversion" | "underlying"
  >,
): "erc4626" | "one-to-one" | null {
  if (
    !["vault", "receipt-token", "staking"].includes(entry.kind) ||
    !entry.underlying ||
    entry.underlying.network !== entry.network ||
    entry.underlying.address === entry.address
  )
    return null;
  if (entry.conversion === "one-to-one") return "one-to-one";
  if (entry.conversion === "erc4626" && entry.network !== "solana")
    return "erc4626";
  return null;
}
