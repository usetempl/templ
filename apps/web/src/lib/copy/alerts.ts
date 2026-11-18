import type {
  AlertLogOutcome,
  AlertPauseReason,
  AlertEscalationMinutes,
  AlertSubscribableEvent,
  AlertSummaryMinutes,
  SupportAlertDestination,
} from "@templ/chat/support-alerts";

/** Words for team alerts: the Settings section, the member's reply-email
 * page and the inbox. Checked against the no-ai-slop eval. */
export const KIND_NAMES: Record<SupportAlertDestination, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  webhook: "Webhook",
};
export const CHANNELS_INTRO = [
  "Post support alerts in Slack, Discord, Telegram or your own webhook.",
  "An alert has the event, counts, the wait time and a link.",
  "Alerts never include messages or notes.",
  "Wallets go only to a webhook you turn them on for.",
  "Opening the link asks for sign-in and checks access.",
] as const;
export const EVENT_LABELS: Record<AlertSubscribableEvent, string> = {
  "request.new": "New cases",
  "request.reopened": "Reopened cases",
  "request.handoff": "Handed to a person",
  "request.escalated": "Waiting past your target",
  "request.waiting": "Waiting summary",
  "follow-up.assigned": "Follow-up assigned",
  "follow-up.due": "Follow-up due soon",
  "follow-up.overdue": "Follow-up overdue",
  "follow-up.escalated": "Follow-up still overdue",
  "follow-up.update-missed": "Follow-up update missed",
  "follow-up.done": "Follow-up done",
  refusal: "Cases turned away",
  capacity: "Balance and billing",
  "member.reply_unseen": "User hasn't opened a reply",
};
export const SUMMARY_LABELS: Record<AlertSummaryMinutes, string> = {
  0: "Off",
  30: "Every 30 min",
  60: "Every hour",
};
export const ESCALATION_LABELS: Record<AlertEscalationMinutes, string> = {
  0: "Off",
  5: "5 min",
  15: "15 min",
  30: "30 min",
  60: "1 h",
  120: "2 h",
};
export const LOG_OUTCOMES: Record<AlertLogOutcome, string> = {
  delivered: "Delivered",
  retrying: "Retrying",
  failed: "Failed",
  expired: "Expired",
  skipped: "Skipped",
};
export function pauseReason(
  reason: AlertPauseReason | undefined,
  kind: SupportAlertDestination,
  since?: string | null,
): string {
  switch (reason) {
    case "manager-paused":
      return "Paused.";
    case "manager-changed":
      return "Paused because channel approval changed. An admin must check it before turning it on.";
    case "failing":
      return since
        ? `Paused after deliveries kept failing since ${new Date(since).toLocaleDateString()}.`
        : "Paused after deliveries kept failing.";
    case "provider-disabled":
      return `Paused because ${kind === "webhook" ? "the server" : KIND_NAMES[kind]} says this channel no longer accepts alerts.`;
    case "secret-unreadable":
      return "Paused because Templ can't read this channel's saved details. Remove it and add it again.";
    case "unreadable":
      return "Templ can't read this channel. Remove it and add it again.";
    case "unverified-expired":
      return "The code expired. Start again to send a new one.";
    default:
      return "Paused.";
  }
}
export const ALERTS_COPY = {
  sectionTitle: "Alerts",
  yourAlertsTitle: "Your alerts",
  yourAlertsDescription: "Email about cases that wait for the team. Only you get these.",
  emailToggle: "Email me when cases wait",
  addEmail: "Add an email in Account settings to get these.",
  emailUnavailable: "Email alerts aren't available yet.",
  emailOverflow: (n: number) =>
    `Email alerts weren't sent ${n} ${n === 1 ? "time" : "times"} today because too many were waiting.`,
  escalationTitle: "Escalation",
  escalationField: "Alert the team when a case waits longer than",
  escalationHint: [
    "Unassigned cases alert the whole team.",
    "Assigned cases alert the assignee, then the whole team at twice the time.",
  ],
  escalationConfirm: "I checked who gets these alerts.",
  escalationSave: "Save",
  escalationSaved: "Escalation saved.",
  channelsTitle: "Team channels",
  unavailable: "Team channel alerts aren't available yet.",
  add: "Add channel",
  kind: "Where",
  label: "Name",
  slackUrl: "Slack incoming webhook address",
  discordUrl: "Discord channel webhook address",
  webhookUrl: "Your server's https address",
  telegramHelp: "Create a bot with @BotFather for Templ alerts and add it to your team's group. Templ only posts. It never reads the group.",
  telegramToken: "Bot token",
  telegramChat: "Group chat id",
  telegramTopic: "Topic id",
  wallet: "Include the user's wallet and shared transactions",
  walletHint: "Only your server receives them. Slack, Discord and Telegram alerts never include wallets.",
  confirm: "I checked this channel. The people in it may see case counts and links.",
  create: "Connect",
  secretTitle: "Save this signing secret",
  secretBody: "Your server checks each alert with it. Templ shows it once.",
  secretSaved: "I saved it",
  codeTitle: "Enter the code Templ posted in the chat",
  verify: "Confirm",
  test: "Send test",
  testSent: "Test alert queued. It posts within a minute.",
  pause: "Pause",
  resume: "Turn on",
  resumeReview: (target: string) => `You're approving alerts to ${target}.`,
  rotate: "New signing secret",
  rotateReview: "Templ signs with both secrets for 24 hours. After that, only the new one works.",
  rotateConfirm: "My server will accept the new secret within 24 hours.",
  confirmAction: "Confirm",
  cancel: "Cancel",
  edit: "Edit",
  save: "Save",
  saved: "Channel saved.",
  events: "What it sends",
  chooseEvents: "Choose what it sends",
  summary: "Waiting summary",
  unseenNeedsWallet: "Needs wallet details on.",
  walletOnReview: "Your server will get each user's wallet and shared transactions.",
  log: "Delivery log",
  hideLog: "Hide log",
  remove: "Remove",
  removeConfirm: "Remove this channel and its delivery log?",
  lastDelivered: "Last delivered",
  sends: "Sends:",
  never: "Nothing delivered yet",
  overflow: (n: number) => `${n} ${n === 1 ? "alert wasn't" : "alerts weren't"} sent because too many were waiting.`,
  emptyLog: "No deliveries in the last 7 days.",
  error: "That didn't work. Try again.",
} as const;
export const MEMBER_PAGE = {
  title: (workspace: string) => `Get an email when ${workspace || "the team"} replies`,
  points: [
    "We send one email when the team replies and you haven't seen it.",
    "The email has a link and no message text.",
    "The team can't see your email address.",
  ],
  on: (masked: string) => `Email alerts are on for ${masked}.`,
  offLine: "Email alerts are off.",
  turnOn: "Turn on",
  turnOff: "Turn off",
  email: "Email address",
  sendCode: "Send code",
  code: "Code from the email",
  verify: "Confirm email",
  loading: "Checking your link…",
  expired: "This link expired. Open the chat and choose Email me when the team replies again.",
  noTicket: "Open this page from the chat. Choose Email me when the team replies.",
} as const;
export const escalationChipText = (minutes: number) => `Past your ${ESCALATION_LABELS[minutes as AlertEscalationMinutes] ?? `${minutes} min`} target`;
export const seenByMember = (age: string) => `Seen by the user ${age}`;
