import type { WorkspaceFeatures } from "./workspace-flags";
/** Workspace types shared by the worker, the app and the Node client. Public
 * workspace metadata never contains messages, member lists or moderation
 * records. */
import type { ChatPrincipalId, ChatVisibility } from "./principal";
import type { ProductAccessView } from "./product-catalog";
import type { ChatBot } from "./bots";
export {
  MODERATOR_PERMISSIONS,
  CONVERSATION_PERMISSIONS,
  effectivePermissions,
  consistentPermissionGrant,
} from "./moderation-permissions";
export type {
  ModeratorPermission,
  ConversationPermission,
} from "./moderation-permissions";
import type { ModeratorPermission } from "./moderation-permissions";
export type { ChatPrincipalId, ChatVisibility, ChatSession } from "./principal";
export type { ProvenWallet, AccountWallets } from "./wallets";
import type { ChatReactionEmoji } from "./reactions";
export type { ChatReactionEmoji } from "./reactions";
export type {
  ChatEvent,
  ChatEventPage,
  ChatEventType,
  RealtimeClientFrame,
  RealtimeServerFrame,
  RealtimeTicket,
} from "./events";
export type { ChatAuditAction, ChatAuditEntry, ChatAuditPage } from "./audit";
export type {
  MemberProfile,
  MemberProfilePage,
  ProfileUpdate,
} from "./profiles";
export type { ChatSearchHit, ChatSearchPage } from "./search";
/** Native rooms have their own namespace; they are never contract addresses. */
export type ChatRoomId = `room:${string}`;
export type NativeRoom = {
  id: string;
  /** Optional paid-plan vanity path, normalized to lowercase by the service. */
  slug?: string | null;
  /** The owner claimed this name for the public support page. */
  hostedName?: boolean;
  name: string;
  image: string | null;
  creator: ChatPrincipalId;
  manager: ChatPrincipalId;
  pendingManager: ChatPrincipalId | null;
  visibility: ChatVisibility;
  accentColor?: string;
  createdAt: string;
};
export type RoleMode = "manual";
/** A staff role: the manager names it and grants it to accounts by hand.
 * Its moderation permissions are the only powers it carries. Conversation
 * powers: `messageMembers` (start conversations with members) is effective
 * only together with `handleConversations` (read and answer team
 * conversations). A grant of the first without the second is refused;
 * losing the second makes a stored first ineffective at once. */
export type ChatRole = {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
  mode: "manual";
  moderationPermissions?: ModeratorPermission[];
};
export type ChatRoleTerms = Omit<ChatRole, "name">;
export type ChatViewer = {
  principalId: ChatPrincipalId | null;
  isMember?: boolean;
  wallet: string | null;
  isManager: boolean;
  permissions: ModeratorPermission[];
  /** Enabled staff roles the viewer holds. */
  roleIds: string[];
  mutedUntil: string | null;
  banned?: boolean;
};
/** The workspace state: what `GET /channels` answers. */
export type ChatState = {
  features?: WorkspaceFeatures;
  /** Current product access; member views omit usage totals. */
  product: ProductAccessView;
  visibility: ChatVisibility;
  accentColor?: string;
  manager?: string;
  pendingManager?: string | null;
  roles: ChatRole[];
  viewer: ChatViewer;
  /** Manager-registered bots; drives the Bot badge. */
  bots: ChatBot[];
};
export type ChatReplyState = "available" | "deleted";
/** Resolved by the server at read time under the reader's access; clients never supply it. */
export type ChatReply = {
  id: string;
  state: ChatReplyState;
  author?: string;
  preview?: string;
  createdAt?: string;
};
export type ChatReaction = {
  emoji: ChatReactionEmoji;
  count: number;
  mine: boolean;
};
export type ChatMessage = {
  id: string;
  /** UUIDv7 supplied by the author; stable across retries and poll reconciliation. */
  clientId?: string;
  author: string;
  /** A human teammate's current workspace name, or null when unset. */
  teamName?: string | null;
  /** Number of fields shared with this member message. */
  sharedDetails?: number;
  text: string;
  createdAt: string;
  /** Absent means 1. Increments on every accepted edit. */
  revision?: number;
  editedAt?: string | null;
  /** Same-conversation message id chosen by the author. */
  replyTo?: string | null;
  reply?: ChatReply | null;
  reactions?: ChatReaction[];
};
export type ChatAuthorBadge =
  | "manager"
  | "moderator"
  | "bot"
  | "team"
  | "managed";
/** Derived from room authority and room settings, never from a display name.
 * `bot` comes from the room's registered bots (chat-settings.bots);
 * `managed` marks the registered bot that is the workspace's managed AI
 * account (Templ runs it on the Anthropic API); `team` is
 * current `handleConversations` authority and is sent only inside a team
 * conversation page. The profile's self-declared `agent` flag is chip text,
 * not a badge. */
export type ChatAuthorFacts = {
  badges: ChatAuthorBadge[];
  /** Manual roles granted in this room, at most 4. */
  roleNames: string[];
  /** Templ people are tagged only in the customer team view. */
  templStaff?: true;
};
export type ChatModerator = {
  wallet: string;
  permissions: ModeratorPermission[];
  /** The roles this person holds; only the manager's view names them. */
  roleIds?: string[];
  templStaff?: true;
};
export type ChatModeration = {
  moderators: ChatModerator[];
  mutes: { wallet: string; until: string }[];
  bans?: { wallet: string; createdAt: string }[];
};
export type ChatRoleGrant = { manual: boolean; templStaff?: true };
export type ChatSubscriptions = {
  viewerPrincipalId: ChatPrincipalId;
  viewerWallet: string | null;
  subscriptions: ChatNativeSubscription[];
  nextCursor: string | null;
};
export type ChatNativeSubscription = {
  kind: "native";
  room: NativeRoom;
  subscribedAt: string;
};
/** Authenticated POST bodies also require expectedPrincipalId matching the
 * canonical account in the cookie session. This is a consistency check, never
 * an authentication source.
 * Workspace routes under /rooms/:id:
 * GET /channels -> ChatState (the workspace state; anonymous allowed for public workspaces)
 * GET /search?q=&scope=support&cursor=&limit= -> ChatSearchPage (current team; 20 per minute per account); a member searches their own thread with channel=<tc id>
 * GET /events?after=&limit= -> ChatEventPage (conversation events reach only the member and the current team)
 * GET /audit?stream=access|chats&before=&limit= -> ChatAuditPage (manager only; access holds role, staff, bot, widget and support-setting changes and chat downloads for 365 days or 10,000 entries; chats, the default, holds everything else for 90 days or 2,000 entries; any other stream is 400)
 * POST /realtime/ticket {} -> RealtimeTicket (like an ordinary GET)
 * GET /realtime (Upgrade: websocket; Origin = app origin) -> 101 (ticket in the first hello frame, never in the URL)
 * POST /roles {id,name,moderationPermissions?} -> {role:ChatRole} (manageRoles; staff roles only; only a manager may set moderationPermissions)
 * POST /roles/:id/assign {principalId,granted:boolean} -> {ok:true} (assignRoles)
 * GET /roles/:id/grant?principalId= -> ChatRoleGrant (assignRoles)
 * GET /moderation -> ChatModeration (manager or mute permission)
 * POST /mutes {principalId,until:ISO|null} -> {ok:true} (mute; max 30 days; null unmutes)
 * POST /bans {principalId,banned:boolean} -> {ok:true} (ban; posting only)
 * Account routes outside the workspace prefix:
 * GET /auth/profile -> MemberProfile & {changesLeftToday} (signed in)
 * POST /auth/profile ProfileUpdate -> MemberProfile (signed in; 3 changes per day; avatar must be a /media upload by this account)
 * GET /profiles?ids=a,b -> MemberProfilePage (up to 50 ids; public fields only; unknown ids omitted; anonymous allowed)
 * GET /auth/wallets -> AccountWallets; POST /auth/wallets/nonce {address,chainId} -> {message,expiresAt}; POST /auth/wallets/verify {message,signature} -> AccountWallets; POST /auth/wallets/remove {address} -> AccountWallets
 * GET /subscriptions?cursor=&limit= -> ChatSubscriptions (authenticated)
 * POST /subscriptions {roomId,subscribed:boolean} -> {ok:true} (authenticated)
 * GET /subscriptions/rooms/:roomId -> {subscribed:boolean} (authenticated)
 * All responses no-store/noindex.
 */
// Member-to-team conversations.
/** A private conversation between one fixed member account and the community's
 * current team (the manager plus staff whose manual role carries
 * `handleConversations`). It lives in the community, reuses its message rows
 * under an opaque id that is never an ordinary channel, and is readable only by
 * the fixed member and the current team. No account-level inbox and no
 * member-to-member conversation exists. Public metadata never lists it. */
export type TeamConversationState = "open" | "resolved";
export type TeamConversation = {
  /** A wallet the guest proved for this conversation. Membership stays with the guest. */
  verifiedWalletAddress?: string;
  /** Widget member view. The current request permits automatic answers. */
  aiReplyExpected?: boolean;
  /** The active agent can pick up this case but has no typing mark yet. */
  aiQueued?: true;
  /** Actual latest case format. Plaintext and keys stay at this customer origin. */
  encryption?: { mode: "encrypted"; custody: "customer" | "templ-own-support"; caseSeq: number; clientOrigin: string };
  /** User reads: an enabled transaction check is queued or running. */
  diagnosisRunning?: boolean;
  /** Member label for a closed case; sending a message remains available. */
  closed?: "abandoned" | "archived";
  support?: import("./support").SupportSummary;
  /** Opaque `tc-<32 hex>`; never a channel id a manager can create. */
  id: string;
  room: ChatRoomId;
  /** The member principal. It changes only when a widget guest proves a
   * wallet in the same widget session; the earlier principals are listed in
   * `formerMembers`, and their messages are the member's own. */
  member: ChatPrincipalId;
  formerMembers?: ChatPrincipalId[];
  /** Team view only: threads the same verified wallet also holds here. */
  linkedConversations?: string[];
  /** Member view only: the previous case remains available with the same sign-in. */
  previousConversation?: string;
  initiator: { kind: "member" | "staff"; principalId?: ChatPrincipalId };
  createdAt: string;
  state: TeamConversationState;
  resolvedBy?: {
    principalId?: ChatPrincipalId;
    kind: "member" | "team";
    at: string;
  } | null;
  /** The member's "Stop team messages" preference: while true no staff write,
   * reopen or initiation lands, including from the manager, a bot or the API;
   * only the member's explicit "Ask the team again" clears it. */
  staffMessagesStopped: boolean;
  revision: number;
  lastMessageAt: string | null;
  /** Latest public team or AI reply, on the member's own conversation list. */
  lastReplyAt?: string;
  /** Internal workflow metadata. Omitted entirely from the fixed member's view;
   * a claim never changes any staff or member read/reply permission. */
  assignment?: {
    principalId: ChatPrincipalId;
    claimedAt: string;
    teamName?: string | null;
  } | null;
  canClaim?: boolean;
  canRelease?: boolean;
  canTakeover?: boolean;
  /** How the viewer relates to this conversation. */
  viewer: "member" | "team";
  /** Whether the viewer may post right now and, when not, the safe reason. */
  canPost: boolean;
  /** Team view only: the current human owner or Admin may send wallet
   * instructions. Every write rechecks authority and still screens secrets. */
  canInstructWalletActions?: boolean;
  postBlockedReason?:
    | "stopped"
    | "muted"
    | "banned"
    | "history-capacity"
    | "unavailable"
    | null;
  /** A person on the team has been asked to answer. Members get `at` and
   * `by` (the AI agent, a person or the member); the team also gets the
   * reason. Cleared when a person replies, takes or assigns the request,
   * takes over from the AI or lets it answer, or the request is resolved.
   * While the member's own request (`by` "member") is open, nobody can let
   * the AI answer. */
  handoff?: {
    at: string;
    reason?: import("./support").SupportHandoffReason;
    by?: import("./support").SupportHandoffBy;
  } | null;
  /** "Did this solve it?" for the latest team resolution. answer null means
   * asked and not answered. Absent when not asked (open, spam, or resolved
   * by the member). */
  confirmation?: {
    askedAt: string;
    answer: "solved" | "not-solved" | null;
    answeredAt: string | null;
  } | null;
  /** Team view only: why a reply from this viewer would be refused now.
   * Checked in this order: handed-off, ai-off, ai-drafts-only, paused,
   * message-limit. Only a registered AI agent gets the two ai- values. */
  replyBlocked?:
    | "paused"
    | "message-limit"
    | "handed-off"
    | "ai-drafts-only"
    | "ai-off"
    | null;
  /** Team only: a verified prepaid period distinguishes answers from progress updates. */
  answerIntentRequired?: boolean;
  /** Team view only: the AI mode of the current request. The key is absent
   * from member views. */
  ai?: import("./support").SupportAiView | null;
  /** Team view only: whether the latest request bills, as staff without
   * billing may see it (no amount). Absent without a charge. */
  billing?: import("./product-catalog").ProductCaseBilling;
  /** Member view only, on an open request the team has answered: the
   * member may mark it solved. `ask` when the team's latest reply is
   * `askAfterHours` old, so the widget asks "Did this solve it?". */
  solve?: "ready" | "ask";
  /** The member-visible follow-up line for the latest
   * request. Members, the team and specialists get the same object; it
   * carries no owner, title, note, link or due date. Absent when there is
   * nothing to show. */
  followUp?: import("./support-follow-ups").SupportFollowUpLine | null;
};
export type TeamConversationFilter = import("./support").SupportFilter;
export type TeamConversationList = {
  filter: TeamConversationFilter;
  conversations: TeamConversation[];
  nextCursor: string | null;
};
/** Someone on the team is writing a reply right now: "agent" for the
 * workspace's registered bot, "team" for a person. It names no one, carries
 * no text or count, and lapses about 12 seconds after the last update.
 * A member may also see "agent" for up to 90 seconds after their own
 * message, before the agent marks typing, while the workspace's AI agent
 * listed its queue or used a thread in the last minute and may answer this
 * request. */
export type TeamConversationTyping = "agent" | "team" | null;
export type TeamConversationJoin = { at: string; name?: string };
export type TeamConversationMessages = {
  conversation: TeamConversation;
  deletionRevision: number;
  messages: ChatMessage[];
  nextBefore: string | null;
  authors?: Record<string, ChatAuthorFacts>;
  /** Member reads: when the first person from the team replied to, claimed
   * or received each case on this page, with their name for members. */
  joined?: TeamConversationJoin[];
  /** Present on current services; a reader never sees their own mark. */
  typing?: TeamConversationTyping;
  /** Present for a member reading through the support widget: whether the
   * team asked this member to verify a wallet. The same flag as the member's
   * workflow view; nothing else of the workflow. */
  workflow?: { verificationRequested: boolean };
};
/** What the viewer may do with team conversations in this community, from the
 * server's gate and the viewer's authority; never from a display name. */
export type TeamConversationStatus = {
  /** New-case policy only. Existing cases retain their own stored format. */
  encryption?: { mode: "encrypted"; custody: "customer" | "templ-own-support"; clientOrigin: string; policyRevision: number };
  /** False while the release gate (`conversationsVerified`) is closed: no new
   * conversation or message is accepted, existing authorized history stays readable. */
  available: boolean;
  /** Separate rollout gate for paid support claims. Basic support is unchanged. */
  supportWorkflowAvailable?: boolean;
  /** Current team may claim while Support isn't paused and its rollout gate is open. */
  canClaim?: boolean;
  /** The viewer may open or reopen their own conversation with the team.
   * Asking admits a signed-in public visitor; reading status does not. */
  canAsk: boolean;
  /** The viewer’s own posting restriction, including before their first ask. */
  postBlockedReason?: "banned" | "muted";
  /** The viewer is on the current team (manager or `handleConversations`). */
  team: boolean;
  /** The viewer may start a conversation with a member (`messageMembers`, effective). */
  canStart: boolean;
  /** The viewer's own conversation id when one exists. */
  mine: string | null;
  limits: {
    openPerRoom: number;
    retainedRecordsPerRoom: number;
    memberOpensPerAccountPerDay: number;
    staffOpensPerAccountPerDay: number;
    opensPerRoomPerDay: number;
  };
  /** Team viewers only: the Needs reply view is ready. Until it is, that
   * view answers 409 and the open list stays the queue. */
  needsReplyReady?: boolean;
};
/** Team conversation routes (worker package TC1). Every POST carries expectedPrincipalId; every response is no-store.
 * GET /conversations/status -> TeamConversationStatus (any reader; anonymous readers get canAsk false and mine null)
 * GET /conversations?filter=open|resolved|all&cursor= -> TeamConversationList (team: every conversation; member: only their own; anyone else: an empty list, never 403 for enumeration)
 * GET /conversations?filter=needs-reply&cursor= -> TeamConversationList (team: requests waiting for a reply now, oldest wait first; 409 needs-reply-preparing with Retry-After 30 until the case ledger is ready)
 * GET /conversations?filter=needs-person&cursor= -> TeamConversationList (team: open or waiting requests handed to a person)
 * GET /conversations?filter=needs-you|ai-handling&cursor= -> TeamConversationList (team: the needs-reply requests a person must answer, or the ones the AI agent is expected to answer now; order, cursor and 409 as for needs-reply. A request is in ai-handling while it is in AI answers with no open handoff, a registered AI agent listed its queue or used a thread in the last minute, and its wait started under 3 minutes ago; every other waiting request is in needs-you)
 * GET /conversations?filter=waiting-on-member&cursor= -> TeamConversationList (team: open or waiting requests where the team or the AI agent replied last). Team rows carry support.turn, turnReason, lastBy and lastAt; member views never do
 * GET /conversations/pulse -> SupportPulse (manager or handleConversations; counts and times only: needsYou plus aiHandling split needsReply, and agentRegistered, agentActive and agentSeenAt say whether the AI agent is checking in; anyone else 404)
 * GET /conversations/report?window=7d|30d|90d|all -> {report: SupportReport} (manager or manageSupport; default 30d; any other window is 400 report-window)
 * GET /conversations/refusals?days=1|7|30 -> SupportRefusals (manager, manageBilling, or handleConversations with manageSupport; counts by day and reason, no identities; default 7; anyone else 404)
 * POST /conversations/ask {text?,clientId?} -> 200|201 {conversation,message?} (signed-in public visitors are admitted on this action; private rooms require invitation membership; opens or reuses the caller's one conversation; a reopen consumes open quota, a fetch of an open one does not; clears the caller's own stop preference)
 * POST /conversations/start {member,text,clientId?} -> 201 {conversation,message} (effective messageMembers; `member` must be a current room member principal, never a wallet, name or email; 409 "stopped" while the member has stopped team messages; 409 at a cap)
 * GET /conversations/:id -> {conversation} (fixed member or current team; anyone else 404)
 * GET /conversations/:id/messages?before=&limit= -> TeamConversationMessages (fixed member or current team)
 * POST /conversations/:id/messages {text,clientId?,replyTo?,ifLatest?:{id,revision}} -> 201 {message,conversation} (fixed member, or current team while not stopped; mutes, bans, account pacing and the separate support history policy apply; a member reply reopens a resolved conversation; with ifLatest, 409 stale when a newer or edited message arrived after the one the writer read; a registered bot gets 409 handed-off while the request waits for a person, then 409 ai-off or ai-drafts-only when the request's AI mode forbids its reply, both before the ifLatest check; a person's reply switches a request in AI answers to AI drafts only)
 * POST /conversations/:id/messages/:messageId/edit {text} | /delete {} | /reactions {emoji,active} (same participants; existing author, window and moderation rules apply; deletion still needs the author or deleteMessages)
 * POST /conversations/:id/resolve {resolved:boolean,timeSpent?,ifRevision?} -> {conversation} (team; a member may reopen their own; staff cannot reopen a stopped conversation; timeSpent is one of SUPPORT_TIME_SPENT, team only and only when resolving)
 * POST /conversations/:id/workflow {action:"handoff",reason,ifLatest?} -> {workflow} (team, registered bots included; reason is one of SUPPORT_HANDOFF_REASONS and no text is accepted; posts no message and counts nothing; repeating it for the same request changes nothing; until a person replies, takes or assigns the request, or resolves it, registered bots get 409 handed-off; the member's own request for a person, from ask-person, stays open until a person replies or resolves it)
 * POST /conversations/:id/workflow {action:"ai-mode",mode,takeOver?:true} -> {workflow} (people on the team only: registered bots get 403 person-only, anyone else 404; mode is one of SUPPORT_AI_MODES, takeOver only with "drafts", else 400 invalid-ai-mode; takeOver or "answers" also clears an open handoff the AI agent or a person started and the member keeps waiting; while a handoff the member asked for is open, "answers" is 409 member-asked until a person replies or resolves the request; posts no message and counts nothing; the 51st change in one request is 409 ai-mode-limit; while the workspace is paused only "drafts" and "off" are accepted)
 * AI mode rules for registered bots: in "drafts" a bot may read, add notes, set tags, send presence, delete its own message and hand off, and gets 409 ai-drafts-only for replies, edits, reactions, typing, screenshots, resolve, claim, assign and verification requests; in "off" every bot write is 409 ai-off and bot lists leave the request out. A person's reply, claim, assignment to a person, typing mark or composing presence switches "answers" to "drafts"; bots never change the mode.
 * POST /conversations/:id/workflow {action:"ask-person"} -> {handoff:{at,by}} (the thread's member only, guests and widget sessions included; the team and registered bots get 403 member-only, anyone else 404; hands the request to the team with the reason person and by "member"; a handoff the AI agent or a person opened becomes the member's own, keeping its time and reason, with no new alert; while the member's own handoff is open it changes nothing and returns it; posts no message and counts nothing; 409 stopped, handoff-resolved or handoff-no-request)
 * POST /conversations/:id/workflow {action:"confirm",solved:boolean} -> {workflow,conversation,reopened?} (fixed member only, 403 member-only for the team; 409 confirm-not-asked or confirm-answered; No reopens the request when the workspace can take it)
 * POST /conversations/:id/stop {stopped:boolean} -> {conversation} (fixed member only)
 * POST /conversations/:id/claim {takeover?:boolean} -> {conversation} (current team, a workspace that isn't paused and the support-workflow gate; self-claim only, competing claim 409; explicit takeover is manager-only)
 * POST /conversations/:id/release {} -> {conversation} (current assigned staff or manager; cleanup remains available after expiry or gate rollback)
 * GET /conversations/:id/export?before= -> JSON {conversation,messages,nextBefore,export} page (fixed member or current team; paced)
 * POST /conversations/:id/messages/:messageId/report {reason,details?,requestId} -> 201 {id,received} (fixed member or current team; the report stores the message as the room holds it) */

export type { ChatBot, ChatBots } from "./bots";
/** Bot routes. A bot posts under its own session and is badged from the registry.
 * GET /bots -> ChatBots (same access as GET /channels)
 * POST /bots {principalId,displayName,expectedPrincipalId} -> ChatBots (manager or manageRoles; 400 invalid; 409 at 10 bots or when already registered; the bot needs no session yet)
 * POST /bots/:principal/remove {expectedPrincipalId} -> ChatBots (manager or manageRoles) */

/** POST /realtime/ticket {expectedPrincipalId?} -> RealtimeTicket; the socket hello frame carries {type:"hello",ticket,after}; 503 while realtime is unavailable, so clients poll GET /events instead */

/** Sign-in methods on one account (DTOs in ./wallets): GET /auth/account -> ChatAccount whose `methods` lists the proven EVM wallets and Solana wallets with canRemove.
 * POST /auth/wallets/remove {address} and POST /auth/solana/remove {address} answer 409 "Keep at least one wallet to sign in." for the account's last wallet.
 * ChatAccount.emailVerified and emailMasked describe the optional alert address; it receives support alerts and never signs in. */
export type {
  AccountMethods,
  AccountSolanaWalletMethod,
  AccountWalletMethod,
  ChatAccount,
} from "./wallets";

/** One account, two kinds of wallet. Sessions carry `authMethod` "wallet" (Sign In With Ethereum) or "solana" (Sign In With Solana), and every proven wallet
 * resolves to the same `account:<uuid>` principal. POST /auth/verify signs in with any proven EVM wallet of the account (session.address is the signing wallet);
 * POST /auth/solana/verify signs in with any Solana wallet of the account (session.solanaAddress is the signing wallet, address null).
 * Adding a second wallet to a bare EVM wallet mints the account id; that wallet stays servicePrincipals[1]. A stored session of any other kind answers 401.
 * Removing a wallet ends the sessions it signed in (POST /auth/wallets/remove answers {...AccountWallets, sessionEnded:true} and clears the cookie for the current one). */
export type { AuthMethod } from "./principal";
export { AUTH_METHODS, isAuthMethod } from "./principal";

// Feature modules. Each lane fills its own file; these lines stay.
export type * from "./support-evidence";
export type * from "./support-citations";
export type * from "./support-drafts";
export type * from "./support-alerts";
export type * from "./support-quality";
export type * from "./support-eval";
export type * from "./support-eval-score";
export type * from "./support-follow-ups";
export type * from "./managed-agent";
export type * from "./metric-keys";
export type * from "./golden-set";
