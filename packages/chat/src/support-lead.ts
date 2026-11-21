import type { WidgetWallet } from "./widget-wallet";

export const SUPPORT_LEAD_CHAIN_LABELS = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
  bnb: "BNB Chain",
  avalanche: "Avalanche",
  "other-evm": "Other EVM",
  solana: "Solana",
} as const;
export const SUPPORT_LEAD_VOLUME_LABELS = {
  "under-100": "Under 100",
  "100-499": "100 to 499",
  "500-1999": "500 to 1,999",
  "2000-plus": "2,000 or more",
  unknown: "Not sure",
} as const;
export const SUPPORT_LEAD_WALLET_LABELS = {
  wagmi: "wagmi",
  rainbowkit: "RainbowKit",
  connectkit: "ConnectKit",
  reown: "Reown",
  privy: "Privy",
  dynamic: "Dynamic",
  "solana-wallet-adapter": "Solana wallet-adapter",
  other: "Other",
} as const;
export type SupportLeadChain = keyof typeof SUPPORT_LEAD_CHAIN_LABELS;
export type SupportLeadVolume = keyof typeof SUPPORT_LEAD_VOLUME_LABELS;
export type SupportLeadWalletStack = keyof typeof SUPPORT_LEAD_WALLET_LABELS;
export type SupportQualifiedLead = {
  appUrl: string;
  chains: SupportLeadChain[];
  monthlyVolume: SupportLeadVolume;
  walletStack: SupportLeadWalletStack[];
};
export type SupportLeadInput =
  | ({ kind: "qualified" } & SupportQualifiedLead)
  | { kind: "email"; email: string }
  | { kind: "wallet" };
/** Contact details stay in Templ's own thread and confer no account authority. */
export type SupportLead = {
  email?: string;
  wallet?: WidgetWallet;
  qualified?: SupportQualifiedLead;
  submittedAt: string;
};
export const SUPPORT_LEAD_LIMITS = {
  appUrl: 500,
  email: 254,
  chains: 9,
  walletStack: 8,
} as const;
export class SupportLeadError extends Error {}
function fail(message: string): never {
  throw new SupportLeadError(message);
}
function pickList<T extends string>(
  value: unknown,
  labels: Record<T, string>,
  max: number,
): T[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !Object.prototype.hasOwnProperty.call(labels, entry),
    )
  )
    fail("Choose the listed options.");
  return [...new Set(value as T[])];
}
/** Every field is bounded and checked before the room accepts a member write. */
export function parseSupportLeadInput(value: unknown): SupportLeadInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Check your app details.");
  const input = value as Record<string, unknown>;
  const keys =
    input.kind === "qualified"
      ? ["kind", "appUrl", "chains", "monthlyVolume", "walletStack"]
      : input.kind === "email"
        ? ["kind", "email"]
        : input.kind === "wallet"
          ? ["kind"]
          : [];
  if (!keys.length || Object.keys(input).some((key) => !keys.includes(key)))
    fail("Check your app details.");
  if (input.kind === "wallet") return { kind: "wallet" };
  if (input.kind === "email") {
    if (
      typeof input.email !== "string" ||
      input.email.length > SUPPORT_LEAD_LIMITS.email ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(input.email)
    )
      fail("Enter a valid email.");
    return { kind: "email", email: input.email };
  }
  if (
    typeof input.appUrl !== "string" ||
    !input.appUrl.length ||
    input.appUrl.length > SUPPORT_LEAD_LIMITS.appUrl ||
    // eslint-disable-next-line no-control-regex -- Reject controls before the URL parser strips them.
    /[\u0000-\u0020\u007f]/.test(input.appUrl)
  )
    fail("Enter your app's http or https URL.");
  let url: URL;
  try {
    url = new URL(input.appUrl);
  } catch {
    return fail("Enter your app's http or https URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    fail("Enter your app's http or https URL.");
  if (
    typeof input.monthlyVolume !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      SUPPORT_LEAD_VOLUME_LABELS,
      input.monthlyVolume,
    )
  )
    fail("Choose your monthly case count.");
  return {
    kind: "qualified",
    appUrl: input.appUrl,
    chains: pickList(
      input.chains,
      SUPPORT_LEAD_CHAIN_LABELS,
      SUPPORT_LEAD_LIMITS.chains,
    ),
    monthlyVolume: input.monthlyVolume as SupportLeadVolume,
    walletStack: pickList(
      input.walletStack,
      SUPPORT_LEAD_WALLET_LABELS,
      SUPPORT_LEAD_LIMITS.walletStack,
    ),
  };
}
