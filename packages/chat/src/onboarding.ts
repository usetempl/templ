import { ANALYTICS_SOURCES, type AnalyticsEvent } from "./analytics-events";
import { FUNNEL_STEPS, type FunnelStep } from "./funnel";
const owns = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const ONBOARDING_POLICY = {
  retentionDays: 90,
  browserLifetimeMs: 30 * 86_400_000,
  dropOffMs: 86_400_000,
  maxJourneysPerReport: 10_000,
  maxEventsPerBatch: 16,
} as const;
export const ONBOARDING_HEADER = "X-Templ-Onboarding";
export const JOURNEY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ONBOARDING_TRAFFIC = {
  customer: "Customers",
  unclassified: "Unclassified visitors",
  operator: "Operators",
  test: "Tests",
} as const;
export type OnboardingTraffic = keyof typeof ONBOARDING_TRAFFIC;
export const ONBOARDING_AUDIENCES = {
  public: "Customer funnel",
  ...ONBOARDING_TRAFFIC,
} as const;
export type OnboardingAudience = keyof typeof ONBOARDING_AUDIENCES;
export type OnboardingEventName = AnalyticsEvent | `server_${FunnelStep}`;
export type OnboardingEvent = {
  journey: string;
  name: OnboardingEventName;
  at: number;
  traffic: OnboardingTraffic;
};
export type OnboardingJourney = {
  startedAt: number;
  traffic: OnboardingTraffic;
  events: Partial<Record<OnboardingEventName, number>>;
};
export const ONBOARDING_STAGES = [
  { name: "onboarding_viewed", label: "Started onboarding" },
  { name: "prompt_copied", label: "Copied install prompt", optional: true },
  { name: "server_signed_in", label: "Signed in" },
  { name: "server_workspace_created", label: "Created workspace" },
  { name: "server_widget_seen", label: "Widget installed" },
  { name: "server_first_request", label: "First user case" },
  { name: "server_first_reply", label: "First team reply" },
  { name: "server_first_resolution", label: "First resolved case" },
] as const satisfies readonly {
  name: OnboardingEventName;
  label: string;
  optional?: boolean;
}[];

export function onboardingEventName(
  value: unknown,
): value is OnboardingEventName {
  return (
    typeof value === "string" &&
    (owns(ANALYTICS_SOURCES, value) ||
      (value.startsWith("server_") && owns(FUNNEL_STEPS, value.slice(7))))
  );
}
/** Only the service constructs timestamps, classifications and server milestones. */
export function browserOnboardingEvent(
  value: unknown,
): { journey: string; name: AnalyticsEvent } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  if (
    Object.keys(event).length !== 2 ||
    typeof event.journey !== "string" ||
    !JOURNEY_ID.test(event.journey) ||
    typeof event.name !== "string" ||
    !owns(ANALYTICS_SOURCES, event.name)
  )
    return;
  return { journey: event.journey, name: event.name as AnalyticsEvent };
}
export function validOnboardingEvent(value: unknown): value is OnboardingEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    Object.keys(event).length === 4 &&
    typeof event.journey === "string" &&
    JOURNEY_ID.test(event.journey) &&
    onboardingEventName(event.name) &&
    Number.isSafeInteger(event.at) &&
    (event.at as number) > 0 &&
    typeof event.traffic === "string" &&
    owns(ONBOARDING_TRAFFIC, event.traffic)
  );
}
/** Operator/test classification also covers events recorded before sign-in. */
export function mergeOnboardingTraffic(
  previous: OnboardingTraffic,
  next: OnboardingTraffic,
): OnboardingTraffic {
  const rank = { unclassified: 0, customer: 1, operator: 2, test: 3 };
  return rank[next] > rank[previous] ? next : previous;
}
export function addOnboardingEvent(
  previous: OnboardingJourney | undefined,
  event: OnboardingEvent,
): OnboardingJourney {
  const journey: OnboardingJourney = previous
    ? { ...previous, events: { ...previous.events } }
    : {
        startedAt: event.at,
        traffic: event.traffic,
        events: { onboarding_viewed: event.at },
      };
  journey.traffic = mergeOnboardingTraffic(journey.traffic, event.traffic);
  journey.startedAt = Math.min(journey.startedAt, event.at);
  journey.events.onboarding_viewed = journey.startedAt;
  journey.events[event.name] = Math.min(
    journey.events[event.name] ?? event.at,
    event.at,
  );
  return journey;
}
const median = (values: number[]) => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : Math.round((values[middle - 1] + values[middle]) / 2);
};
export type OnboardingReport = ReturnType<typeof onboardingReport>;
/** Cohorts use the journey's first observed day, never the milestone's day. */
export function onboardingReport(
  journeys: OnboardingJourney[],
  options: {
    from: string;
    to: string;
    now: number;
    traffic: OnboardingAudience;
    available: boolean;
    complete: boolean;
    collectedSince: number | null;
  },
) {
  const cohort = journeys.filter((journey) => {
    const day = new Date(journey.startedAt).toISOString().slice(0, 10);
    return day >= options.from && day <= options.to;
  });
  const selected = cohort.filter((journey) =>
    options.traffic === "public"
      ? journey.traffic === "customer" || journey.traffic === "unclassified"
      : journey.traffic === options.traffic,
  );
  const traffic = Object.fromEntries(
    Object.keys(ONBOARDING_TRAFFIC).map((kind) => [
      kind,
      cohort.filter((journey) => journey.traffic === kind).length,
    ]),
  ) as Record<OnboardingTraffic, number>;
  const signups = selected.filter(
    (journey) =>
      !journey.events.connect_workspace_selected ||
      journey.events.server_workspace_created,
  );
  const stages = ONBOARDING_STAGES.map((stage, index) => {
    const reached = signups.filter(
      (journey) => journey.events[stage.name] !== undefined,
    );
    const next = ONBOARDING_STAGES.slice(index + 1).find(
      (item) => !("optional" in item && item.optional),
    );
    let advanced = 0,
      waiting = 0,
      dropped = 0;
    const elapsed: number[] = [];
    for (const journey of reached) {
      if (!next) continue;
      const start = journey.events[stage.name]!;
      const end = journey.events[next.name];
      if (end !== undefined) {
        advanced++;
        if (end >= start) elapsed.push(end - start);
      } else if (options.now - start >= ONBOARDING_POLICY.dropOffMs) dropped++;
      else waiting++;
    }
    return {
      ...stage,
      reached: reached.length,
      next: next?.label ?? null,
      advanced,
      waiting,
      dropped,
      conversion: reached.length && next ? advanced / reached.length : null,
      medianNextMs: median(elapsed),
    };
  });
  const names = [
    ...Object.keys(ANALYTICS_SOURCES),
    ...Object.keys(FUNNEL_STEPS).map((name) => `server_${name}`),
  ] as OnboardingEventName[];
  const branches = (
    [
      ["connect_opened", "connect_completed", "Connect app"],
      ["sign_in_opened", "server_signed_in", "Sign in"],
      ["create_viewed", "server_workspace_created", "Create workspace"],
      ["workspace_prompt_copied", "server_widget_seen", "Install from prompt"],
      ["widget_snippet_copied", "server_widget_seen", "Install from snippet"],
      ["install_check_started", "install_check_completed", "Check install"],
      [
        "server_team_invite_created",
        "server_team_invite_accepted",
        "Invite teammate",
      ],
      ["brain_viewed", "brain_source_added", "Add AI source"],
      [
        "server_checkout_started",
        "server_payment_credited",
        "Complete payment",
      ],
    ] as const satisfies readonly (readonly [
      OnboardingEventName,
      OnboardingEventName,
      string,
    ])[]
  ).map(([name, next, label]) => {
    const reached = selected.filter(
      (journey) => journey.events[name] !== undefined,
    );
    const elapsed: number[] = [];
    let advanced = 0, waiting = 0,
      dropped = 0;
    for (const journey of reached) {
      const start = journey.events[name]!,
        end = journey.events[next];
      if (end !== undefined) { advanced++; if (end >= start) elapsed.push(end - start); }
      else if (options.now - start >= ONBOARDING_POLICY.dropOffMs) dropped++;
      else waiting++;
    }
    return {
      name,
      next,
      label,
      reached: reached.length,
      advanced,
      waiting,
      dropped,
      conversion: reached.length ? advanced / reached.length : null,
      medianNextMs: median(elapsed),
    };
  });
  const events = names.map((name) => {
    const times = selected.flatMap((journey) =>
      journey.events[name] === undefined
        ? []
        : [journey.events[name]! - journey.startedAt],
    );
    return { name, journeys: times.length, medianFromStartMs: median(times) };
  });
  const edges = new Map<
    string,
    { from: OnboardingEventName; to: OnboardingEventName; times: number[] }
  >();
  for (const journey of selected) {
    const ordered = (
      Object.entries(journey.events) as [OnboardingEventName, number][]
    ).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (let index = 1; index < ordered.length; index++) {
      const [from, at] = ordered[index - 1],
        [to, end] = ordered[index];
      const key = `${from}:${to}`,
        edge = edges.get(key) ?? { from, to, times: [] };
      edge.times.push(end - at);
      edges.set(key, edge);
    }
  }
  const transitions = [...edges.values()].map(({ from, to, times }) => ({
    from,
    to,
    journeys: times.length,
    medianMs: median(times),
  }));
  return {
    schemaVersion: 1 as const,
    ...options,
    journeys: selected.length,
    traffic,
    stages,
    branches,
    events,
    transitions,
  };
}
