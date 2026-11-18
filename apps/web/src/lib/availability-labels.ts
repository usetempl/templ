import type { CapabilityState } from "@templ/chat/availability";

/** Plain words for each state of the shared capability model. */
export const STATE_LABELS: Record<CapabilityState, string> = {
  implemented: "Built, release checks pending",
  pinned: "Contract recorded, service checks pending",
  "hosted-verified": "Service checks passed, cost review pending",
  "economically-verified": "Cost review complete, final checks pending",
  available: "Available",
};
export const PUBLIC_LABELS = {
  available: "Available",
  "being-verified": "Being verified",
  "not-offered": "Not offered",
} as const;
