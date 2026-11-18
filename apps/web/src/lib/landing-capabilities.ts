import {
  capability,
  type CapabilityId,
  type ReleaseFlags,
} from "@templ/chat/availability";
import { BUILD_RELEASE } from "./release-public";
import {
  landingFeatures,
  plannedCapabilities,
  type LandingFeature,
  type LandingFeatures,
} from "./landing-preview";
import {
  widgetSignInNetworks,
  WIDGET_WALLET_SUPPORT,
  capabilityVerified,
} from "./support-availability";

/** The release record fields this list reads, beyond the shared model's. */
export type LandingRelease = ReleaseFlags & {
  supportWidgetVerified?: boolean;
  cardBillingVerified?: boolean;
};
/** The support constants this list reads. Tests pass their own. */
export type SupportFacts = {
  widgetWalletSupport: string;
  notificationsVerified: boolean;
  widgetSignInNetworks: readonly string[];
};
export function supportFacts(release: object): SupportFacts {
  return {
    widgetWalletSupport: WIDGET_WALLET_SUPPORT,
    notificationsVerified: capabilityVerified(
      "SUPPORT_NOTIFICATIONS_VERIFIED",
      release,
    ),
    widgetSignInNetworks: widgetSignInNetworks(release),
  };
}

/** Where a row's state comes from: a release flag, a row of the shared
 * capability model, a constant in support-availability.ts, or a planned
 * capability from landing-preview.ts. */
export type LandingEvidence =
  | {
      kind: "release";
      key:
        | "supportWidgetVerified"
        | "mediaStorageVerified"
        | "cardBillingVerified";
    }
  | { kind: "capability"; id: CapabilityId }
  | { kind: "constant"; name: keyof SupportFacts }
  | { kind: "planned"; feature: LandingFeature };
/** The part of Templ a row belongs to. "What works today" groups the rows
 * that work by area, in this order. */
export const LANDING_AREAS = [
  "widget",
  "inbox",
  "ai",
  "alerts",
  "billing",
] as const;
export type LandingArea = (typeof LANDING_AREAS)[number];
export type LandingCapability = {
  id: string;
  label: string;
  area: LandingArea;
  live: boolean;
  evidence: LandingEvidence;
};
type LandingRow = LandingCapability & {
  /** PRODUCT.md records the decision, so the row may wait under "Not yet".
   * A row for a decision it doesn't record appears only once it is live. */
  listedBeforeLive: boolean;
};

/** The availability page's "Live now" list. Each row is computed from its
 * evidence; no row is set by hand, so a feature reads as working only after
 * its release flag or constant says so. The local preview turns on planned
 * capabilities only, never a release flag. */
export function landingCapabilities(
  release: LandingRelease = BUILD_RELEASE as unknown as LandingRelease,
  facts: SupportFacts = supportFacts(release),
  features: LandingFeatures = landingFeatures(
    undefined,
    plannedCapabilities(release),
  ),
): LandingCapability[] {
  const available = (id: CapabilityId) =>
    capability(release, id).public === "available";
  const planned = (
    id: string,
    label: string,
    area: LandingArea,
    feature: LandingFeature,
    listedBeforeLive: boolean,
  ): LandingRow => ({
    id,
    label,
    area,
    live: features[feature] === true,
    evidence: { kind: "planned", feature },
    listedBeforeLive,
  });
  // Rows run area by area, so each area's rows keep this order.
  const rows: LandingRow[] = [
    {
      id: "widget",
      label: "Chat widget in your app, with or without a wallet sign-in",
      area: "widget",
      live: release.supportWidgetVerified === true,
      evidence: { kind: "release", key: "supportWidgetVerified" },
      listedBeforeLive: true,
    },
    {
      id: "smart-wallets",
      label: "Smart-wallet sign-in in the widget",
      area: "widget",
      live: facts.widgetWalletSupport !== "eoa-only",
      evidence: { kind: "constant", name: "widgetWalletSupport" },
      listedBeforeLive: true,
    },
    {
      id: "solana-widget",
      label: "Solana wallet sign-in in the widget",
      area: "widget",
      live: facts.widgetSignInNetworks.includes("solana"),
      evidence: { kind: "constant", name: "widgetSignInNetworks" },
      listedBeforeLive: true,
    },
    {
      id: "inbox",
      label: "Private team inbox with assignments, notes and saved replies",
      area: "inbox",
      live: available("conversations.claims"),
      evidence: { kind: "capability", id: "conversations.claims" },
      listedBeforeLive: true,
    },
    planned(
      "follow-ups",
      "Follow-ups with an owner and a date the user sees",
      "inbox",
      "followUps",
      false,
    ),
    planned(
      "transaction-checks",
      "The inbox checks transactions on enabled networks and shows what happened",
      "inbox",
      "diagnosis",
      true,
    ),
    {
      id: "screenshots",
      label: "Screenshots in cases",
      area: "inbox",
      live: release.mediaStorageVerified === true,
      evidence: { kind: "release", key: "mediaStorageVerified" },
      listedBeforeLive: true,
    },
    {
      id: "ai-agent",
      label: "Connect your own AI agent",
      area: "ai",
      live: available("agents.sdk"),
      evidence: { kind: "capability", id: "agents.sdk" },
      listedBeforeLive: true,
    },
    planned(
      "ai-mode",
      "Choose whether AI answers, only drafts or stays off in each case",
      "ai",
      "aiMode",
      false,
    ),
    planned(
      "ai-drafts",
      "AI drafts your team approves before they’re sent",
      "ai",
      "askAi",
      false,
    ),
    planned(
      "evidence-check",
      "AI answers wait for your review when their numbers or dates don’t match your records",
      "ai",
      "evidence",
      false,
    ),
    {
      id: "email-alerts",
      label: "New-case alerts by email",
      area: "alerts",
      live: facts.notificationsVerified === true,
      evidence: { kind: "constant", name: "notificationsVerified" },
      listedBeforeLive: true,
    },
    planned(
      "team-channel-alerts",
      "New-case alerts in Slack, Discord or a webhook",
      "alerts",
      "teamAlerts",
      true,
    ),
    planned(
      "telegram-alerts",
      "New-case alerts in Telegram",
      "alerts",
      "telegramAlerts",
      false,
    ),
    {
      id: "card-billing",
      label: "Pay for resolved cases by monthly card invoice",
      area: "billing",
      live: capabilityVerified("CARD_BILLING_VERIFIED", release),
      evidence: { kind: "release", key: "cardBillingVerified" },
      listedBeforeLive: true,
    },
  ];
  return rows
    .filter((row) => row.live || row.listedBeforeLive)
    .map(({ id, label, area, live, evidence }) => ({
      id,
      label,
      area,
      live,
      evidence,
    }));
}
