import type { ChatRoomId, TeamConversationFilter } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  detectKeySecret,
  detectKeySecretValue,
  hasRecoveryPhraseShape,
  solanaSecretCandidates,
} from "@templ/chat/support-safety-hex";
import {
  peekCommunitySession,
  subscribeCommunitySession,
} from "./community-auth";

const PREFIX = "templ:support-workspace-draft:v1:";
const MAX_AGE = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 50;
type Stored = {
  account: string;
  room: string;
  updatedAt: number;
  value: unknown;
};
export type SupportDraft = {
  text: string;
  mentions?: string[];
  attempt?: { text: string; id: string };
};
export type SupportInboxState = {
  selected?: string | null;
  filter?: TeamConversationFilter;
  /** Written with every view choice from the release that opens on Needs
   * you. A view saved without it is dropped once, so everyone starts there
   * and a choice made afterwards sticks. */
  viewVersion?: typeof INBOX_VIEW_VERSION;
  filters?: Record<"member" | "assignee" | "tag" | "after" | "before", string> & { category?: string };
};
const INBOX_VIEW_VERSION = 2;
const filters = new Set([
  "needs-reply",
  "needs-person",
  "needs-you",
  "ai-handling",
  "waiting-on-member",
  "unassigned",
  "mine",
  "open",
  "waiting",
  "resolved",
  "spam",
  "all",
]);
const signedIn = (account?: ChatPrincipalId) =>
  !!account && peekCommunitySession(account)?.principalId === account;
const keyFor = (room: ChatRoomId, account: ChatPrincipalId, target: string) =>
  `${PREFIX}${account}:${room}:${target}`;
function hasSavedSecret(value: unknown): boolean {
  if (typeof value === "string")
    return (
      hasRecoveryPhraseShape(value) ||
      detectKeySecret(value) !== null ||
      solanaSecretCandidates(value).length > 0
    );
  if (
    Array.isArray(value) &&
    value.length === 64 &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    return true;
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, item]) =>
        hasSavedSecret(key) ||
        hasSavedSecret(item) ||
        detectKeySecretValue(key, item) !== null,
    )
  );
}
function storedEntries(): [string, Stored][] {
  if (typeof window === "undefined") return [];
  const entries: [string, Stored][] = [];
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      try {
        const value = JSON.parse(
          window.localStorage.getItem(key) ?? "null",
        ) as Stored | null;
        if (
          value &&
          typeof value.account === "string" &&
          typeof value.room === "string" &&
          Number.isFinite(value.updatedAt) &&
          value.updatedAt <= Date.now() &&
          Date.now() - value.updatedAt < MAX_AGE &&
          !hasSavedSecret(value.value)
        )
          entries.push([key, value]);
        else window.localStorage.removeItem(key);
      } catch {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* Storage may be disabled. The active composer still works. */
  }
  return entries;
}
function remove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* No storage access. */
  }
}
function read(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  target: string,
): unknown {
  if (!signedIn(account)) return undefined;
  return storedEntries().find(
    ([key]) => key === keyFor(room, account!, target),
  )?.[1].value;
}
function write(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  target: string,
  value: unknown,
) {
  if (!signedIn(account)) return;
  const key = keyFor(room, account!, target);
  try {
    if (value === undefined || hasSavedSecret(value)) {
      remove(key);
      return;
    }
    const entries = storedEntries()
      .filter(([entry]) => entry !== key)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (entries.length >= MAX_ENTRIES) remove(entries.shift()![0]);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        account: account!,
        room,
        updatedAt: Date.now(),
        value,
      } satisfies Stored),
    );
  } catch {
    /* A full disk must not interrupt editing or sending. */
  }
}
/** Only user-written drafts and inbox preferences persist. Ticket data stays
 * in the short-lived presentation cache. Callers restore drafts only after
 * the server has confirmed current access to that ticket. */
export function readSupportDraft(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  ticket: string,
  kind: "reply" | "note",
): SupportDraft | undefined {
  const value = read(room, account, `${ticket}:${kind}`) as
    | Partial<SupportDraft>
    | undefined;
  if (!value || typeof value.text !== "string" || value.text.length > 16_000)
    return;
  return {
    text: value.text,
    ...(Array.isArray(value.mentions) &&
    value.mentions.every((id) => typeof id === "string" && id.length <= 150)
      ? { mentions: value.mentions.slice(0, 50) }
      : {}),
    ...(value.attempt &&
    typeof value.attempt.text === "string" &&
    typeof value.attempt.id === "string" &&
    /^[a-f0-9-]{36}$/.test(value.attempt.id)
      ? { attempt: value.attempt }
      : {}),
  };
}
export function writeSupportDraft(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  ticket: string,
  kind: "reply" | "note",
  draft: SupportDraft,
) {
  write(
    room,
    account,
    `${ticket}:${kind}`,
    draft.text && !hasSavedSecret(draft)
      ? { ...draft, text: draft.text.slice(0, 16_000) }
      : undefined,
  );
}
export function readSupportInboxState(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
): SupportInboxState {
  const value = read(room, account, "inbox") as SupportInboxState | undefined;
  if (!value || typeof value !== "object") return {};
  const validFilters =
    value.filters &&
    (value.filters.category === undefined ||
      (typeof value.filters.category === "string" && value.filters.category.length <= 60)) &&
    ["member", "assignee", "tag", "after", "before"].every(
      (name) =>
        typeof value.filters?.[name as keyof typeof value.filters] ===
          "string" &&
        (value.filters?.[name as keyof typeof value.filters]?.length ?? 151) <= 150,
    );
  return {
    ...(value.selected === null ||
    (typeof value.selected === "string" &&
      /^tc-[a-f0-9]{32}$/.test(value.selected))
      ? { selected: value.selected }
      : {}),
    ...(value.filter &&
    filters.has(value.filter) &&
    value.viewVersion === INBOX_VIEW_VERSION
      ? { filter: value.filter, viewVersion: INBOX_VIEW_VERSION }
      : {}),
    ...(validFilters ? { filters: value.filters } : {}),
  };
}
export function writeSupportInboxState(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  patch: Omit<SupportInboxState, "viewVersion">,
) {
  write(room, account, "inbox", {
    ...readSupportInboxState(room, account),
    ...patch,
    ...(patch.filter ? { viewVersion: INBOX_VIEW_VERSION } : {}),
  });
}
export function clearSupportWorkspaceState(
  room: ChatRoomId,
  account?: ChatPrincipalId,
) {
  for (const [key, value] of storedEntries())
    if (value.room === room && value.account === account) remove(key);
}
/** A missing case must not remove drafts in the team's other cases. */
export function clearSupportConversationState(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  ticket: string,
) {
  if (!account) return;
  const prefix = keyFor(room, account, `${ticket}:`);
  for (const [key] of storedEntries()) if (key.startsWith(prefix)) remove(key);
}
subscribeCommunitySession(() => {
  const account = peekCommunitySession()?.principalId;
  for (const [key, value] of storedEntries())
    if (!account || value.account !== account) remove(key);
});


/** Local widget preview choices. They affect the copied snippet, not the live widget. */
export type WidgetAppearanceDraft = {
  theme: "auto" | "light" | "dark";
  colorMode: "single" | "pair";
  customAccent: string;
  lightAccent: string;
  darkAccent: string;
  radius: "square" | "soft" | "round";
  position: "left" | "right";
};
export function readWidgetAppearanceDraft(room: ChatRoomId, account: ChatPrincipalId | undefined): WidgetAppearanceDraft | undefined {
  const value = read(room, account, "widget-appearance") as WidgetAppearanceDraft | undefined;
  if (!value || !["auto", "light", "dark"].includes(value.theme) ||
    !["single", "pair"].includes(value.colorMode) ||
    typeof value.customAccent !== "string" || value.customAccent.length > 16 ||
    typeof value.lightAccent !== "string" || typeof value.darkAccent !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(value.lightAccent) || !/^#[0-9a-f]{6}$/i.test(value.darkAccent) ||
    !["square", "soft", "round"].includes(value.radius) || !["left", "right"].includes(value.position)) return;
  return value;
}
export function writeWidgetAppearanceDraft(room: ChatRoomId, account: ChatPrincipalId | undefined, value: WidgetAppearanceDraft) {
  write(room, account, "widget-appearance", value);
}

export type PendingSupportReply = {
  replyIntent?: "answer" | "update";
  clientId: string;
  text: string;
  createdAt: string;
  replyTo?: string;
  retryable?: boolean;
  refusalReason?: "unsafe-ask";
  error?: string;
};
export function writePendingSupportReply(
  room: ChatRoomId,
  account: ChatPrincipalId,
  ticket: string,
  reply: PendingSupportReply,
) {
  write(room, account, `${ticket}:pending:${reply.clientId}`, reply);
}
export function removePendingSupportReply(
  room: ChatRoomId,
  account: ChatPrincipalId,
  ticket: string,
  clientId: string,
) {
  remove(keyFor(room, account, `${ticket}:pending:${clientId}`));
}
export function readPendingSupportReplies(
  room: ChatRoomId,
  account: ChatPrincipalId,
  ticket: string,
): PendingSupportReply[] {
  if (!signedIn(account)) return [];
  const prefix = keyFor(room, account, `${ticket}:pending:`);
  return storedEntries()
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([, stored]) => {
      const value = stored.value as PendingSupportReply | undefined;
      if (
        !value ||
        typeof value.clientId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.clientId) ||
        typeof value.text !== "string" ||
        value.text.length > 16_000 ||
        typeof value.createdAt !== "string" ||
        !Number.isFinite(Date.parse(value.createdAt))
      )
        return [];
      return [
        {
          clientId: value.clientId,
          text: value.text,
          createdAt: value.createdAt,
          ...(value.replyIntent === "answer" || value.replyIntent === "update"
            ? { replyIntent: value.replyIntent }
            : {}),
          ...(typeof value.replyTo === "string" &&
          /^[1-9][0-9]*$/.test(value.replyTo)
            ? { replyTo: value.replyTo }
            : {}),
          ...(value.retryable === false
            ? { retryable: false }
            : { retryable: true }),
          ...(typeof value.error === "string"
            ? { error: value.error.slice(0, 500) }
            : {}),
          ...(value.refusalReason === "unsafe-ask"
            ? { refusalReason: "unsafe-ask" as const }
            : {}),
        },
      ];
    });
}
