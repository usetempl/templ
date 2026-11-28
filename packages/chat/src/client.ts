import { isBitcoinAccountAddress } from "./bitcoin-account-auth";
/** Node/server client. Cookies and signer material never belong in browser bundles. */
import {
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";

import type {
  TelegramAiHelpResult,
  TelegramAiHelpJob,
} from "./support-telegram-ai";
import type { HandoffLearningJob, HandoffLearningResult } from "./support-learning";
export type { HandoffLearningJob, HandoffLearningResult } from "./support-learning";
export type {
  TelegramAiHelpResult,
  TelegramAiHelpJob,
} from "./support-telegram-ai";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import {
  DEFAULT_CHAT_AUTH_CHAIN_ID,
  isChatChainId,
  type ChatChainId,
} from "./chains";
import {
  normalizeChatPrincipal,
  normalizeServicePrincipals,
  type ChatPrincipalId,
  type ChatVisibility,
} from "./principal";
import { communityAccent } from "./appearance";
import {
  SAFETY_REASONS,
  legalNotice,
  type SafetyReason,
  type LegalNotice,
} from "./safety";
import {
  normalizeDisplayName,
  profileMediaHash,
  profileUpdate,
  type MemberProfile,
  type MemberProfilePage,
  type ProfileUpdate,
} from "./profiles";
import {
  base58Decode,
  createSolanaSignInMessage,
  isSolanaAddress,
  parseSolanaSignInMessage,
} from "./solana";
import { normalizeBotDisplayName, type ChatBots } from "./bots";
import {
  MAX_EVENT_PAGE,
  type ChatEvent,
  type ChatEventPage,
  type ChatEventType,
  type RealtimeClientFrame,
  type RealtimeServerFrame,
  type RealtimeTicket,
} from "./events";
import {
  ACCOUNT_METHOD_LIMITS,
  WALLET_LINK_RESOURCE_PREFIXES,
  WALLET_LINK_STATEMENT,
  type AccountMethods,
  type AccountWallets,
  type ChatAccount,
} from "./wallets";
// Account sign-in method types for SDK consumers.
export type {
  AccountMethods,
  AccountSolanaWalletMethod,
  AccountWalletMethod,
  ChatAccount,
} from "./wallets";
import { SEARCH_PAGE, searchQuery, type ChatSearchPage } from "./search";
import { MAX_AUDIT_PAGE, type AuditStream, type ChatAuditPage } from "./audit";
import {
  SUPPORT_AI_MODES,
  SUPPORT_HANDOFF_REASONS,
  SUPPORT_TIME_SPENT,
  type SupportAiMode,
  type SupportHandoffReason,
  type SupportPulse,
  type SupportPulseV2,
  type SupportTimeSpent,
  type SupportWorkflow,
} from "./support";
import { chatReaction } from "./reactions";
import {
  checkCitations,
  stripCitationMarkers,
  type CitationCheck,
  type CitationRow,
  type CitableDiagnosis,
} from "./support-citations";
import {
  SUPPORT_AI_DECLINES,
  checkedProvenance,
  type SupportAiDecline,
  type SupportAiProvenance,
  type SupportCaseDetail,
  type SupportCaseList,
  type SupportDraft,
  type SupportDraftRequestRow,
  type SupportDraftRequestView,
} from "./support-drafts";
import {
  AGENT_API_FEATURES,
  AGENT_API_MAJOR,
  AGENT_API_VERSIONS,
  caseNumber,
  diagnosisIdOf,
  evalRunIdOf,
  evidenceNumber,
  followUpIdOf,
  jsonObject,
  pageCursor,
  parseReplyHeld,
  type AgentApiVersion,
  type AgentFrameInput,
  type AgentReplyHeld,
} from "./agent-api";
import type {
  SupportCaseFrame,
  SupportEvidence,
  SupportEvidenceInput,
  SupportFrameField,
} from "./support-evidence";
import type {
  SupportFollowUp,
  SupportFollowUpList,
  SupportFollowUpQueue,
  SupportFollowUpQueueView,
  SupportFollowUpType,
} from "./support-follow-ups";
import type { ReplyLabel, SupportCaseQualityView } from "./support-quality";
import type {
  SupportDiagnosisList,
  SupportDiagnosisView,
} from "./support-diagnosis";
import type { EvalRunInput, EvalRunView } from "./support-eval";
import type { KnowledgeSearchHit } from "./protocol-profile";
import {
  KNOWLEDGE_LIMITS,
  checkedWorkspaceAiGuidance,
  type KnowledgeContextPage,
} from "./knowledge";
// Agent API 1.1: pure helpers a TypeScript agent can run before it sends,
// and the version table.
export {
  AGENT_API_FEATURES,
  AGENT_API_MAJOR,
  AGENT_API_VERSIONS,
  SUPPORT_AI_DECLINES,
  checkCitations,
  stripCitationMarkers,
};
export type {
  AgentApiVersion,
  AgentFrameInput,
  AgentReplyHeld,
  CitableDiagnosis,
  CitationCheck,
  CitationRow,
};
import {
  MODERATOR_PERMISSIONS,
  consistentPermissionGrant,
} from "./moderation-permissions";
import type {
  ChatMessage,
  NativeRoom,
  ChatState,
  ChatSubscriptions,
  ChatRole,
  ChatModeration,
  ChatRoleGrant,
  ModeratorPermission,
  ChatAuthorFacts,
  ChatReaction,
  TeamConversation,
  TeamConversationFilter,
  TeamConversationList,
  TeamConversationMessages,
  TeamConversationStatus,
} from "./index";

const SESSION_MS = 30 * 24 * 60 * 60_000;
const RETRY_MS = 7 * 24 * 60 * 60_000;
const SESSION_COOKIE = "__Host-templ_session";
const NONCE_COOKIE = "__Host-templ_nonce";
const cookieNames = new Set([SESSION_COOKIE, NONCE_COOKIE]);
export type ChatSigner = {
  address: Address;
  signMessage: (args: { message: string }) => Promise<Hex>;
};
/** An agent's Solana key: its base58 public key and an Ed25519 signer over a
 * message's UTF-8 bytes. The client asks it to sign Templ's Sign In With
 * Solana text only, after checking that text; the key never leaves the
 * caller. Use it with signInWithSolana(). */
export type ChatSolanaSigner = {
  network: "solana";
  address: string;
  /** The 64-byte Ed25519 signature of `message`. */
  signMessage: (args: { message: Uint8Array }) => Promise<Uint8Array>;
};
/** A session opened with a Solana key. The account it signs in to is named
 * by `principalId`; the wallet never becomes an alias of another account. */
export type ChatSolanaSession = {
  solanaAddress: string;
  expiresAt: number;
  authenticatedAt: number;
  principalId: ChatPrincipalId;
  servicePrincipals: ChatPrincipalId[];
  authMethod: "solana";
};
/** A wallet session. `address` is the wallet the service verified for it: the
 * signer, or the account wallet the service names when the signer is another
 * proven wallet on that account. */
export type ChatSession = {
  address: Address;
  expiresAt: number;
  authenticatedAt: number;
  walletRevision: number;
  walletAuthorizationExpiresAt: number;
  principalId: ChatPrincipalId;
  servicePrincipals: ChatPrincipalId[];
  authMethod: "wallet";
};
export type RoomInvitation = {
  id: string;
  createdAt: string;
  revokedAt: string | null;
};
export type ChatDestination = { roomId: string };
export type ChatTarget = string | ChatDestination;
export type CreatedRoom = NativeRoom & { followed: boolean };
export type AgentRoleMetadata = {
  id: string;
  name?: string;
  /** Manager-only powers for a staff role. */
  moderationPermissions?: ModeratorPermission[];
};
export type AgentManualRoleDraft = AgentRoleMetadata & { enabled?: boolean };
export type AgentReportReason = SafetyReason;
export type AgentReportDraft = {
  requestId: string;
  reason: AgentReportReason;
  details: string;
  relatedReportId?: string;
  notice: LegalNotice;
};
/** Intake acknowledgement only; it grants no authority or enforcement action. */
export type AgentReportReceipt = {
  id: string;
  received: true;
  reviewStatus?:
    | "pending-authority-verification"
    | "pending-legal-duty-validation"
    | "verified"
    | "validated"
    | "rejected";
};
export type AgentRoomDraft = {
  id: string;
  name: string;
  image?: string | null;
  visibility: ChatVisibility;
  accentColor?: string;
  setup?: {
    roles: {
      id: string;
      name: string;
      mode: "manual";
      moderationPermissions?: ModeratorPermission[];
    }[];
  };
};
/** The subset of the WebSocket interface the client uses. Node 22 and later provide it globally. */
export type ChatSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: {
      data?: unknown;
      code?: number;
      reason?: string;
    }) => void,
  ): void;
};
/** Node's WebSocket accepts `{headers}` as its second argument; the client sends the app Origin there. */
export type ChatSocketConstructor = new (
  url: string,
  options?: { headers: Record<string, string> },
) => ChatSocket;
export type ChatClientOptions = {
  /** Exact HTTPS origin; no path, credentials, query or fragment. */
  apiOrigin?: string;
  /** Must equal the service's allowed APP_ORIGIN. It is not an authentication credential. */
  appOrigin?: string;
  /** An EVM signer (sign in with signIn()) or a Solana key (sign in with
   * signInWithSolana()). One client holds one key. */
  signer?: ChatSigner | ChatSolanaSigner;
  /** EOA sign-in network. Token-role availability is separate; contract-wallet sign-in is Robinhood only. */
  authChainId?: ChatChainId;
  fetch?: typeof fetch;
  /** Per-request deadline, 1–30 seconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** WebSocket class for subscribe(). Defaults to the global WebSocket; without one, subscribe() polls. */
  WebSocket?: ChatSocketConstructor;
} & { roomId?: string };
export type ChatClientErrorCode =
  | "unsafe-ask"
  | "secret-refused"
  | "network"
  | "invalid"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "gone"
  | "rate-limited"
  | "unavailable"
  | "unexpected";
function errorCode(status: number): ChatClientErrorCode {
  switch (status) {
    case 0:
      return "network";
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 410:
      return "gone";
    case 429:
      return "rate-limited";
    case 502:
    case 503:
    case 504:
      return "unavailable";
    default:
      return "unexpected";
  }
}
function errorText(status: number, retryAfterSeconds: number | null) {
  switch (errorCode(status)) {
    case "network":
      return "Templ could not be reached.";
    case "unauthorized":
      return "Sign in to Templ first.";
    case "rate-limited":
      return retryAfterSeconds === null
        ? "Templ asked this client to slow down."
        : `Templ asked this client to wait ${retryAfterSeconds} seconds.`;
    case "unavailable":
      return `Templ is unavailable right now (${status}).`;
    default:
      return `Templ answered with status ${status}.`;
  }
}
export class ChatClientError extends Error {
  /** Safety codes are preserved; other codes describe the HTTP status. */
  readonly code: ChatClientErrorCode;
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds: number | null = null,
    public readonly clientId?: string,
    /** The service's reason code, such as "stale" or "handed-off", or null.
     * Branch on `status` plus `reason`; the message stays this client's own
     * text and never repeats what the service wrote. AI mode codes:
     * "ai-drafts-only" and "ai-off" (409, a registered bot's write the
     * request's mode forbids), "person-only" (403, a bot tried to change the
     * mode), "ai-mode-limit" (409), "invalid-ai-mode" (400) and
     * "member-asked" (409, a person tried to let the AI answer while the
     * member's own request for a person is open). */
    public readonly reason: string | null = null,
    /** Present only on 422 "reply-held": the workspace holds AI agent
     * replies whose figures fail the citation check, and this one became a
     * draft for the team (`held.draft`, its clientId) with the problems the
     * check found. Nothing was sent. Fix the citations once, or hand off. */
    public readonly held: AgentReplyHeld | null = null,
  ) {
    super(errorText(status, retryAfterSeconds));
    this.name = "ChatClientError";
    this.code =
      reason === "unsafe-ask" || reason === "secret-refused"
        ? reason
        : errorCode(status);
  }
}
/** A refused response is read up to this size for its reason code. */
const ERROR_BODY_BYTES = 4_096;
const REASON_CODE = /^[a-z0-9-]{1,40}$/;
/** The `reason` of a refused response (or null) and, on 422 reply-held, the
 * held draft. Reads at most 4 KB and then cancels the body; a longer,
 * unreadable or non-JSON body gives neither. */
async function errorReason(
  response: Response,
): Promise<{ reason: string | null; held: AgentReplyHeld | null }> {
  const none = { reason: null, held: null };
  const reader = response.body?.getReader();
  if (!reader) return none;
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (length <= ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      chunks.push(value);
      length += value.length;
    }
  } catch {
    return none;
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!complete || length > ERROR_BODY_BYTES) return none;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const raw =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).reason
        : undefined;
    const reason =
      typeof raw === "string" && REASON_CODE.test(raw) ? raw : null;
    return {
      reason,
      held: response.status === 422 ? parseReplyHeld(reason, body) : null,
    };
  } catch {
    return none;
  }
}
function exactOrigin(input: string) {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    url.pathname !== "/" ||
    (input !== url.origin && input !== `${url.origin}/`)
  )
    throw new Error("Use an exact HTTPS origin without a path or credentials.");
  return url.origin;
}
const CANONICAL_ORIGIN_PAIRS = [
  {
    app: "https://templ.vip",
    api: "https://community.templ.vip",
  },
  {
    app: "https://usetempl.com",
    api: "https://community.usetempl.com",
  },
] as const;
function clientOrigins(
  options: Pick<ChatClientOptions, "apiOrigin" | "appOrigin">,
) {
  const requestedApp = options.appOrigin
    ? exactOrigin(options.appOrigin)
    : undefined;
  const requestedApi = options.apiOrigin
    ? exactOrigin(options.apiOrigin)
    : undefined;
  const inferred = CANONICAL_ORIGIN_PAIRS.find(
    (pair) => pair.app === requestedApp || pair.api === requestedApi,
  );
  const fallback = CANONICAL_ORIGIN_PAIRS[0];
  const app = requestedApp ?? inferred?.app ?? fallback.app;
  const api = requestedApi ?? inferred?.api ?? fallback.api;
  const canonical = CANONICAL_ORIGIN_PAIRS.find(
    (pair) => pair.app === app || pair.api === api,
  );
  if (canonical && (canonical.app !== app || canonical.api !== api))
    throw new Error("App and API origins must use the same Templ environment.");
  return { app, api };
}
function isSolanaSigner(
  signer: ChatSigner | ChatSolanaSigner,
): signer is ChatSolanaSigner {
  return (signer as { network?: unknown }).network === "solana";
}
function solanaWallet(value: unknown): string {
  if (!isSolanaAddress(value)) throw new Error("Invalid Solana address.");
  return value;
}
/** Standard padded base64, the form Templ reads a Solana signature in. */
function paddedBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}
/** Ed25519 verification of `message` by a base58 public key. */
function ed25519Verifies(
  address: string,
  message: Uint8Array,
  signature: Uint8Array,
) {
  try {
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(base58Decode(address)).toString("base64url"),
      },
      format: "jwk",
    });
    return verifySignature(null, message, key, signature);
  } catch {
    return false;
  }
}
const SIGN_IN_STATEMENT = "Sign in to your Templ chat.";
function wallet(value: string): Address {
  if (!isAddress(value) || value.toLowerCase() === zeroAddress)
    throw new Error("Invalid wallet or Templ address.");
  return value.toLowerCase() as Address;
}
function roomId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(
      value,
    )
  )
    throw new Error("Use a UUIDv7 room ID, without an address or path prefix.");
  return value;
}
function destination(input: ChatTarget | undefined): ChatDestination {
  if (typeof input === "string") return { roomId: roomId(input) };
  if (!input || typeof input !== "object") throw new Error("Choose a room ID.");
  if ("templ" in input)
    throw new Error("Contract-address room destinations are not supported.");
  if (input.roomId !== undefined) return { roomId: roomId(input.roomId) };
  throw new Error("Choose a room ID.");
}
function roomPath(input: ChatTarget | undefined) {
  const value = destination(input);
  return `/rooms/${value.roomId}`;
}
function roomName(value: string, max = 80) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`Use a name of 1–${max} characters.`);
  return value.trim();
}
function principal(value: ChatPrincipalId): ChatPrincipalId {
  const normalized = normalizeChatPrincipal(value);
  if (!normalized) throw new Error("Use a wallet address or account ID.");
  return normalized;
}
/** The service refuses a privileged change without this explicit flag. */
function privilegedConfirmation(options: { confirmed?: true }) {
  if (options.confirmed === undefined) return {};
  if (options.confirmed !== true)
    throw new Error("Set confirmed to true after reviewing the change.");
  return { confirmed: true as const };
}
function roleMetadata(input: AgentRoleMetadata): AgentRoleMetadata {
  const result: AgentRoleMetadata = { id: roleIdOf(input.id) };
  if (input.name !== undefined) result.name = roomName(input.name, 48);
  if (input.moderationPermissions !== undefined) {
    if (
      !Array.isArray(input.moderationPermissions) ||
      input.moderationPermissions.length > MODERATOR_PERMISSIONS.length ||
      input.moderationPermissions.some(
        (permission) => !MODERATOR_PERMISSIONS.includes(permission),
      ) ||
      new Set(input.moderationPermissions).size !==
        input.moderationPermissions.length ||
      !consistentPermissionGrant(input.moderationPermissions)
    )
      throw new Error("Choose valid moderation powers without duplicates.");
    result.moderationPermissions = [...input.moderationPermissions];
  }
  return result;
}
function uuid4(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new Error("Use a UUIDv4 request or report ID.");
  return value;
}
function messageId(value: string) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,14}$/.test(value))
    throw new Error("Invalid message ID.");
  return value;
}
/** The message a reply or handoff answers, as read: its id and revision. */
function latestMessage(value: { id: string; revision: number }) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error("Use ifLatest with a message ID and a positive revision.");
  return { id: messageId(value.id), revision: value.revision };
}
/** Persist with the exact workspace, conversation and message target before submitting.
 * The shared schema permits authority intake, mandatory notices, urgent duties
 * and appeals. Passing validation never verifies a claimed authority. */
export function prepareReport(
  input: Omit<AgentReportDraft, "requestId" | "notice"> & {
    requestId?: string;
    notice?: Partial<LegalNotice>;
  },
): AgentReportDraft {
  if (!SAFETY_REASONS.some(([reason]) => reason === input.reason))
    throw new Error("Choose a report reason.");
  if (
    typeof input.details !== "string" ||
    !input.details.trim() ||
    input.details.trim().length > 2_000
  )
    throw new Error("Use 1–2,000 characters for report details.");
  const notice = legalNotice(input.reason, input.notice);
  if (notice.authority) Object.freeze(notice.authority);
  Object.freeze(notice);
  return Object.freeze({
    requestId: uuid4(input.requestId ?? randomUUID()),
    reason: input.reason,
    details: input.details.trim(),
    notice,
    ...(input.relatedReportId === undefined
      ? {}
      : { relatedReportId: uuid4(input.relatedReportId) }),
  });
}
/** Create once and persist before POST /rooms. Retrying preserves this exact intent. */
export function prepareRoom(
  input: Omit<AgentRoomDraft, "id"> & { id?: string },
): AgentRoomDraft {
  if (input.visibility !== "public" && input.visibility !== "private")
    throw new Error("Choose Public or Private.");
  const draft: AgentRoomDraft = {
    id: roomId(input.id ?? newMessageId()),
    name: roomName(input.name),
    visibility: input.visibility,
  };
  if (input.accentColor !== undefined)
    draft.accentColor = communityAccent(input.accentColor);
  if (input.visibility === "private" && input.image != null)
    throw new Error("Private workspaces cannot use image uploads.");
  if (input.image !== undefined) {
    if (input.image === null) draft.image = null;
    else {
      if (typeof input.image !== "string" || input.image.length > 2048)
        throw new Error("Use an HTTPS image URL.");
      const url = new URL(input.image);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error(
          "Use an HTTPS image URL without credentials or a fragment.",
        );
      draft.image = url.href;
    }
  }
  if (input.setup !== undefined) {
    const setup = input.setup;
    if (
      !Array.isArray(setup?.roles) ||
      setup.roles.length > 32 ||
      Object.prototype.hasOwnProperty.call(setup, "channels")
    )
      throw new Error("Start with up to 32 staff roles.");
    const roles = setup.roles.map((role) => {
      if (
        !role ||
        role.mode !== "manual" ||
        ["token", "amountRaw", "priceRaw", "minBalanceRaw"].some(
          (key) => (role as unknown as Record<string, unknown>)[key] != null,
        )
      )
        throw new Error("Start with staff roles only.");
      const moderationPermissions = roleMetadata({
        id: role.id,
        moderationPermissions: role.moderationPermissions,
      }).moderationPermissions;
      return Object.freeze({
        id: roleIdOf(role.id),
        name: roomName(role.name, 48),
        mode: "manual" as const,
        ...(moderationPermissions?.length ? { moderationPermissions } : {}),
      });
    });
    if (new Set(roles.map((role) => role.id)).size !== roles.length)
      throw new Error("Role IDs must be unique.");
    Object.freeze(roles);
    draft.setup = Object.freeze({ roles });
  }
  return Object.freeze(draft);
}
function validateRoom(value: NativeRoom, id: string): NativeRoom {
  if (
    !value ||
    value.id !== id ||
    typeof value.name !== "string" ||
    roomName(value.name) !== value.name ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new ChatClientError(502);
  if (
    !normalizeChatPrincipal(value.creator) ||
    !normalizeChatPrincipal(value.manager) ||
    (value.pendingManager !== null &&
      !normalizeChatPrincipal(value.pendingManager)) ||
    (value.visibility !== "public" && value.visibility !== "private") ||
    // A workspace is never listed or bound to a contract.
    ["listed", "accessContracts", "accessContract"].some((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  )
    throw new ChatClientError(502);
  if (value.accentColor !== undefined) communityAccent(value.accentColor);
  if (value.image !== null && typeof value.image !== "string")
    throw new ChatClientError(502);
  return value;
}
function invitationSecret(secret: string) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    throw new Error("Invalid invitation secret.");
}
function roleIdOf(value: string) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value))
    throw new Error("Invalid role ID.");
  return value;
}
function limit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > 50)
    throw new Error("Page limit must be between 1 and 50.");
  return String(value);
}
function boundedLimit(
  value: number | undefined,
  fallback: number,
  max: number,
) {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 1 || count > max)
    throw new Error(`Page limit must be between 1 and ${max}.`);
  return count;
}
function messageText(value: string, allowEmpty = false) {
  const text = typeof value === "string" ? value.trim() : "";
  // Same byte/control bounds as the service; a newline is allowed.
  // eslint-disable-next-line no-control-regex
  const hasControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(
    text,
  );
  if (
    (!text && !allowEmpty) ||
    new TextEncoder().encode(text).length > 4_000 ||
    hasControl
  )
    throw new Error("Use 1–4,000 UTF-8 bytes without control characters.");
  return text;
}
/** Room event and audit ids are decimal sequences; compare them with BigInt. */
function sequenceId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}
function eventCursor(value: string) {
  if (!sequenceId(value)) throw new Error("Invalid event cursor.");
  return value;
}
function chainId(value: unknown): ChatChainId {
  if (!isChatChainId(value)) throw new Error("Choose a supported network.");
  return value;
}
function isoTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Service responses are validated before use; a malformed one reads as a 502. */
function validated<T>(
  value: unknown,
  ok: (value: Record<string, unknown>) => boolean,
): T {
  if (!isRecord(value) || !ok(value)) throw new ChatClientError(502);
  return value as T;
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request canceled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
const EVENT_TYPES: readonly ChatEventType[] = [
  "message.created",
  "message.edited",
  "message.deleted",
  "message.reacted",
  "role.updated",
  "room.updated",
  "conversation.updated",
];
function validMessageRow(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    /^[1-9][0-9]{0,14}$/.test(value.id) &&
    typeof value.author === "string" &&
    typeof value.text === "string" &&
    new TextEncoder().encode(value.text).length <= 4_000 &&
    isoTime(value.createdAt)
  );
}
/** Chat text inside an event is untrusted data; this checks shape only. */
function validEvent(value: unknown): value is ChatEvent {
  if (!isRecord(value) || !sequenceId(value.id) || !isoTime(value.at))
    return false;
  const type = value.type as ChatEventType;
  if (!EVENT_TYPES.includes(type)) return false;
  if (value.channelId !== undefined) {
    if (
      typeof value.channelId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value.channelId)
    )
      return false;
  } else if (type.startsWith("message.")) return false;
  if (type === "message.created" || type === "message.edited")
    return validMessageRow(value.message);
  if (type.startsWith("message."))
    return (
      typeof value.messageId === "string" &&
      /^[1-9][0-9]{0,14}$/.test(value.messageId)
    );
  if (type === "role.updated") return typeof value.roleId === "string";
  if (type === "conversation.updated")
    return (
      typeof value.channelId === "string" &&
      (value.conversationRevision === undefined ||
        (Number.isSafeInteger(value.conversationRevision) &&
          (value.conversationRevision as number) >= 1))
    );
  return true;
}
/** Ids must rise within the page; the reader dedupes against its own cursor. */
function validEventPage(value: unknown, max: number) {
  return validated<ChatEventPage>(value, (page) => {
    if (
      !Array.isArray(page.events) ||
      page.events.length > max ||
      typeof page.resync !== "boolean" ||
      (page.nextAfter !== null && !sequenceId(page.nextAfter)) ||
      (page.oldestRetained !== null && !sequenceId(page.oldestRetained))
    )
      return false;
    let previous = -1n;
    for (const event of page.events) {
      if (!validEvent(event) || BigInt(event.id) <= previous) return false;
      previous = BigInt(event.id);
    }
    const last = page.events.at(-1) as ChatEvent | undefined;
    return !(
      last &&
      (page.nextAfter === null || BigInt(page.nextAfter) < BigInt(last.id))
    );
  });
}
function validReactions(value: unknown): value is ChatReaction[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.emoji === "string" &&
        Number.isInteger(item.count) &&
        (item.count as number) >= 0 &&
        typeof item.mine === "boolean",
    )
  );
}
function validWallets(value: unknown) {
  return validated<AccountWallets>(
    value,
    (body) =>
      !!normalizeChatPrincipal(body.principalId) &&
      Array.isArray(body.wallets) &&
      body.wallets.length <= ACCOUNT_METHOD_LIMITS.wallets &&
      body.wallets.every(
        (item) => isRecord(item) && isAddress(String(item.address)),
      ) &&
      Number.isInteger(body.walletRevision),
  );
}
// Sign-in methods on the account: EVM and Solana wallets.
function validAccountMethods(value: unknown): value is AccountMethods {
  if (!isRecord(value)) return false;
  const { wallets, canRemove } = value;
  return (
    Array.isArray(wallets) &&
    wallets.length <= ACCOUNT_METHOD_LIMITS.wallets &&
    wallets.every(
      (item) =>
        isRecord(item) &&
        isAddress(String(item.address)) &&
        (item.kind === "eoa" || item.kind === "contract") &&
        typeof item.addedAt === "string" &&
        typeof item.current === "boolean",
    ) &&
    isRecord(canRemove) &&
    typeof canRemove.wallets === "boolean" &&
    typeof canRemove.solanaWallets === "boolean" &&
    ((value.bitcoinWallets === undefined &&
      canRemove.bitcoinWallets === undefined) ||
      (typeof canRemove.bitcoinWallets === "boolean" &&
        Array.isArray(value.bitcoinWallets) &&
        value.bitcoinWallets.length <= ACCOUNT_METHOD_LIMITS.bitcoinWallets &&
        value.bitcoinWallets.every(
          (item) =>
            isRecord(item) &&
            isBitcoinAccountAddress(item.address) &&
            typeof item.addedAt === "string" &&
            typeof item.current === "boolean",
        ))) &&
    Array.isArray(value.solanaWallets) &&
    value.solanaWallets.length <= ACCOUNT_METHOD_LIMITS.solanaWallets &&
    value.solanaWallets.every(
      (item) =>
        isRecord(item) &&
        isSolanaAddress(item.address) &&
        typeof item.addedAt === "string" &&
        typeof item.current === "boolean",
    )
  );
}
function validAccount(value: unknown) {
  return validated<ChatAccount>(
    value,
    (body) =>
      !!normalizeChatPrincipal(body.principalId) &&
      typeof body.emailVerified === "boolean" &&
      (body.emailMasked === null || typeof body.emailMasked === "string") &&
      typeof body.alertEmailAvailable === "boolean" &&
      (body.wallet === null || isAddress(String(body.wallet))) &&
      Number.isSafeInteger(body.wallets) &&
      Number(body.wallets) >= 0 &&
      validAccountMethods(body.methods),
  );
}
// Team conversation ids are opaque and never a channel id.
const CONVERSATION_ID = /^tc-[0-9a-f]{32}$/;
/** A message client id is a UUIDv7 the caller persisted with the text. */
function clientId(value: string) {
  const id = typeof value === "string" ? value.toLowerCase() : "";
  if (
    !/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id)
  )
    throw new Error("Use a UUIDv7 message ID.");
  return id;
}
function conversationId(value: string) {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value))
    throw new Error("Invalid conversation ID.");
  return value;
}
/** Views the SDK may ask for. `needs-reply` lists the oldest wait first;
 * `needs-you` and `ai-handling` split it into the requests a person must
 * answer and the ones the AI agent is expected to answer now. */
const CONVERSATION_FILTERS: readonly TeamConversationFilter[] = [
  "open",
  "resolved",
  "all",
  "unassigned",
  "mine",
  "waiting",
  "needs-person",
  "needs-reply",
  "needs-you",
  "ai-handling",
  "waiting-on-member",
];
function validWorkflow(value: unknown): SupportWorkflow {
  return validated<SupportWorkflow>(
    value,
    (body) => isRecord(body.summary) && Array.isArray(body.attachments),
  );
}
function validConversation(value: unknown): TeamConversation {
  return validated<TeamConversation>(
    value,
    (body) =>
      typeof body.id === "string" &&
      CONVERSATION_ID.test(body.id) &&
      !!normalizeChatPrincipal(body.member) &&
      ["open", "resolved"].includes(String(body.state)) &&
      typeof body.staffMessagesStopped === "boolean" &&
      ["member", "team"].includes(String(body.viewer)) &&
      typeof body.canPost === "boolean" &&
      (body.previousConversation === undefined ||
        (body.viewer === "member" &&
          typeof body.previousConversation === "string" &&
          CONVERSATION_ID.test(body.previousConversation) &&
          body.previousConversation !== body.id)),
  );
}
function validBots(value: unknown) {
  return validated<ChatBots>(
    value,
    (body) =>
      Array.isArray(body.bots) &&
      body.bots.length <= 10 &&
      body.bots.every(
        (item) =>
          isRecord(item) &&
          !!normalizeChatPrincipal(item.principalId) &&
          typeof item.displayName === "string",
      ) &&
      Number.isInteger(body.revision),
  );
}
function isMemberProfile(body: Record<string, unknown>) {
  let nameValid = body.displayName === null;
  if (typeof body.displayName === "string") {
    try {
      nameValid = normalizeDisplayName(body.displayName) === body.displayName;
    } catch {
      nameValid = false;
    }
  }
  return (
    !!normalizeChatPrincipal(body.principalId) &&
    nameValid &&
    (body.avatar === null || !!profileMediaHash(body.avatar)) &&
    typeof body.agent === "boolean" &&
    (body.updatedAt === null ||
      (typeof body.updatedAt === "string" &&
        Number.isFinite(Date.parse(body.updatedAt))))
  );
}
function validProfile(value: unknown) {
  return validated<MemberProfile & { changesLeftToday: number }>(
    value,
    (body) =>
      isMemberProfile(body) &&
      Number.isSafeInteger(body.changesLeftToday) &&
      Number(body.changesLeftToday) >= 0,
  );
}
export type ChatEventsOptions = {
  /** Exclusive event id to start after. Omit to start at the newest events. */
  after?: string;
  /** Events per page, 1–200. Defaults to 100. */
  limit?: number;
  signal?: AbortSignal;
  /** Wait between polls while the room is quiet, 500–30,000 ms. Defaults to 2,000. */
  intervalMs?: number;
  /** Called when the cursor predates retained events. Refetch conversation pages before continuing. */
  onResync?: (page: { oldestRetained: string | null }) => void;
};
export type ChatSubscribeOptions = Omit<ChatEventsOptions, "limit">;
/** Create once and persist with the intended message before sending or retrying. */
export function newMessageId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff)
    throw new Error("Invalid message time.");
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(timestamp & 255n);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function pollInterval(value: number | undefined) {
  const ms = value ?? 2_000;
  if (!Number.isInteger(ms) || ms < 500 || ms > 30_000)
    throw new Error("Poll every 500 to 30,000 milliseconds.");
  return ms;
}
/** Transport failures, rate limits and unavailable answers are waited out; every other status stops the reader. */
function retryable(error: unknown): error is ChatClientError {
  return (
    error instanceof ChatClientError &&
    [0, 429, 502, 503, 504].includes(error.status)
  );
}
function retryDelay(error: ChatClientError, backoff: number) {
  return error.status === 429 && error.retryAfterSeconds !== null
    ? Math.min(error.retryAfterSeconds, 3_600) * 1_000
    : backoff;
}
/** Wraps one socket as a bounded frame queue. More than 1,000 unread frames
 * closes the socket; the subscriber catches up from its cursor afterwards. */
class SocketFeed {
  static readonly MAX_QUEUE = 1_000;
  private readonly frames: RealtimeServerFrame[] = [];
  private waiter: ((frame: RealtimeServerFrame | null) => void) | null = null;
  private open = false;
  private done = false;
  private readonly abort = () => this.close(1000, "canceled");
  constructor(
    private readonly socket: ChatSocket,
    private readonly signal?: AbortSignal,
  ) {
    socket.addEventListener("open", () => {
      this.open = true;
      this.opening?.(true);
    });
    socket.addEventListener("message", (event) => {
      if (this.done || typeof event.data !== "string") return;
      let frame: unknown;
      try {
        frame = event.data.length > 65_536 ? null : JSON.parse(event.data);
      } catch {
        frame = null;
      }
      if (!isRecord(frame) || typeof frame.type !== "string") {
        this.close(1002, "protocol");
        return;
      }
      if (this.frames.length >= SocketFeed.MAX_QUEUE) {
        this.close(1000, "overflow");
        return;
      }
      this.push(frame as RealtimeServerFrame);
    });
    socket.addEventListener("close", () => this.finish());
    socket.addEventListener("error", () => this.finish());
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  private opening: ((open: boolean) => void) | null = null;
  opened(timeoutMs: number) {
    if (this.open) return Promise.resolve(true);
    if (this.done) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.opening = null;
        this.close(1000, "timeout");
        resolve(false);
      }, timeoutMs);
      this.opening = (value) => {
        clearTimeout(timer);
        this.opening = null;
        resolve(value);
      };
    });
  }
  idle() {
    return this.frames.length === 0;
  }
  send(data: string) {
    if (this.done) return;
    try {
      this.socket.send(data);
    } catch {
      this.finish();
    }
  }
  /** Next frame; undefined after `timeoutMs` of silence; null once the socket is closed and drained. */
  next(timeoutMs: number) {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.done) return Promise.resolve(null);
    return new Promise<RealtimeServerFrame | null | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(undefined);
      }, timeoutMs);
      this.waiter = (frame) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(frame);
      };
    });
  }
  private push(frame: RealtimeServerFrame) {
    if (this.waiter) this.waiter(frame);
    else this.frames.push(frame);
  }
  private finish() {
    if (this.done) return;
    this.done = true;
    this.signal?.removeEventListener("abort", this.abort);
    this.opening?.(false);
    this.waiter?.(null);
  }
  close(code: number, reason: string) {
    if (this.done) return;
    try {
      this.socket.close(code, reason);
    } catch {
      // The socket is already gone.
    }
    this.finish();
  }
}

/** One client per wallet/process. No completed message or access cache; all reads go to the service. */
export class TemplChatClient {
  private readonly apiOrigin: string;
  private readonly appOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signer?: ChatSigner | ChatSolanaSigner;
  private readonly authChainId: ChatChainId;
  /** The signer's lowercase EVM address or its base58 Solana address. */
  private readonly signerAddress?: string;
  private readonly defaultRoom?: ChatDestination;
  private readonly Socket?: ChatSocketConstructor;
  readonly #cookies = new Map<string, { value: string; expiresAt: number }>();
  private signedSession:
    | ((ChatSession | ChatSolanaSession) & { signer: string })
    | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  constructor(options: ChatClientOptions = {}) {
    if ("templ" in options)
      throw new Error("Contract-address room destinations are not supported.");
    this.authChainId = options.authChainId ?? DEFAULT_CHAT_AUTH_CHAIN_ID;
    if (!isChatChainId(this.authChainId))
      throw new Error("Unsupported wallet network.");
    if ("window" in globalThis)
      throw new Error(
        "TemplChatClient is for Node/server agents, not browser code.",
      );
    const origins = clientOrigins(options);
    this.apiOrigin = origins.api;
    this.appOrigin = origins.app;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 30_000
    )
      throw new Error("Timeout must be 1–30 seconds.");
    this.signer = options.signer;
    this.signerAddress = options.signer
      ? isSolanaSigner(options.signer)
        ? solanaWallet(options.signer.address)
        : wallet(options.signer.address)
      : undefined;
    this.Socket =
      options.WebSocket ??
      (globalThis as { WebSocket?: ChatSocketConstructor }).WebSocket;
    if (options.roomId !== undefined)
      this.defaultRoom = destination(options as ChatDestination);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const revision = this.revision;
    const next = this.queue.then(() => {
      this.assertRevision(revision);
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private assertRevision(revision: number) {
    if (revision !== this.revision) throw new ChatClientError(401);
  }
  private assertSigner() {
    if (!this.signer || !this.signerAddress)
      throw new Error("Use a separate client for each signer wallet.");
    if (
      typeof this.signer.address !== "string" ||
      (isSolanaSigner(this.signer)
        ? this.signer.address
        : this.signer.address.toLowerCase()) !== this.signerAddress
    ) {
      this.#cookies.clear();
      this.signedSession = null;
      throw new ChatClientError(401);
    }
    return this.signerAddress;
  }
  private assertEvmSigner(): Address {
    const account = this.assertSigner();
    if (isSolanaSigner(this.signer!))
      throw new Error(
        "This client holds a Solana key. Sign in with signInWithSolana().",
      );
    return account as Address;
  }
  private authorized() {
    const account = this.assertSigner();
    this.cookieHeader();
    if (
      !this.signedSession ||
      this.signedSession.signer !== account ||
      this.signedSession.expiresAt <= Date.now() ||
      !this.#cookies.has(SESSION_COOKIE)
    )
      throw new ChatClientError(401);
    return this.signedSession.principalId;
  }
  private ownsServiceIdentity(value: unknown) {
    const id = normalizeChatPrincipal(value);
    const primary = this.authorized();
    return (
      id !== null &&
      (this.signedSession?.servicePrincipals ?? [primary]).includes(id)
    );
  }
  /** A management request is sent once. The service rechecks current authority. */
  private mutate<T>(
    target: ChatTarget | undefined,
    suffix: string,
    body: object,
    responseType?: "none",
  ) {
    const path = `${roomPath(target)}${suffix}`;
    // Snapshot the intent before it waits behind another authenticated request.
    const payload = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    return this.serial(() =>
      this.request<T>(
        path,
        {
          ...payload,
          expectedPrincipalId: this.authorized(),
        },
        responseType ? { responseType } : {},
      ),
    );
  }
  private cookieHeader() {
    for (const [name, item] of this.#cookies)
      if (item.expiresAt <= Date.now()) this.#cookies.delete(name);
    return [...this.#cookies]
      .map(([name, item]) => `${name}=${item.value}`)
      .join("; ");
  }
  private receiveCookies(headers: Headers) {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    // A comma inside Expires is not followed by a cookie-name=value pair.
    const raw =
      typeof extended.getSetCookie === "function"
        ? extended.getSetCookie()
        : [headers.get("set-cookie") ?? ""];
    const values = raw.flatMap((value) => value.split(/,(?=\s*[^\s;,=]+\s*=)/));
    for (const value of values) {
      const [pair, ...parts] = value.split(";");
      const equal = pair.indexOf("=");
      if (equal < 0) continue;
      const name = pair.slice(0, equal).trim();
      const token = pair.slice(equal + 1).trim();
      if (!cookieNames.has(name)) continue;
      const attributes = new Map(
        parts.map((part) => {
          const i = part.indexOf("=");
          return i < 0
            ? [part.trim().toLowerCase(), ""]
            : [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()];
        }),
      );
      if (
        attributes.has("domain") ||
        attributes.get("path") !== "/" ||
        !attributes.has("secure") ||
        !attributes.has("httponly")
      )
        continue;
      let expiresAt = Date.now() + SESSION_MS;
      if (attributes.has("max-age")) {
        const age = attributes.get("max-age")!;
        if (!/^-?\d+$/.test(age)) continue;
        expiresAt = Date.now() + Math.min(Number(age) * 1000, SESSION_MS);
      } else if (attributes.has("expires")) {
        expiresAt = Date.parse(attributes.get("expires")!);
        if (!Number.isFinite(expiresAt)) continue;
        expiresAt = Math.min(expiresAt, Date.now() + SESSION_MS);
      }
      if (expiresAt <= Date.now()) {
        this.#cookies.delete(name);
        continue;
      }
      if (/^[0-9a-f]{64}$/.test(token))
        this.#cookies.set(name, { value: token, expiresAt });
    }
  }
  private async request<T>(
    path: string,
    body?: object,
    options: {
      signal?: AbortSignal;
      maxResponseBytes?: number;
      rawBody?: Uint8Array;
      /** "none" expects 204 No Content and resolves to undefined. */
      responseType?: "json" | "bytes" | "none";
      /** Fixed Own support key endpoint only; never an arbitrary origin. */
      ownSupport?: boolean;
    } = {},
  ): Promise<T> {
    if (body && options.rawBody) throw new Error("Choose one request body.");
    const revision = this.revision;
    if (this.signer) this.assertSigner();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({
        Origin: options.ownSupport ? "https://secure-support.usetempl.com" : this.appOrigin,
        Accept:
          options.responseType === "bytes"
            ? "application/octet-stream"
            : "application/json",
      });
      const cookie = this.cookieHeader();
      if (options.ownSupport) headers.set("X-Templ-Secure", "1");
      if (cookie) headers.set("Cookie", cookie);
      if (body) headers.set("Content-Type", "application/json");
      if (options.rawBody)
        headers.set("Content-Type", "application/octet-stream");
      const response = await this.fetcher(`${options.ownSupport ? "https://secure-support.usetempl.com" : this.apiOrigin}${path}`, {
        method: body || options.rawBody ? "POST" : "GET",
        headers,
        ...(body
          ? { body: JSON.stringify(body) }
          : options.rawBody
            ? { body: Buffer.from(options.rawBody) }
            : {}),
        redirect: "manual",
        signal: controller.signal,
      });
      this.assertRevision(revision);
      if (this.signer) this.assertSigner();
      // Never carry a session or sign-in challenge to a redirect target.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ChatClientError(response.status);
      }
      if (options.ownSupport) {
        if (response.headers.has("set-cookie")) throw new ChatClientError(502);
      } else this.receiveCookies(response.headers);
      if (!response.ok) {
        if (response.status === 401) {
          this.signedSession = null;
          this.#cookies.delete(SESSION_COOKIE);
        }
        const retryAfter = response.headers.get("retry-after");
        const retrySeconds =
          retryAfter && /^\d+$/.test(retryAfter)
            ? Math.min(Number(retryAfter), 3600)
            : null;
        const refused = await errorReason(response);
        throw new ChatClientError(
          response.status,
          retrySeconds,
          undefined,
          refused.reason,
          refused.held,
        );
      }
      if (options.responseType === "none") {
        await response.body?.cancel();
        if (response.status !== 204) throw new ChatClientError(502);
        if (this.signer) this.assertSigner();
        this.assertRevision(revision);
        return undefined as T;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ChatClientError(502);
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > (options.maxResponseBytes ?? 1_048_576)) {
          await reader.cancel();
          throw new ChatClientError(502);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const value of chunks) {
        bytes.set(value, offset);
        offset += value.length;
      }
      if (this.signer) this.assertSigner();
      this.assertRevision(revision);
      if (options.responseType === "bytes") {
        if (
          bytes.length < 1 ||
          response.headers.get("content-type")?.split(";")[0].trim() !==
            "application/octet-stream"
        )
          throw new ChatClientError(502);
        return bytes as T;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as T;
    } catch (error) {
      if (options.signal?.aborted)
        throw new DOMException("Request canceled.", "AbortError");
      if (error instanceof ChatClientError) throw error;
      throw new ChatClientError(0);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
  private async waitForSessionTime(authenticatedAt: number, revision: number) {
    const ahead = authenticatedAt - Date.now();
    if (Number.isSafeInteger(authenticatedAt) && ahead > 0 && ahead <= 1_000)
      await new Promise<void>((resolve) => setTimeout(resolve, ahead));
    this.assertRevision(revision);
    this.assertSigner();
  }
  /** Accepts a wallet session for this signer. The session's `address` is
   * normally the signer; when it is another wallet, the signer must be one of
   * the account's proven wallets (GET /auth/wallets), because a person can add
   * an agent's wallet to their own account. */
  private async validateSession(
    value: ChatSession,
    revision: number,
  ): Promise<ChatSession> {
    const invalid = () => {
      this.#cookies.clear();
      this.signedSession = null;
      throw new Error("The wallet session could not be verified.");
    };
    if (
      !value ||
      typeof value.address !== "string" ||
      !isAddress(value.address)
    )
      return invalid();
    // Let a small server clock lead settle before applying the strict time checks.
    await this.waitForSessionTime(value.authenticatedAt, revision);
    const signer = this.assertEvmSigner();
    const address = wallet(value.address);
    const primary = normalizeChatPrincipal(value.principalId);
    const aliases = primary
      ? normalizeServicePrincipals(primary, value.servicePrincipals)
      : null;
    if (
      value.authMethod !== "wallet" ||
      !primary ||
      !aliases ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + SESSION_MS + 60_000 ||
      !Number.isSafeInteger(value.authenticatedAt) ||
      value.authenticatedAt <= 0 ||
      value.authenticatedAt > Date.now() ||
      !Number.isSafeInteger(value.walletRevision) ||
      value.walletRevision < 0 ||
      !Number.isSafeInteger(value.walletAuthorizationExpiresAt) ||
      value.walletAuthorizationExpiresAt < value.expiresAt ||
      !this.#cookies.has(SESSION_COOKIE)
    )
      return invalid();
    // A bare wallet account names itself; an account with other wallets must be
    // read back from the service before the signer is trusted as one of them.
    if (address !== signer || !aliases.includes(signer)) {
      if (!primary.startsWith("account:")) return invalid();
      let proven: AccountWallets;
      try {
        const params = new URLSearchParams({ expectedPrincipalId: primary });
        proven = validWallets(await this.request(`/auth/wallets?${params}`));
      } catch (error) {
        if (error instanceof ChatClientError && error.status === 401)
          return invalid();
        throw error;
      }
      this.assertRevision(revision);
      this.assertSigner();
      const wallets = proven.wallets.map((item) => wallet(item.address));
      if (
        proven.principalId !== primary ||
        !wallets.includes(signer) ||
        !wallets.includes(address)
      )
        return invalid();
    }
    this.signedSession = {
      address,
      signer,
      expiresAt: value.expiresAt,
      authenticatedAt: value.authenticatedAt,
      walletRevision: value.walletRevision,
      walletAuthorizationExpiresAt: value.walletAuthorizationExpiresAt,
      principalId: primary,
      servicePrincipals: aliases,
      authMethod: "wallet",
    };
    return {
      address,
      expiresAt: value.expiresAt,
      authenticatedAt: value.authenticatedAt,
      walletRevision: value.walletRevision,
      walletAuthorizationExpiresAt: value.walletAuthorizationExpiresAt,
      principalId: primary,
      servicePrincipals: [...aliases],
      authMethod: "wallet",
    };
  }
  private async readSession() {
    this.assertSigner();
    const revision = this.revision;
    try {
      const value = await this.request<ChatSession & ChatSolanaSession>(
        "/auth/session",
      );
      return isSolanaSigner(this.signer!)
        ? await this.validateSolanaSession(value, revision)
        : await this.validateSession(value, revision);
    } catch (error) {
      if (error instanceof ChatClientError && error.status === 401) return null;
      throw error;
    }
  }
  /** The current session, or null. A Solana key's client returns a
   * ChatSolanaSession. */
  session(): Promise<ChatSession | ChatSolanaSession | null> {
    return this.serial(() => this.readSession());
  }
  /** Signs in with the EVM signer (SIWE on the client's sign-in network),
   * reusing a current session. A Solana key uses signInWithSolana(). */
  signIn() {
    return this.serial(async () => {
      const revision = this.revision;
      const account = this.assertEvmSigner();
      const existing = (await this.readSession()) as ChatSession | null;
      this.assertRevision(revision);
      if (existing) return existing;
      const challenge = await this.request<{
        message: string;
        expiresAt: number;
      }>("/auth/nonce", { address: account, chainId: this.authChainId });
      this.assertRevision(revision);
      if (
        typeof challenge.message !== "string" ||
        challenge.message.length > 4096
      )
        throw new Error("Invalid Templ sign-in challenge.");
      const parsed = parseSiweMessage(challenge.message);
      const now = Date.now();
      if (
        parsed.address?.toLowerCase() !== account ||
        parsed.domain !== new URL(this.appOrigin).host ||
        parsed.uri !== this.appOrigin ||
        parsed.scheme !== "https" ||
        parsed.version !== "1" ||
        parsed.chainId !== this.authChainId ||
        parsed.statement !== "Sign in to your Templ chat." ||
        !parsed.nonce ||
        !/^[a-zA-Z0-9]{8,128}$/.test(parsed.nonce) ||
        !parsed.issuedAt ||
        !Number.isFinite(parsed.issuedAt.getTime()) ||
        parsed.issuedAt.getTime() > now + 60_000 ||
        parsed.issuedAt.getTime() < now - 5 * 60_000 ||
        !parsed.expirationTime ||
        !Number.isFinite(parsed.expirationTime.getTime()) ||
        parsed.expirationTime.getTime() <= now ||
        parsed.expirationTime.getTime() > now + 5 * 60_000 + 60_000 ||
        parsed.expirationTime.getTime() !== challenge.expiresAt ||
        parsed.notBefore ||
        parsed.requestId ||
        parsed.resources?.length ||
        this.#cookies.get(NONCE_COOKIE)?.value !== parsed.nonce
      )
        throw new Error("The sign-in request could not be verified.");
      const canonical = createSiweMessage({
        address: parsed.address!,
        chainId: this.authChainId,
        domain: new URL(this.appOrigin).host,
        uri: this.appOrigin,
        scheme: "https",
        version: "1",
        nonce: parsed.nonce,
        issuedAt: parsed.issuedAt,
        expirationTime: parsed.expirationTime,
        statement: "Sign in to your Templ chat.",
      });
      if (canonical !== challenge.message)
        throw new Error("The sign-in request could not be verified.");
      this.assertSigner();
      const signature = await (this.signer as ChatSigner).signMessage({
        message: challenge.message,
      });
      this.assertRevision(revision);
      this.assertSigner();
      if (
        !/^0x[0-9a-f]+$/i.test(signature) ||
        signature.length % 2 !== 0 ||
        signature.length > 8_194
      )
        throw new Error("Invalid wallet signature.");
      return this.validateSession(
        await this.request<ChatSession>("/auth/verify", {
          message: challenge.message,
          signature,
        }),
        revision,
      );
    });
  }
  /** Accepts a Solana session for this key: the service names the key's own
   * wallet and an account, and the session cookie arrived with it. */
  private async validateSolanaSession(
    value: ChatSolanaSession,
    revision: number,
  ): Promise<ChatSolanaSession> {
    const invalid = () => {
      this.#cookies.clear();
      this.signedSession = null;
      throw new Error("The wallet session could not be verified.");
    };
    if (!value) return invalid();
    await this.waitForSessionTime(value.authenticatedAt, revision);
    const signer = this.assertSigner();
    const primary = normalizeChatPrincipal(value?.principalId);
    const aliases = primary
      ? normalizeServicePrincipals(primary, value.servicePrincipals)
      : null;
    if (
      !value ||
      value.authMethod !== "solana" ||
      value.solanaAddress !== signer ||
      !primary ||
      !primary.startsWith("account:") ||
      !aliases ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + SESSION_MS + 60_000 ||
      !Number.isSafeInteger(value.authenticatedAt) ||
      value.authenticatedAt <= 0 ||
      value.authenticatedAt > Date.now() ||
      !this.#cookies.has(SESSION_COOKIE)
    )
      return invalid();
    const session: ChatSolanaSession = {
      solanaAddress: signer,
      expiresAt: value.expiresAt,
      authenticatedAt: value.authenticatedAt,
      principalId: primary,
      servicePrincipals: [...aliases],
      authMethod: "solana",
    };
    this.signedSession = { ...session, signer };
    return { ...session, servicePrincipals: [...aliases] };
  }
  /** Signs in with the Solana key (Sign In With Solana on the app's origin),
   * reusing a current session. The client checks every field of the
   * service's text, rebuilds it byte for byte and verifies the key's
   * signature before sending it. The key signs nothing else. */
  signInWithSolana() {
    return this.serial(async () => {
      const revision = this.revision;
      const address = this.assertSigner();
      if (!isSolanaSigner(this.signer!))
        throw new Error(
          "This client holds an EVM signer. Sign in with signIn().",
        );
      const existing = (await this.readSession()) as ChatSolanaSession | null;
      this.assertRevision(revision);
      if (existing) return existing;
      const challenge = await this.request<{
        message: string;
        expiresAt: number;
      }>("/auth/solana/nonce", { address });
      this.assertRevision(revision);
      if (
        typeof challenge.message !== "string" ||
        challenge.message.length > 4096
      )
        throw new Error("Invalid Templ sign-in challenge.");
      const parsed = parseSolanaSignInMessage(challenge.message);
      const now = Date.now();
      const issuedAt = Date.parse(parsed?.issuedAt ?? "");
      const expiresAt = Date.parse(parsed?.expirationTime ?? "");
      if (
        !parsed ||
        parsed.address !== address ||
        parsed.domain !== new URL(this.appOrigin).host ||
        parsed.uri !== this.appOrigin ||
        parsed.statement !== SIGN_IN_STATEMENT ||
        !/^[a-zA-Z0-9]{8,128}$/.test(parsed.nonce) ||
        !Number.isFinite(issuedAt) ||
        issuedAt > now + 60_000 ||
        issuedAt < now - 5 * 60_000 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + 5 * 60_000 + 60_000 ||
        expiresAt !== challenge.expiresAt ||
        parsed.resources.length ||
        this.#cookies.get(NONCE_COOKIE)?.value !== parsed.nonce
      )
        throw new Error("The sign-in request could not be verified.");
      const canonical = createSolanaSignInMessage({
        domain: new URL(this.appOrigin).host,
        address,
        statement: SIGN_IN_STATEMENT,
        uri: this.appOrigin,
        nonce: parsed.nonce,
        issuedAt: new Date(issuedAt),
        expirationTime: new Date(expiresAt),
      });
      if (canonical !== challenge.message)
        throw new Error("The sign-in request could not be verified.");
      const message = new TextEncoder().encode(challenge.message);
      this.assertSigner();
      const signature = await (this.signer as ChatSolanaSigner).signMessage({
        message,
      });
      this.assertRevision(revision);
      this.assertSigner();
      if (
        !(signature instanceof Uint8Array) ||
        signature.length !== 64 ||
        !ed25519Verifies(address, message, signature)
      )
        throw new Error("Invalid wallet signature.");
      const session = await this.request<ChatSolanaSession>(
        "/auth/solana/verify",
        { message: challenge.message, signature: paddedBase64(signature) },
      );
      this.assertRevision(revision);
      return this.validateSolanaSession(session, revision);
    });
  }
  signOut() {
    ++this.revision;
    this.signedSession = null;
    return this.serial(async () => {
      try {
        await this.request("/auth/logout", {});
      } finally {
        this.#cookies.clear();
        this.signedSession = null;
      }
    });
  }
  room(id = this.defaultRoom?.roomId) {
    const selected = roomId(id ?? "");
    return this.serial(async () =>
      validateRoom(
        await this.request<NativeRoom>(`/rooms/${selected}`),
        selected,
      ),
    );
  }
  /** Current native manager nominates a successor; null cancels the nomination. */
  nominateManager(next: ChatPrincipalId | null, id = this.defaultRoom?.roomId) {
    const selected = roomId(id ?? "");
    return this.mutate<NativeRoom>({ roomId: selected }, "/manager", {
      next: next === null ? null : principal(next),
    });
  }
  acceptManagement(id = this.defaultRoom?.roomId) {
    return this.mutate<NativeRoom>(
      { roomId: roomId(id ?? "") },
      "/manager/accept",
      {},
    );
  }
  createRoom(input: AgentRoomDraft, options: { maxAttempts?: 1 | 2 | 3 } = {}) {
    // Unlike prepareRoom, this method cannot invent an ID after an uncertain response.
    if (!input?.id)
      throw new Error(
        "Persist a prepared room with its UUID before creating it.",
      );
    const draft = prepareRoom(input);
    const attempts = options.maxAttempts ?? 2;
    if (![1, 2, 3].includes(attempts))
      throw new Error("Use 1–3 creation attempts.");
    return this.serial(async () => {
      this.authorized();
      for (let attempt = 1; ; attempt++) {
        try {
          this.authorized();
          const response = await this.request<CreatedRoom>("/rooms", {
            ...draft,
            expectedPrincipalId: this.authorized(),
          });
          const result = validateRoom(response, draft.id);
          if (
            !this.ownsServiceIdentity(result.creator) ||
            result.visibility !== draft.visibility ||
            typeof response.followed !== "boolean"
          )
            throw new ChatClientError(502);
          return { ...result, followed: response.followed };
        } catch (error) {
          if (
            !(error instanceof ChatClientError) ||
            attempt >= attempts ||
            ![0, 502, 503, 504].includes(error.status)
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    });
  }
  /** The secret belongs only in a URL fragment or POST body, never a logged URL. */
  previewInvitation(
    secret: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    invitationSecret(secret);
    return this.serial(() =>
      this.request<{ valid: true }>(`${roomPath(target)}/invites/preview`, {
        secret,
      }),
    );
  }
  acceptInvitation(
    secret: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    invitationSecret(secret);
    return this.serial(() =>
      this.request<{ ok: true; isMember: true }>(
        `${roomPath(target)}/invites/accept`,
        {
          secret,
          expectedPrincipalId: this.authorized(),
        },
      ),
    );
  }
  createInvitation(target: ChatTarget | undefined = this.defaultRoom) {
    return this.serial(() =>
      this.request<{ invitation: RoomInvitation; secret: string }>(
        `${roomPath(target)}/invites`,
        {
          expectedPrincipalId: this.authorized(),
        },
      ),
    );
  }
  invitations(target: ChatTarget | undefined = this.defaultRoom) {
    return this.serial(() => {
      this.authorized();
      return this.request<{ invitations: RoomInvitation[] }>(
        `${roomPath(target)}/invites`,
      );
    });
  }
  revokeInvitation(
    inviteId: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        inviteId,
      )
    )
      throw new Error("Invalid invitation ID.");
    return this.serial(() =>
      this.request<{ ok: true }>(`${roomPath(target)}/invites/revoke`, {
        inviteId,
        expectedPrincipalId: this.authorized(),
      }),
    );
  }
  /** The workspace state: product, roles, the viewer and bots. */
  workspaceState(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/channels`;
    return this.serial(() => this.request<ChatState>(path));
  }
  /** Staff roles need no transaction. enabled=false archives the role.
   * Saving a role with moderation powers is a privileged change. The service
   * needs a wallet sign-in from the last 15 minutes and `{ confirmed: true }`
   * once you have reviewed the change. */
  saveManualRole(
    input: AgentManualRoleDraft,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { confirmed?: true } = {},
  ) {
    const confirmed = privilegedConfirmation(options);
    const selected = destination(target);
    if (!selected.roomId)
      throw new Error("Use a native room for service-managed manual roles.");
    if (
      ["mode", "token", "amountRaw", "priceRaw", "minBalanceRaw"].some((key) =>
        Object.prototype.hasOwnProperty.call(input, key),
      )
    )
      throw new Error("Staff roles have no token requirements.");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new Error("Choose whether to enable this role.");
    return this.mutate<{ role: ChatRole }>(selected, "/roles", {
      ...roleMetadata(input),
      mode: "manual",
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...confirmed,
    });
  }
  roleGrant(
    id: string,
    member: ChatPrincipalId,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const path = `${roomPath(target)}/roles/${roleIdOf(id)}/grant?${new URLSearchParams({ principalId: principal(member) })}`;
    return this.serial(() => {
      this.authorized();
      return this.request<ChatRoleGrant>(path);
    });
  }
  /** Assigning or removing a role with moderation powers is a privileged
   * change, confirmed the same way as `saveManualRole`. */
  assignRole(
    id: string,
    member: ChatPrincipalId,
    granted: boolean,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { confirmed?: true; templStaffConfirmed?: true } = {},
  ) {
    if (typeof granted !== "boolean")
      throw new Error("Choose whether to assign or remove the role.");
    const confirmed = privilegedConfirmation(options);
    return this.mutate<{ ok: true }>(target, `/roles/${roleIdOf(id)}/assign`, {
      principalId: principal(member),
      granted,
      ...(options.templStaffConfirmed === true
        ? { templStaffConfirmed: true }
        : {}),
      ...confirmed,
    });
  }
  moderation(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/moderation`;
    return this.serial(() => {
      this.authorized();
      return this.request<ChatModeration>(path);
    });
  }
  mute(
    member: ChatPrincipalId,
    until: string | null,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      until !== null &&
      (typeof until !== "string" ||
        !Number.isFinite(Date.parse(until)) ||
        Date.parse(until) <= Date.now() ||
        Date.parse(until) > Date.now() + SESSION_MS)
    )
      throw new Error(
        "Choose a mute duration of up to 30 days, or null to unmute.",
      );
    return this.mutate<{ ok: true }>(target, "/mutes", {
      principalId: principal(member),
      until: until === null ? null : new Date(until).toISOString(),
    });
  }
  ban(
    member: ChatPrincipalId,
    banned: boolean,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (typeof banned !== "boolean")
      throw new Error("Choose whether to ban this member from posting.");
    return this.mutate<{ ok: true }>(target, "/bans", {
      principalId: principal(member),
      banned,
    });
  }
  appearance(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/appearance`;
    return this.serial(() => this.request<{ accentColor: string }>(path));
  }
  setAppearance(
    accentColor: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<{ accentColor: string }>(target, "/appearance", {
      accentColor: communityAccent(accentColor),
    });
  }
  reportRoom(
    draft: AgentReportDraft,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!draft.requestId)
      throw new Error("Persist the report before submitting it.");
    return this.mutate<AgentReportReceipt>(
      target,
      "/report",
      prepareReport(draft),
    );
  }
  /** Reports one message of a conversation the caller can read. The service
   * stores the message as the workspace holds it, never text from the caller. */
  reportMessage(
    input: AgentReportDraft & { conversationId: string; messageId: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!input.requestId)
      throw new Error("Persist the report before submitting it.");
    const { conversationId: thread, messageId: id, ...draft } = input;
    return this.mutate<AgentReportReceipt>(
      target,
      `/conversations/${conversationId(thread)}/messages/${messageId(id)}/report`,
      prepareReport(draft),
    );
  }
  subscriptions(options: { cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams({ limit: limit(options.limit) });
    if (options.cursor) {
      if (!options.cursor.startsWith("room:"))
        throw new Error("Use a native room cursor.");
      query.set("cursor", `room:${roomId(options.cursor.slice(5))}`);
    }
    return this.serial(() => {
      this.authorized();
      return this.request<ChatSubscriptions>(`/subscriptions?${query}`);
    });
  }
  follow(templ: ChatTarget | undefined = this.defaultRoom, subscribed = true) {
    return this.serial(() =>
      this.request<{ ok: true }>("/subscriptions", {
        ...destination(templ),
        subscribed,
        expectedPrincipalId: this.authorized(),
      }),
    );
  }
  /** The team searches the support inbox; a member names their own
   * conversation. 20 hits per page. Keep the returned cursor exactly. */
  search(
    query: string,
    options: { conversationId?: string; cursor?: string; limit?: number } = {},
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const params = new URLSearchParams({ q: searchQuery(query) });
    if (options.conversationId !== undefined)
      params.set("channel", conversationId(options.conversationId));
    else params.set("scope", "support");
    if (options.cursor !== undefined) {
      if (
        typeof options.cursor !== "string" ||
        !/^(?:[A-Za-z0-9_-]{1,120}|sp1\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]{1,100})$/.test(
          options.cursor,
        )
      )
        throw new Error("Invalid search cursor.");
      params.set("cursor", options.cursor);
    }
    if (options.limit !== undefined)
      params.set(
        "limit",
        String(boundedLimit(options.limit, SEARCH_PAGE, SEARCH_PAGE)),
      );
    const path = `${roomPath(target)}/search?${params}`;
    return this.serial(async () => {
      this.authorized();
      return validated<
        ChatSearchPage & { authors?: Record<string, ChatAuthorFacts> }
      >(
        await this.request(path),
        (body) =>
          Array.isArray(body.hits) &&
          body.hits.length <= SEARCH_PAGE &&
          typeof body.indexing === "boolean" &&
          (body.nextCursor === null || typeof body.nextCursor === "string"),
      );
    });
  }
  /** Manager only. Entries carry ids and metadata, never message text. The
   * access stream keeps role, staff, bot, widget and support-setting changes
   * and chat downloads for 365 days; chats, the default, keeps the rest for
   * 90 days. Each stream has its own ids and cursors. */
  audit(
    target: ChatTarget | undefined = this.defaultRoom,
    options: { before?: string; limit?: number; stream?: AuditStream } = {},
  ) {
    const params = new URLSearchParams({
      limit: String(
        boundedLimit(options.limit, MAX_AUDIT_PAGE, MAX_AUDIT_PAGE),
      ),
    });
    if (options.before !== undefined)
      params.set("before", eventCursor(options.before));
    if (options.stream !== undefined) {
      if (options.stream !== "access" && options.stream !== "chats")
        throw new Error("Choose the access or chats stream.");
      params.set("stream", options.stream);
    }
    const path = `${roomPath(target)}/audit?${params}`;
    return this.serial(async () => {
      this.authorized();
      return validated<ChatAuditPage>(
        await this.request(path),
        (body) =>
          Array.isArray(body.entries) &&
          body.entries.length <= MAX_AUDIT_PAGE &&
          body.entries.every(
            (entry) =>
              isRecord(entry) && sequenceId(entry.id) && isoTime(entry.at),
          ) &&
          (body.nextBefore === null || sequenceId(body.nextBefore)),
      );
    });
  }
  // Profiles and linked wallets (account routes outside the room prefix).
  profile() {
    return this.serial(async () => {
      const params = new URLSearchParams({
        expectedPrincipalId: this.authorized(),
      });
      return validProfile(await this.request(`/auth/profile?${params}`));
    });
  }
  /** Three changes per day. Avatars must be a /media upload by this account. */
  setProfile(update: ProfileUpdate) {
    const body = profileUpdate(update, this.apiOrigin);
    return this.serial(async () =>
      validProfile(
        await this.request("/auth/profile", {
          ...body,
          expectedPrincipalId: this.authorized(),
        }),
      ),
    );
  }
  /** Public profile fields for up to 50 accounts; unknown ids are omitted. */
  profiles(members: ChatPrincipalId[]) {
    if (!Array.isArray(members) || members.length < 1 || members.length > 50)
      throw new Error("Request up to 50 profiles at a time.");
    const list = [...new Set(members.map(principal))];
    const params = new URLSearchParams({ ids: list.join(",") });
    return this.serial(async () =>
      validated<MemberProfilePage>(
        await this.request(`/profiles?${params}`),
        (body) =>
          Array.isArray(body.profiles) &&
          body.profiles.length <= list.length &&
          body.profiles.every(
            (item) => isRecord(item) && isMemberProfile(item),
          ),
      ),
    );
  }
  private accountMutate<T>(path: string, body: object) {
    const payload = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    return this.serial(() =>
      this.request<T>(path, {
        ...payload,
        expectedPrincipalId: this.authorized(),
      }),
    );
  }
  // Sign-in methods. An agent signs in with a wallet; a person can
  // add that wallet to their own account and remove it later.
  /** The account behind this session and its wallets. */
  account() {
    return this.serial(async () => {
      const expectedPrincipalId = this.authorized();
      const params = new URLSearchParams({ expectedPrincipalId });
      const account = validAccount(
        await this.request(`/auth/account?${params}`),
      );
      if (account.principalId !== expectedPrincipalId)
        throw new ChatClientError(502);
      return account;
    });
  }
  /** Proven wallets on this account. */
  wallets() {
    return this.serial(async () => {
      const params = new URLSearchParams({
        expectedPrincipalId: this.authorized(),
      });
      return validWallets(await this.request(`/auth/wallets?${params}`));
    });
  }
  /** Proves a second wallet with its own signature. One wallet links to one account at a time. */
  addWallet(input: {
    address: Address;
    chainId: ChatChainId;
    sign: (message: string) => Promise<Hex>;
  }) {
    const address = wallet(input.address);
    const network = chainId(input.chainId);
    if (typeof input.sign !== "function")
      throw new Error("Supply a sign function for the wallet to add.");
    return this.serial(async () => {
      const revision = this.revision;
      const actor = this.authorized();
      const challenge = await this.request<{
        message: string;
        expiresAt: number;
      }>("/auth/wallets/nonce", {
        address,
        chainId: network,
        expectedPrincipalId: actor,
      });
      this.assertRevision(revision);
      if (
        typeof challenge.message !== "string" ||
        challenge.message.length > 4096
      )
        throw new Error("Invalid wallet challenge.");
      const parsed = parseSiweMessage(challenge.message);
      const now = Date.now();
      if (
        parsed.address?.toLowerCase() !== address ||
        parsed.domain !== new URL(this.appOrigin).host ||
        parsed.uri !== this.appOrigin ||
        parsed.scheme !== "https" ||
        parsed.version !== "1" ||
        parsed.chainId !== network ||
        parsed.statement !== WALLET_LINK_STATEMENT ||
        !parsed.nonce ||
        !/^[a-zA-Z0-9]{8,128}$/.test(parsed.nonce) ||
        !parsed.issuedAt ||
        parsed.issuedAt.getTime() > now + 60_000 ||
        parsed.issuedAt.getTime() < now - 5 * 60_000 ||
        !parsed.expirationTime ||
        parsed.expirationTime.getTime() <= now ||
        parsed.expirationTime.getTime() > now + 6 * 60_000 ||
        parsed.expirationTime.getTime() !== challenge.expiresAt ||
        parsed.notBefore ||
        parsed.requestId ||
        parsed.resources?.[0] !==
          `${WALLET_LINK_RESOURCE_PREFIXES.principal}${actor}` ||
        this.#cookies.get(NONCE_COOKIE)?.value !== parsed.nonce
      )
        throw new Error("The wallet challenge could not be verified.");
      const signature = await input.sign(challenge.message);
      this.assertRevision(revision);
      if (
        typeof signature !== "string" ||
        !/^0x[0-9a-f]+$/i.test(signature) ||
        signature.length % 2 !== 0 ||
        signature.length > 8_194
      )
        throw new Error("Invalid wallet signature.");
      return validWallets(
        await this.request("/auth/wallets/verify", {
          message: challenge.message,
          signature,
          expectedPrincipalId: this.authorized(),
        }),
      );
    });
  }
  removeWallet(address: Address) {
    return this.accountMutate<AccountWallets>("/auth/wallets/remove", {
      address: wallet(address),
    }).then(validWallets);
  }
  // Registered AI agent identities. Registration grants no permission.
  /** Uses the same workspace metadata access as workspaceState(). */
  bots(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/bots`;
    return this.serial(async () => validBots(await this.request(path)));
  }
  /** Manager or manageRoles. Each AI agent replies through its own session and role. */
  registerBot(
    input: { principalId: ChatPrincipalId; displayName: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<ChatBots>(target, "/bots", {
      principalId: principal(input.principalId),
      displayName: normalizeBotDisplayName(input.displayName),
    }).then(validBots);
  }
  /** Manager only: registers the account a Solana wallet signed in to Templ
   * with. The service looks the wallet up only for this registration, after a
   * wallet sign-in in the last 15 minutes, and answers 404
   * "unknown-solana-wallet" alike for a wallet no account proved and one that
   * left its account. The wallet is never stored as the bot. The lookup is a
   * privileged change: pass `{ confirmed: true }` after reviewing it, or the
   * service refuses it. */
  registerSolanaBot(
    input: { solanaAddress: string; displayName: string },
    target: ChatTarget | undefined = this.defaultRoom,
    options: { confirmed?: true } = {},
  ) {
    const confirmed = privilegedConfirmation(options);
    return this.mutate<ChatBots>(target, "/bots", {
      principalId: solanaWallet(input.solanaAddress),
      displayName: normalizeBotDisplayName(input.displayName),
      ...confirmed,
    }).then(validBots);
  }
  removeBot(
    bot: ChatPrincipalId,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<ChatBots>(
      target,
      `/bots/${encodeURIComponent(principal(bot))}/remove`,
      {},
    ).then(validBots);
  }
  // Member-to-team conversations. One record per (room, member);
  // the team is the manager plus staff with handleConversations. Nothing here
  // reaches another member, and a display name confers nothing.
  /** Own's separately approved encrypted endpoint. It never carries native
   * credentials to a customer-supplied URL or another workspace. Payloads are
   * public keys, metadata and ciphertext only. */
  ownEncryptedSupport<T = unknown>(path: string, body?: object): Promise<T> {
    const workspace = "01a0fe6b-fccc-7633-b0e8-bcb29c000ebb";
    if (this.defaultRoom?.roomId !== workspace || this.appOrigin !== "https://usetempl.com" ||
        !["https://community.usetempl.com", "https://api.usetempl.com"].includes(this.apiOrigin))
      throw new Error("Encrypted Own support requires its exact production workspace.");
    const keys = /^\/keys\/team\/(?:challenge|enroll|validate|recover|revoke-device)$/.test(path);
    const native = path === "/conversations/encryption/settle-ai" || /^\/conversations\/tc-[a-f0-9]{32}\/(?:messages|encryption\/[1-9][0-9]{0,7}(?:\/(?:directory|history|outcome|enroll|fence|revoke|ai-context|ai-handoff))?)(?:\?[A-Za-z0-9=&-]+)?$/.test(path);
    if ((!keys && !native) || (keys && body === undefined)) throw new Error("Use an encrypted support route.");
    const payload = body === undefined ? undefined : JSON.parse(JSON.stringify(body)) as object;
    return this.serial(() => {
      const principalId = this.authorized();
      if (principalId !== "0xf8a112e144a7dbb7f3397df7160ac3bb4be5c9d5") throw new ChatClientError(403);
      return this.request<T>(keys ? path : `/rooms/${workspace}${path}`,
        payload === undefined ? undefined : keys ? payload : {...payload, expectedPrincipalId: principalId},
        {maxResponseBytes: 4 * 1024 * 1024, ...(keys ? {ownSupport: true} : {})});
    });
  }
  /** What this viewer may do with team conversations here. Anonymous readers get canAsk false. */
  conversationStatus(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/conversations/status`;
    return this.serial(async () =>
      validated<TeamConversationStatus>(
        await this.request(path),
        (body) =>
          typeof body.available === "boolean" &&
          typeof body.canAsk === "boolean" &&
          typeof body.team === "boolean" &&
          typeof body.canStart === "boolean" &&
          (body.mine === null ||
            (typeof body.mine === "string" &&
              CONVERSATION_ID.test(body.mine))) &&
          isRecord(body.limits),
      ),
    );
  }
  /** The team sees every conversation; a member sees only their own; anyone else an empty list.
   * Team rows carry `ai`, the request's AI mode; a registered bot's lists leave out requests with the AI off.
   * Templ counts the workspace's AI agent as active for a minute after it lists `needs-reply`, `open` or
   * `ai-handling`, or reads or writes a thread; use `needs-reply` as the agent's queue. */
  conversations(
    target: ChatTarget | undefined = this.defaultRoom,
    options: { filter?: TeamConversationFilter; cursor?: string } = {},
  ) {
    const params = new URLSearchParams();
    if (options.filter !== undefined) {
      if (!CONVERSATION_FILTERS.includes(options.filter))
        throw new Error(
          `Filter conversations by ${CONVERSATION_FILTERS.slice(0, -1).join(", ")} or ${CONVERSATION_FILTERS[CONVERSATION_FILTERS.length - 1]}.`,
        );
      params.set("filter", options.filter);
    }
    if (options.cursor !== undefined) {
      if (
        typeof options.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(options.cursor)
      )
        throw new Error("Invalid conversation cursor.");
      params.set("cursor", options.cursor);
    }
    const query = params.toString();
    const path = `${roomPath(target)}/conversations${query ? `?${query}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      return validated<TeamConversationList>(
        await this.request(path),
        (body) =>
          CONVERSATION_FILTERS.includes(
            body.filter as TeamConversationFilter,
          ) &&
          Array.isArray(body.conversations) &&
          (body.nextCursor === null || typeof body.nextCursor === "string"),
      );
    });
  }
  /** Opens or reuses the member's latest conversation and clears their stop preference.
   * `newCaseFrom` starts a separate case after that resolved case, with a real
   * message and a fresh client ID. Retrying returns the same case and message. */
  askTeam(
    input: { text?: string; clientId?: string; newCaseFrom?: string } = {},
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body: Record<string, unknown> = {};
    if (input.text !== undefined) body.text = messageText(input.text);
    if (input.clientId !== undefined) body.clientId = clientId(input.clientId);
    if (input.newCaseFrom !== undefined) {
      body.newCaseFrom = conversationId(input.newCaseFrom);
      if (body.text === undefined || body.clientId === undefined)
        throw new Error("A new case needs a message and a new message ID.");
    }
    return this.mutate<{
      conversation: TeamConversation;
      message?: ChatMessage;
    }>(target, "/conversations/ask", body).then((result) =>
      validated<{ conversation: TeamConversation; message?: ChatMessage }>(
        result,
        (page) => {
          const conversation = validConversation(page.conversation);
          if (
            input.newCaseFrom !== undefined &&
            (conversation.previousConversation !== input.newCaseFrom ||
              conversation.id === input.newCaseFrom ||
              !isRecord(page.message))
          )
            return false;
          return page.message === undefined || isRecord(page.message);
        },
      ),
    );
  }
  /** Staff with messageMembers only. `member` is a current member's principal,
   * never a wallet, name or email; 409 while the member stopped team messages. */
  startConversation(
    input: { member: ChatPrincipalId; text: string; clientId?: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body: Record<string, unknown> = {
      member: principal(input.member),
      text: messageText(input.text),
    };
    if (input.clientId !== undefined) body.clientId = clientId(input.clientId);
    return this.mutate<{
      conversation: TeamConversation;
      message: ChatMessage;
    }>(target, "/conversations/start", body).then((result) =>
      validated<{ conversation: TeamConversation; message: ChatMessage }>(
        result,
        (page) => {
          validConversation(page.conversation);
          return isRecord(page.message);
        },
      ),
    );
  }
  /** The fixed member or the current team; anyone else gets 404. */
  conversation(id: string, target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/conversations/${conversationId(id)}`;
    return this.serial(async () => {
      this.authorized();
      const result = await this.request<{ conversation: TeamConversation }>(
        path,
      );
      return validConversation(isRecord(result) ? result.conversation : null);
    });
  }
  conversationMessages(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { before?: string; limit?: number } = {},
  ) {
    const query = new URLSearchParams({ limit: limit(options.limit) });
    if (options.before !== undefined)
      query.set("before", messageId(options.before));
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/messages?${query}`;
    return this.serial(async () => {
      this.authorized();
      return validated<TeamConversationMessages>(
        await this.request(path),
        (body) => {
          validConversation(body.conversation);
          return (
            Array.isArray(body.messages) &&
            (body.nextBefore === null || typeof body.nextBefore === "string") &&
            (body.typing === undefined ||
              body.typing === null ||
              body.typing === "agent" ||
              body.typing === "team")
          );
        },
      );
    });
  }
  /** Same rules as any post: mutes, bans, rate limits and history
   * capacity apply, and a staff message never lands while the member stopped
   * team messages. A member reply reopens a resolved conversation. With
   * ifLatest the service refuses the reply (409, reason stale) when a newer
   * or edited message arrived after the one you read. A registered bot gets
   * 409 ai-drafts-only or ai-off when a person set the request to drafts
   * only or AI off, before the ifLatest check. A person's reply switches a
   * request in AI answers to drafts only. */
  replyInConversation(
    id: string,
    input: {
      text: string;
      clientId?: string;
      replyTo?: string;
      ifLatest?: { id: string; revision: number };
      /** The registered AI agent: why it wrote this reply, for the team
       * only. Figures cite evidence rows with [ev:n] markers in the text;
       * the service removes the markers before storing. When the workspace
       * holds replies whose figures fail the citation check, the reply
       * becomes a draft for the team and the call fails with 422
       * reply-held and `error.held`. */
      provenance?: SupportAiProvenance;
      /** A person sending a ready AI draft (edited or as written): links
       * the reply to the draft. Never blocks the reply. */
      fromDraft?: string;
    },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body: Record<string, unknown> = { text: messageText(input.text) };
    if (input.clientId !== undefined) body.clientId = clientId(input.clientId);
    if (input.replyTo !== undefined) body.replyTo = messageId(input.replyTo);
    if (input.ifLatest !== undefined)
      body.ifLatest = latestMessage(input.ifLatest);
    if (input.provenance !== undefined)
      body.provenance = checkedProvenance(input.provenance);
    if (input.fromDraft !== undefined)
      body.fromDraft = clientId(input.fromDraft);
    return this.mutate<{
      message: ChatMessage;
      conversation: TeamConversation;
      draftLinked?: boolean;
    }>(target, `/conversations/${conversationId(id)}/messages`, body).then(
      (result) =>
        validated<{
          message: ChatMessage;
          conversation: TeamConversation;
          draftLinked?: boolean;
        }>(result, (page) => {
          validConversation(page.conversation);
          return (
            isRecord(page.message) &&
            (page.draftLinked === undefined ||
              typeof page.draftLinked === "boolean")
          );
        }),
    );
  }
  /** Staff and registered bots that may reply here: tells the member a reply
   * is being written. The mark carries no text, names no one and lapses about
   * 12 seconds after the service accepts it, so repeat it about every 8
   * seconds while writing. Posting a reply clears it. The service accepts one
   * update per account and conversation every 2 seconds and ignores extra
   * calls. Members and widget visitors are refused. Anyone else gets the
   * refusal a reply here would get then, including for a paused or
   * suspended workspace. This client sends requests in order, so skip a refresh while
   * the previous mark is pending or slow marks queue ahead of the reply. A
   * registered bot gets 409 ai-drafts-only or ai-off when a person set the
   * request to drafts only or AI off. */
  markTyping(id: string, target: ChatTarget | undefined = this.defaultRoom) {
    return this.mutate<void>(
      target,
      `/conversations/${conversationId(id)}/typing`,
      {},
      "none",
    );
  }
  /** Team resolves or reopens; a member may reopen their own. Staff cannot
   * reopen a stopped one. The team may record how long a request took, as
   * one of SUPPORT_TIME_SPENT, when resolving. A registered bot gets 409
   * ai-drafts-only or ai-off when a person set the request to drafts only
   * or AI off. */
  resolveConversation(
    id: string,
    resolved: boolean,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { timeSpent?: SupportTimeSpent; ifRevision?: number } = {},
  ) {
    if (typeof resolved !== "boolean")
      throw new Error("Resolve takes true or false.");
    const body: Record<string, unknown> = { resolved };
    if (options.ifRevision !== undefined) {
      if (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 0)
        throw new Error("Include the case revision.");
      body.ifRevision = options.ifRevision;
    }
    if (options.timeSpent !== undefined) {
      if (!resolved || !SUPPORT_TIME_SPENT.includes(options.timeSpent))
        throw new Error(
          `Record time spent only when resolving, as ${SUPPORT_TIME_SPENT.join(", ")}.`,
        );
      body.timeSpent = options.timeSpent;
    }
    return this.mutate<{ conversation: TeamConversation }>(
      target,
      `/conversations/${conversationId(id)}/resolve`,
      body,
    ).then((result) =>
      validConversation(isRecord(result) ? result.conversation : null),
    );
  }
  /** The fixed member or the current team. Staff and registered bots get
   * tags, notes, activity and presence; the member gets their safe subset. */
  conversationWorkflow(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { notesBefore?: string } = {},
  ) {
    const query = new URLSearchParams();
    if (options.notesBefore !== undefined) {
      if (
        typeof options.notesBefore !== "string" ||
        !/^[0-9]{1,16}$/.test(options.notesBefore)
      )
        throw new Error("Invalid note cursor.");
      query.set("notesBefore", options.notesBefore);
    }
    const search = query.toString();
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/workflow${search ? `?${search}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      const result = await this.request(path);
      return validWorkflow(isRecord(result) ? result.workflow : null);
    });
  }
  /** Reads only this workspace's current manager guidance. The server checks
   * current manager or registered AI-agent access on every call. */
  readSupportAiGuidance(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/conversations/knowledge/guidance`;
    return this.serial(async () => {
      this.authorized();
      const value = await this.request(path);
      if (!checkedWorkspaceAiGuidance(value))
        throw new Error("The workspace returned invalid AI guidance.");
      return value;
    });
  }
  /** Read every page to obtain all current, member-safe document and FAQ chunks.
   * Each page checks current team access. A changed version requires a fresh read. */
  readSupportKnowledgeContext(
    target: ChatTarget | undefined = this.defaultRoom,
    options: { after?: string; version?: string } = {},
  ): Promise<KnowledgeContextPage> {
    const cursor = /^kb-[a-f0-9]{16}:([1-9][0-9]{0,2})$/;
    const validCursor = (value: unknown) =>
      typeof value === "string" &&
      cursor.test(value) &&
      Number(cursor.exec(value)![1]) <= KNOWLEDGE_LIMITS.chunksPerSource;
    if (
      (options.after !== undefined && !validCursor(options.after)) ||
      (options.version !== undefined &&
        (typeof options.version !== "string" ||
          !/^[a-f0-9]{64}$/.test(options.version))) ||
      (options.after !== undefined && options.version === undefined)
    )
      throw new Error("Use the previous knowledge page and version.");
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", options.after);
    if (options.version !== undefined) query.set("version", options.version);
    const path = `${roomPath(target)}/conversations/knowledge/context${query.size ? `?${query}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      const value = await this.request(path);
      return validated<KnowledgeContextPage>(
        value,
        (page) =>
          Object.keys(page).sort().join() === "hits,nextCursor,version" &&
          typeof page.version === "string" &&
          /^[a-f0-9]{64}$/.test(page.version) &&
          (options.version === undefined || page.version === options.version) &&
          (page.nextCursor === null || validCursor(page.nextCursor)) &&
          Array.isArray(page.hits) &&
          page.hits.length <= 64 &&
          (page.nextCursor === null ||
            (page.hits.length === 64 &&
              page.nextCursor ===
                String(page.hits.at(-1)?.sourceId)
                  .slice(3)
                  .replace(/-([1-9][0-9]{0,2})$/, ":$1"))) &&
          new Set(page.hits.map((hit) => (isRecord(hit) ? hit.sourceId : null)))
            .size === page.hits.length &&
          page.hits.every(
            (hit) =>
              isRecord(hit) &&
              typeof hit.sourceId === "string" &&
              /^kb:kb-[a-f0-9]{16}-[1-9][0-9]{0,2}$/.test(hit.sourceId) &&
              Number(hit.sourceId.slice(hit.sourceId.lastIndexOf("-") + 1)) <=
                KNOWLEDGE_LIMITS.chunksPerSource &&
              Object.keys(hit).every((key) =>
                [
                  "sourceId",
                  "kind",
                  "title",
                  "excerpt",
                  "url",
                  "era",
                  "visibility",
                  "updatedAt",
                ].includes(key),
              ) &&
              ["doc", "faq", "saved-reply"].includes(String(hit.kind)) &&
              typeof hit.title === "string" &&
              !!hit.title.trim() &&
              hit.title.length <= KNOWLEDGE_LIMITS.titleChars &&
              typeof hit.excerpt === "string" &&
              !!hit.excerpt.trim() &&
              hit.excerpt.length <= KNOWLEDGE_LIMITS.chunkChars &&
              hit.era === "current" &&
              hit.visibility === "member-safe" &&
              hit.archivedAt === undefined &&
              typeof hit.updatedAt === "string" &&
              Number.isFinite(Date.parse(hit.updatedAt)) &&
              (hit.url === undefined ||
                (typeof hit.url === "string" && /^https:\/\//.test(hit.url))),
          ),
      );
    });
  }
  /** Current team access is checked on every search. Member answers read
   * member-safe current sources only. This never grants access to another workspace. */
  searchSupportKnowledge(
    text: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > KNOWLEDGE_LIMITS.queryChars
    )
      throw new Error("Ask with up to 500 characters.");
    return this.mutate<{ hits: KnowledgeSearchHit[] }>(
      target,
      "/conversations/knowledge/search",
      {
        text: text.trim(),
        limit: 8,
        audience: "member",
        eras: ["current"],
      },
    ).then((result) => {
      const hits = isRecord(result) ? result.hits : undefined;
      if (
        !Array.isArray(hits) ||
        hits.length > 8 ||
        hits.some(
          (hit) =>
            !isRecord(hit) ||
            typeof hit.sourceId !== "string" ||
            !hit.sourceId.trim() ||
            hit.sourceId.length > 160 ||
            !["doc", "faq", "profile", "saved-reply"].includes(
              hit.kind as string,
            ) ||
            typeof hit.title !== "string" ||
            !hit.title.trim() ||
            hit.title.length > KNOWLEDGE_LIMITS.titleChars ||
            typeof hit.excerpt !== "string" ||
            !hit.excerpt.trim() ||
            hit.excerpt.length > KNOWLEDGE_LIMITS.excerptChars ||
            hit.era !== "current" ||
            hit.visibility !== "member-safe" ||
            hit.archivedAt !== undefined ||
            typeof hit.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(hit.updatedAt)) ||
            (hit.url !== undefined && typeof hit.url !== "string"),
        )
      )
        throw new Error("The workspace returned invalid knowledge.");
      return hits;
    });
  }
  /** Team only: an internal note the member never sees. Retries with the
   * same clientId return the first note. Up to 4,000 bytes, and up to 10
   * mentions of current support staff. In a drafts-only request this is
   * where a registered bot writes its draft; with the AI off it gets 409
   * ai-off. */
  addConversationNote(
    id: string,
    input: { text: string; clientId: string; mentions?: ChatPrincipalId[]; interactionPolicy?: "bounded-v1" },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body: Record<string, unknown> = {
      action: "note",
      text: messageText(input.text),
      clientId: clientId(input.clientId),
    };
    if (input.interactionPolicy !== undefined) {
      if (input.interactionPolicy !== "bounded-v1") throw new Error("Use the supported AI interaction policy.");
      body.interactionPolicy = input.interactionPolicy;
    }
    if (input.mentions !== undefined) {
      if (!Array.isArray(input.mentions) || input.mentions.length > 10)
        throw new Error("Mention up to 10 staff accounts.");
      body.mentions = [...new Set(input.mentions.map(principal))];
    }
    return this.mutate<{ workflow: SupportWorkflow }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      body,
    ).then((result) =>
      validWorkflow(isRecord(result) ? result.workflow : null),
    );
  }
  /** Team only, registered bots included: ask a person to answer. Takes a
   * fixed reason and no text. Posts no message and counts nothing; the member
   * sees that the team will reply. Until a person replies, takes or assigns
   * the request, or resolves it, the service refuses this workspace's
   * registered bots with 409 handed-off. Repeating it for the same request
   * changes nothing. With ifLatest the service refuses it (409, reason stale)
   * when a newer or edited message arrived after the one you read. A bot
   * may still hand off in a drafts-only request and gets 409 ai-off when
   * the AI is off. */
  handOff(
    id: string,
    input: {
      reason: SupportHandoffReason;
      ifLatest?: { id: string; revision: number };
    },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      !input ||
      typeof input !== "object" ||
      !SUPPORT_HANDOFF_REASONS.includes(input.reason)
    )
      throw new Error(
        `Choose a handoff reason: ${SUPPORT_HANDOFF_REASONS.join(", ")}.`,
      );
    const body: Record<string, unknown> = {
      action: "handoff",
      reason: input.reason,
    };
    if (input.ifLatest !== undefined)
      body.ifLatest = latestMessage(input.ifLatest);
    return this.mutate<{ workflow: SupportWorkflow }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      body,
    ).then((result) =>
      validWorkflow(isRecord(result) ? result.workflow : null),
    );
  }
  /** A person on the team: the AI mode for this request, one of
   * SUPPORT_AI_MODES. "drafts" keeps the registered AI agent to notes, tags
   * and handoffs; "off" keeps it from writing anything here. `takeOver`
   * (only with "drafts") is "Take over from AI"; it and "answers" also
   * clear an open handoff the AI agent or a person started, while the
   * member keeps waiting. The member's own request for a person stays open
   * until a person replies or resolves the request, and until then
   * "answers" is refused with 409 member-asked. Registered bots get 403
   * person-only. Counts nothing. The 51st change in one request is refused
   * with 409 ai-mode-limit. */
  setAiMode(
    id: string,
    input: { mode: SupportAiMode; takeOver?: true },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      !input ||
      typeof input !== "object" ||
      !SUPPORT_AI_MODES.includes(input.mode)
    )
      throw new Error(`Choose an AI mode: ${SUPPORT_AI_MODES.join(", ")}.`);
    if (
      input.takeOver !== undefined &&
      (input.takeOver !== true || input.mode !== "drafts")
    )
      throw new Error('Take over only with the "drafts" mode.');
    const body: Record<string, unknown> = {
      action: "ai-mode",
      mode: input.mode,
    };
    if (input.takeOver) body.takeOver = true;
    return this.mutate<{ workflow: SupportWorkflow }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      body,
    ).then((result) =>
      validWorkflow(isRecord(result) ? result.workflow : null),
    );
  }
  /** Claim for the signed-in staff account. The service checks that the
   * workspace isn't paused and the rollout gate is open; taking over another claim is manager-only. A
   * registered bot gets 409 ai-drafts-only or ai-off when a person set the
   * request to drafts only or AI off. */
  claimConversation(
    id: string,
    takeover = false,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (typeof takeover !== "boolean")
      throw new Error("Takeover takes true or false.");
    return this.mutate<{ conversation: TeamConversation }>(
      target,
      `/conversations/${conversationId(id)}/claim`,
      takeover ? { takeover: true } : {},
    ).then((result) =>
      validConversation(isRecord(result) ? result.conversation : null),
    );
  }
  /** The assigned staff account or manager can release a claim, including
   * while the workspace is paused. Read and reply permissions stay unchanged. */
  releaseConversationClaim(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<{ conversation: TeamConversation }>(
      target,
      `/conversations/${conversationId(id)}/release`,
      {},
    ).then((result) =>
      validConversation(isRecord(result) ? result.conversation : null),
    );
  }
  /** The fixed member only: stop or allow team messages in their own conversation. */
  stopTeamMessages(
    id: string,
    stopped: boolean,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (typeof stopped !== "boolean")
      throw new Error("Stop takes true or false.");
    return this.mutate<{ conversation: TeamConversation }>(
      target,
      `/conversations/${conversationId(id)}/stop`,
      { stopped },
    ).then((result) =>
      validConversation(isRecord(result) ? result.conversation : null),
    );
  }
  // Agent API 1.1: cases, frames and evidence, Ask AI drafts, follow-ups,
  // transaction check facts, reply labels, eval runs and the pulse. Every
  // route checks current access on each call; a member, a widget session or
  // anyone off the team gets the same 404 as for a thread they can't read.
  // With the AI off for a request, the registered AI agent can't see it.
  /** Team only: the requests of one thread, newest first, 20 per page.
   * Times, counts and flags; no message text. */
  conversationCases(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { before?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.before !== undefined)
      query.set("before", String(caseNumber(options.before)));
    const search = query.toString();
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/cases${search ? `?${search}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      return validated<SupportCaseList>(
        await this.request(path),
        (body) =>
          Array.isArray(body.cases) &&
          (body.nextBefore === null || Number.isSafeInteger(body.nextBefore)),
      );
    });
  }
  /** Team only: one request with its frame, evidence rows, drafts and Ask
   * AI requests. Rows that fail their checks are counted in `unreadable`
   * and left out. */
  conversationCase(
    id: string,
    seq: number,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const query = new URLSearchParams({ seq: String(caseNumber(seq)) });
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/cases?${query}`;
    return this.serial(async () => {
      this.authorized();
      return validated<SupportCaseDetail>(
        await this.request(path),
        (body) =>
          isRecord(body.case) &&
          Array.isArray(body.evidence) &&
          Array.isArray(body.drafts) &&
          Array.isArray(body.requests) &&
          Number.isSafeInteger(body.unreadable),
      );
    });
  }
  /** Team only: sets or clears fields of a request's frame (product,
   * metric, window, what the member reported). With `ifRevision` the
   * service refuses a frame someone changed since you read it (409
   * frame-stale). Text fields are screened like any team text. */
  setCaseFrame(
    id: string,
    seq: number,
    input: {
      set?: AgentFrameInput;
      clear?: SupportFrameField[];
      ifRevision?: number;
    },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body = jsonObject(input, "the frame change");
    if (
      body.ifRevision !== undefined &&
      (!Number.isSafeInteger(body.ifRevision) || Number(body.ifRevision) < 0)
    )
      throw new Error("Use ifRevision from the frame you read.");
    return this.mutate<{ frame: SupportCaseFrame }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      {
        action: "frame",
        case: caseNumber(seq),
        ...(body.set !== undefined ? { set: body.set } : {}),
        ...(body.clear !== undefined ? { clear: body.clear } : {}),
        ...(body.ifRevision !== undefined
          ? { ifRevision: body.ifRevision }
          : {}),
      },
    ).then((result) =>
      validated<{ frame: SupportCaseFrame }>(result, (page) =>
        isRecord(page.frame),
      ),
    );
  }
  /** Team only: adds 1 to 10 evidence rows to a request, each with where
   * the value came from. Rows are never edited; a later row may supersede
   * one. A retry with the same `clientId` and rows returns the first rows
   * (status 200); other rows under it are refused (409
   * evidence-retry-mismatch). */
  addCaseEvidence(
    id: string,
    seq: number,
    input: { rows: SupportEvidenceInput[]; clientId: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      !input ||
      !Array.isArray(input.rows) ||
      input.rows.length < 1 ||
      input.rows.length > 10
    )
      throw new Error("Send 1 to 10 evidence rows.");
    const rows = input.rows.map((row) => jsonObject(row, "an evidence row"));
    return this.mutate<{ evidence: SupportEvidence[] }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      {
        action: "evidence",
        case: caseNumber(seq),
        rows,
        clientId: clientId(input.clientId),
      },
    ).then((result) =>
      validated<{ evidence: SupportEvidence[] }>(result, (page) =>
        Array.isArray(page.evidence),
      ),
    );
  }
  /** Team only: withdraws an evidence row. A writer withdraws its own
   * rows; the manager or a support lead any row. The row stays listed as
   * withdrawn. */
  withdrawCaseEvidence(
    id: string,
    seq: number,
    n: number,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<{ evidence: SupportEvidence }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      {
        action: "withdraw-evidence",
        case: caseNumber(seq),
        n: evidenceNumber(n),
      },
    ).then((result) =>
      validated<{ evidence: SupportEvidence }>(result, (page) =>
        isRecord(page.evidence),
      ),
    );
  }
  /** The originating AI only: metadata for human answers to its own handoffs.
   * Reads and completion recheck current access and the workspace learning flag. */
  handoffLearningJobs(target: ChatTarget | undefined = this.defaultRoom) {
    return this.serial(async () => {
      this.authorized();
      return validated<{ jobs: HandoffLearningJob[] }>(
        await this.request(`${roomPath(target)}/conversations/handoff-learning`),
        (body) => Array.isArray(body.jobs) && body.jobs.length <= 20 &&
          body.jobs.every((job) => isRecord(job) &&
            /^[0-9a-f]{64}$/.test(String(job.id)) &&
            CONVERSATION_ID.test(String(job.conversation)) &&
            job.revision === 1 && isRecord(job.answer) &&
            /^[1-9][0-9]*$/.test(String(job.answer.id)) &&
            Number.isSafeInteger(job.answer.revision) && Number(job.answer.revision) > 0),
      );
    });
  }
  handoffLearningJob(
    thread: string,
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Use the current learning request.");
    return this.serial(async () => {
      this.authorized();
      return validated<{ job: HandoffLearningJob }>(
        await this.request(`${roomPath(target)}/conversations/${conversationId(thread)}/handoff-learning?id=${id}`),
        (body) => isRecord(body.job) && body.job.id === id && body.job.conversation === thread,
      );
    });
  }
  completeHandoffLearning(
    thread: string,
    input: { id: string; revision: number; result: HandoffLearningResult; expectedKnowledgeVersion?: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!/^[0-9a-f]{64}$/.test(input.id) || input.revision !== 1)
      throw new Error("Use the current learning request.");
    return this.mutate<{ job: HandoffLearningJob; learning?: unknown }>(
      target,
      `/conversations/${conversationId(thread)}/handoff-learning`,
      input,
    );
  }
  /** Claim before inference. An interrupted claimed job is never automatically retried. */
  beginHandoffLearning(
    thread: string,
    input: { id: string; revision: number },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!/^[0-9a-f]{64}$/.test(input.id) || input.revision !== 1)
      throw new Error("Use the current learning request.");
    return this.mutate<{ job: HandoffLearningJob }>(
      target,
      `/conversations/${conversationId(thread)}/handoff-learning`,
      { action: "begin", ...input },
    );
  }
  /** The workspace's Templ AI only: private Telegram help requests, oldest first. */
  telegramAiJobs(target: ChatTarget | undefined = this.defaultRoom) {
    return this.serial(async () => {
      this.authorized();
      return validated<{ jobs: TelegramAiHelpJob[] }>(
        await this.request(`${roomPath(target)}/conversations/telegram-ai`),
        (body) =>
          Array.isArray(body.jobs) &&
          body.jobs.length <= 20 &&
          body.jobs.every(
            (job) =>
              isRecord(job) &&
              /^[0-9a-f]{64}$/.test(String(job.id)) &&
              CONVERSATION_ID.test(String(job.conversation)) &&
              typeof job.revision === "number" &&
              Number.isSafeInteger(job.revision) &&
              job.revision > 0 &&
              job.status === "pending" &&
              typeof job.stage === "string" &&
              ["summary", "answer"].includes(job.stage) &&
              Array.isArray(job.replies),
          ),
      );
    });
  }
  completeTelegramAiHelp(
    id: string,
    input: { id: string; revision: number; result: TelegramAiHelpResult },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (
      !/^[0-9a-f]{64}$/.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    )
      throw new Error("Use the current Telegram help request.");
    return this.mutate<{ help: TelegramAiHelpJob }>(
      target,
      `/conversations/${conversationId(id)}/telegram-ai`,
      {
        action: "result",
        ...input,
      },
    );
  }
  /** Team only, the registered AI agent included: pending Ask AI requests,
   * oldest first. Rows carry ids, the request number and times; read the
   * question with conversationCase(). */
  draftRequests(
    options: { after?: string; limit?: number } = {},
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const query = new URLSearchParams({
      limit: String(boundedLimit(options.limit, 50, 50)),
    });
    if (options.after !== undefined)
      query.set("after", pageCursor(options.after));
    const path = `${roomPath(target)}/conversations/draft-requests?${query}`;
    return this.serial(async () => {
      this.authorized();
      return validated<{
        requests: SupportDraftRequestRow[];
        nextCursor: string | null;
      }>(
        await this.request(path),
        (body) =>
          Array.isArray(body.requests) &&
          body.requests.every(
            (row) =>
              isRecord(row) &&
              typeof row.id === "string" &&
              typeof row.conversation === "string" &&
              CONVERSATION_ID.test(row.conversation),
          ) &&
          (body.nextCursor === null || typeof body.nextCursor === "string"),
      );
    });
  }
  /** The registered AI agent only: a draft for the team, never sent to the
   * member. Answer one Ask AI request (`request`) or suggest a reply to the
   * member message you read (`forMessage`, refused as stale when the member
   * wrote again). One suggestion per member message (409 draft-exists). A
   * retry with the same `clientId` and text returns the first draft. The
   * text is screened like a reply; `provenance` tells the team why. */
  addConversationDraft(
    id: string,
    input: {
      text: string;
      clientId: string;
      request?: string;
      forMessage?: { id: string; revision: number };
      provenance?: SupportAiProvenance;
    },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if ((input.request === undefined) === (input.forMessage === undefined))
      throw new Error("Draft for one Ask AI request or one member message.");
    const body: Record<string, unknown> = {
      action: "draft",
      text: messageText(input.text),
      clientId: clientId(input.clientId),
    };
    if (input.request !== undefined) body.request = clientId(input.request);
    if (input.forMessage !== undefined)
      body.forMessage = latestMessage(input.forMessage);
    if (input.provenance !== undefined)
      body.provenance = checkedProvenance(input.provenance);
    return this.mutate<{ draft: SupportDraft | null }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      body,
    ).then((result) =>
      validated<{ draft: SupportDraft | null }>(
        result,
        (page) => page.draft === null || isRecord(page.draft),
      ),
    );
  }
  /** The registered AI agent only: declines an Ask AI request with one of
   * SUPPORT_AI_DECLINES. The person who asked sees why. */
  declineDraftRequest(
    id: string,
    input: { request: string; reason: SupportAiDecline },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!input || !SUPPORT_AI_DECLINES.includes(input.reason))
      throw new Error(`Decline with ${SUPPORT_AI_DECLINES.join(", ")}.`);
    return this.mutate<{ request: SupportDraftRequestView }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      {
        action: "draft-decline",
        request: clientId(input.request),
        reason: input.reason,
      },
    ).then((result) =>
      validated<{ request: SupportDraftRequestView }>(result, (page) =>
        isRecord(page.request),
      ),
    );
  }
  /** A person on the team: asks the workspace's AI agent for a draft of
   * the current request, with an optional question (up to 1,000 bytes).
   * Registered bots get 403 person-only. One request waits per thread. */
  requestAiDraft(
    id: string,
    input: { clientId: string; instruction?: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body: Record<string, unknown> = {
      action: "draft-request",
      clientId: clientId(input.clientId),
    };
    if (input.instruction !== undefined)
      body.instruction = messageText(input.instruction);
    return this.mutate<{ request: SupportDraftRequestView }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      body,
    ).then((result) =>
      validated<{ request: SupportDraftRequestView }>(result, (page) =>
        isRecord(page.request),
      ),
    );
  }
  /** The person who asked, the manager or a support lead: cancels a
   * waiting Ask AI request. */
  cancelAiDraft(
    id: string,
    input: { request: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<{ request: SupportDraftRequestView }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      { action: "draft-cancel", request: clientId(input.request) },
    ).then((result) =>
      validated<{ request: SupportDraftRequestView }>(result, (page) =>
        isRecord(page.request),
      ),
    );
  }
  /** A person on the team: closes a ready draft without sending it. */
  dismissAiDraft(
    id: string,
    input: { draft: string },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    return this.mutate<{ draft: SupportDraft | null }>(
      target,
      `/conversations/${conversationId(id)}/workflow`,
      { action: "draft-dismiss", draft: clientId(input.draft) },
    ).then((result) =>
      validated<{ draft: SupportDraft | null }>(
        result,
        (page) => page.draft === null || isRecord(page.draft),
      ),
    );
  }
  /** Team only: the request's follow-ups, the member-visible line and
   * which requests wait on the team. The registered AI agent reads them
   * too. */
  followUps(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { case?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.case !== undefined)
      query.set("case", String(caseNumber(options.case)));
    const search = query.toString();
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/follow-ups${search ? `?${search}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      return validated<SupportFollowUpList>(
        await this.request(path),
        (body) => Array.isArray(body.followUps) && Array.isArray(body.cases),
      );
    });
  }
  /** Team only: adds a follow-up to the thread's latest request. The
   * registered AI agent's follow-up stays team-only, with the default
   * member line and no owner or date, until a person takes it. A retry
   * with the same `clientId` returns the first one. */
  addFollowUp(
    id: string,
    input: {
      clientId: string;
      type: SupportFollowUpType;
      title: string;
    } & Record<string, unknown>,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body = jsonObject(input, "the follow-up");
    body.clientId = clientId(String(body.clientId ?? ""));
    return this.mutate<SupportFollowUpList & { followUp?: SupportFollowUp }>(
      target,
      `/conversations/${conversationId(id)}/follow-ups`,
      body,
    ).then((result) =>
      validated<SupportFollowUpList & { followUp?: SupportFollowUp }>(
        result,
        (page) => Array.isArray(page.followUps),
      ),
    );
  }
  /** People on the team and specialists it names: changes a follow-up
   * (`op` and its fields, with the `revision` you read; 409
   * follow-up-stale otherwise). Registered bots get 403 agent-follow-up. */
  changeFollowUp(
    id: string,
    followUpId: string,
    input: { op: string; revision: number } & Record<string, unknown>,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body = jsonObject(input, "the change");
    if (!Number.isSafeInteger(body.revision))
      throw new Error("Send the follow-up revision you read.");
    return this.mutate<SupportFollowUpList & { followUp?: SupportFollowUp }>(
      target,
      `/conversations/${conversationId(id)}/follow-ups/${followUpIdOf(followUpId)}`,
      body,
    ).then((result) =>
      validated<SupportFollowUpList & { followUp?: SupportFollowUp }>(
        result,
        (page) => Array.isArray(page.followUps),
      ),
    );
  }
  /** Team only: the workspace's follow-up queue (`open`, `overdue`,
   * `mine` or `group`). Group rows carry no title. */
  followUpQueue(
    options: { view?: SupportFollowUpQueueView; cursor?: string } = {},
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const view = options.view ?? "open";
    if (!["open", "overdue", "mine", "group"].includes(view))
      throw new Error("Choose open, overdue, mine or group.");
    const query = new URLSearchParams({ view });
    if (options.cursor !== undefined)
      query.set("cursor", pageCursor(options.cursor));
    const path = `${roomPath(target)}/conversations/follow-ups?${query}`;
    return this.serial(async () => {
      this.authorized();
      return validated<SupportFollowUpQueue>(await this.request(path), (body) =>
        Array.isArray(body.rows),
      );
    });
  }
  /** Team only: the transaction checks of a thread (newest first, at most
   * three), or one check with `id`. People get next steps; the registered
   * AI agent gets facts and claims for EVM and Solana transactions.
   * Handoff steps appear only when a check needs a person.
   * User replies use only member-safe facts. */
  conversationDiagnoses(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { id?: string } = {},
  ) {
    const query = new URLSearchParams();
    if (options.id !== undefined) query.set("id", diagnosisIdOf(options.id));
    const search = query.toString();
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/diagnosis${search ? `?${search}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      return validated<
        SupportDiagnosisList | { diagnosis: SupportDiagnosisView }
      >(
        await this.request(path),
        (body) => Array.isArray(body.diagnoses) || isRecord(body.diagnosis),
      );
    });
  }
  /** Team only: checks a shared transaction by hash (with an optional
   * network) or explorer link. Answers the stored check when a fresh one
   * exists, or `running` (202) while one is being read; poll
   * conversationDiagnoses() then. Reading a transaction never signs or
   * sends one. */
  runDiagnosis(
    id: string,
    input: {
      clientId: string;
      subject: { hash: string; network?: string } | { link: string };
      force?: true;
    },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const subject = jsonObject(input?.subject, "the transaction");
    if (input.force !== undefined && input.force !== true)
      throw new Error("Force only with true.");
    return this.mutate<{
      diagnosis?: SupportDiagnosisView;
      cached?: boolean;
      running?: { subject: string; trigger: string; startedAt: string };
    }>(target, `/conversations/${conversationId(id)}/diagnosis`, {
      clientId: clientId(input.clientId),
      subject,
      ...(input.force ? { force: true } : {}),
    }).then((result) =>
      validated<{
        diagnosis?: SupportDiagnosisView;
        cached?: boolean;
        running?: { subject: string; trigger: string; startedAt: string };
      }>(result, (page) => isRecord(page.diagnosis) || isRecord(page.running)),
    );
  }
  /** Team only: reply labels and review state of the thread's requests.
   * The registered AI agent reads them; labeling is for people. */
  replyLabels(
    id: string,
    target: ChatTarget | undefined = this.defaultRoom,
    options: { case?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.case !== undefined)
      query.set("seq", String(caseNumber(options.case)));
    const search = query.toString();
    const path = `${roomPath(target)}/conversations/${conversationId(id)}/review${search ? `?${search}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      return validated<{ cases: SupportCaseQualityView[] }>(
        await this.request(path),
        (body) => Array.isArray(body.cases),
      ).cases;
    });
  }
  /** A person on the team: labels a team reply with REPLY_LABELS, or
   * clears its label with an empty list. Registered bots get 403. */
  labelReply(
    id: string,
    input: { message: string; labels: ReplyLabel[] },
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    if (!Array.isArray(input?.labels) || input.labels.length > 7)
      throw new Error("Choose up to seven labels.");
    return this.mutate<{ quality: SupportCaseQualityView }>(
      target,
      `/conversations/${conversationId(id)}/review`,
      {
        action: "label",
        message: messageId(input.message),
        labels: [...input.labels],
      },
    ).then(
      (result) =>
        validated<{ quality: SupportCaseQualityView }>(result, (page) =>
          isRecord(page.quality),
        ).quality,
    );
  }
  /** The workspace's de-identified eval cases as `templ-eval/1` lines, one
   * page at a time. People need the lead role; the registered AI agent
   * needs the manager's permission (403 eval-agent-access). */
  exportEvalSet(
    options: { set?: "golden" | "all"; after?: string } = {},
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const set = options.set ?? "golden";
    if (set !== "golden" && set !== "all")
      throw new Error("Export the golden set or all cases.");
    const query = new URLSearchParams({ set, format: "json" });
    if (options.after !== undefined)
      query.set("after", pageCursor(options.after));
    const path = `${roomPath(target)}/conversations/evals/export?${query}`;
    return this.serial(async () => {
      this.authorized();
      return validated<{
        lines: string[];
        next: string | null;
        withheld: number;
      }>(
        await this.request(path, undefined, { maxResponseBytes: 4_194_304 }),
        (body) =>
          Array.isArray(body.lines) &&
          body.lines.every((line) => typeof line === "string") &&
          (body.next === null || typeof body.next === "string"),
      );
    });
  }
  /** Posts a scored eval run (the lead role, or the registered AI agent
   * with the manager's permission). A retry with the same `clientRunId`
   * returns the first run. */
  postEvalRun(
    input: EvalRunInput,
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const body = jsonObject(input, "the eval run");
    return this.mutate<EvalRunView>(
      target,
      "/conversations/evals/runs",
      body,
    ).then((result) =>
      validated<EvalRunView>(
        result,
        (page) => typeof page.id === "string" && /^run-/.test(page.id),
      ),
    );
  }
  /** Eval runs posted to the workspace, newest first. */
  evalRuns(
    options: { after?: string } = {},
    target: ChatTarget | undefined = this.defaultRoom,
  ) {
    const query = new URLSearchParams();
    if (options.after !== undefined)
      query.set("after", pageCursor(options.after));
    const search = query.toString();
    const path = `${roomPath(target)}/conversations/evals/runs${search ? `?${search}` : ""}`;
    return this.serial(async () => {
      this.authorized();
      return validated<{ runs: EvalRunView[]; next: string | null }>(
        await this.request(path),
        (body) => Array.isArray(body.runs),
      );
    });
  }
  /** One posted eval run. */
  evalRun(runId: string, target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/conversations/evals/runs/${evalRunIdOf(runId)}`;
    return this.serial(async () => {
      this.authorized();
      return validated<EvalRunView>(
        await this.request(path),
        (body) => typeof body.id === "string" && /^run-/.test(body.id),
      );
    });
  }
  /** Team only: the live queue as counts and times, with no thread or
   * person. Schema 2 adds the requests waiting on the team and overdue
   * follow-ups. */
  supportPulse(target: ChatTarget | undefined = this.defaultRoom) {
    const path = `${roomPath(target)}/conversations/pulse`;
    return this.serial(async () => {
      this.authorized();
      return validated<SupportPulse | SupportPulseV2>(
        await this.request(path),
        (body) =>
          (body.schemaVersion === 1 || body.schemaVersion === 2) &&
          Number.isSafeInteger(body.needsReply) &&
          Number.isSafeInteger(body.needsYou) &&
          Number.isSafeInteger(body.aiHandling),
      );
    });
  }
  // Room events, polling and realtime subscriptions.
  /** One page of workspace events. Every event checks current case access. */
  eventPage(
    target: ChatTarget | undefined = this.defaultRoom,
    options: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    const count = boundedLimit(options.limit, 100, MAX_EVENT_PAGE);
    const after =
      options.after === undefined ? null : eventCursor(options.after);
    const params = new URLSearchParams({ limit: String(count) });
    if (after !== null) params.set("after", after);
    const path = `${roomPath(target)}/events?${params}`;
    return this.serial(async () => {
      options.signal?.throwIfAborted();
      const page = await this.request(path, undefined, {
        signal: options.signal,
      });
      return validEventPage(page, count);
    });
  }
  /** Polls the event log until `signal` aborts. Without `after` it starts at
   * the oldest retained event (the service keeps 2,000 events or 24 hours);
   * pass the last `id` you handled to resume. Waits `intervalMs` while the
   * room is quiet, backs off from 1 to 30 seconds while the service is
   * unavailable or rate limiting, and stops on 401, 403 and 410. Each event is
   * yielded once. */
  events(
    target: ChatTarget | undefined = this.defaultRoom,
    options: ChatEventsOptions = {},
  ): AsyncGenerator<ChatEvent> {
    return this.eventLoop(
      destination(target),
      boundedLimit(options.limit, 100, MAX_EVENT_PAGE),
      pollInterval(options.intervalMs),
      options.after === undefined ? null : eventCursor(options.after),
      options,
    );
  }
  private async *eventLoop(
    selected: ChatDestination,
    count: number,
    interval: number,
    start: string | null,
    options: ChatEventsOptions,
  ): AsyncGenerator<ChatEvent> {
    const revision = this.revision;
    let cursor = start;
    let last = cursor === null ? null : BigInt(cursor);
    let backoff = 1_000;
    while (true) {
      options.signal?.throwIfAborted();
      this.assertRevision(revision);
      let page: ChatEventPage;
      try {
        page = await this.eventPage(selected, {
          ...(cursor === null ? {} : { after: cursor }),
          limit: count,
          signal: options.signal,
        });
      } catch (error) {
        if (!retryable(error)) throw error;
        await pause(retryDelay(error, backoff), options.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1_000;
      if (page.resync)
        options.onResync?.({ oldestRetained: page.oldestRetained });
      for (const event of page.events) {
        const id = BigInt(event.id);
        if (last !== null && id <= last) continue;
        last = id;
        options.signal?.throwIfAborted();
        this.assertRevision(revision);
        yield event;
      }
      if (page.nextAfter !== null) cursor = page.nextAfter;
      const full = page.events.length >= count && page.nextAfter !== null;
      await pause(full ? 500 : interval, options.signal);
    }
  }
  private realtimeTicket(selected: ChatDestination, signal?: AbortSignal) {
    const path = `${roomPath(selected)}/realtime/ticket`;
    const socketPath = `${roomPath(selected)}/realtime`;
    return this.serial(async () => {
      signal?.throwIfAborted();
      let body: Record<string, unknown> = {};
      if (this.signer) {
        try {
          body = { expectedPrincipalId: this.authorized() };
        } catch (error) {
          if (!(error instanceof ChatClientError && error.status === 401))
            throw error;
        }
      }
      const ticket = await this.request(path, body, { signal });
      return validated<RealtimeTicket>(ticket, (value) => {
        if (
          typeof value.ticket !== "string" ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(value.ticket) ||
          !isoTime(value.expiresAt) ||
          typeof value.socketUrl !== "string"
        )
          return false;
        let url: URL;
        try {
          url = new URL(value.socketUrl);
        } catch {
          return false;
        }
        return (
          url.protocol === "wss:" &&
          url.host === new URL(this.apiOrigin).host &&
          url.pathname === socketPath &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      });
    });
  }
  /** Live room events over a ticket-authenticated WebSocket, with catch-up
   * from the last event id after every reconnect. Without `after` it starts
   * at the events that happen after the socket opens. Falls back to events()
   * polling when realtime is unavailable (503) or no WebSocket class exists.
   * Stops on 401, 403 and 410, when `signal` aborts, or after signOut(). The
   * ticket travels only in the first socket frame and is never exposed. */
  subscribe(
    target: ChatTarget | undefined = this.defaultRoom,
    options: ChatSubscribeOptions = {},
  ): AsyncGenerator<ChatEvent> {
    return this.subscribeLoop(
      destination(target),
      pollInterval(options.intervalMs),
      options.after === undefined ? null : eventCursor(options.after),
      options,
    );
  }
  private async *subscribeLoop(
    selected: ChatDestination,
    interval: number,
    start: string | null,
    options: ChatSubscribeOptions,
  ): AsyncGenerator<ChatEvent> {
    const revision = this.revision;
    let cursor = start;
    let last = cursor === null ? null : BigInt(cursor);
    let backoff = 1_000;
    const Socket = this.Socket;
    const fallback = () =>
      this.eventLoop(selected, MAX_EVENT_PAGE, interval, cursor, options);
    if (!Socket) {
      yield* fallback();
      return;
    }
    while (true) {
      options.signal?.throwIfAborted();
      this.assertRevision(revision);
      let ticket: RealtimeTicket;
      try {
        ticket = await this.realtimeTicket(selected, options.signal);
      } catch (error) {
        if (error instanceof ChatClientError && error.status === 503) {
          yield* fallback();
          return;
        }
        if (!retryable(error)) throw error;
        await pause(retryDelay(error, backoff), options.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      const feed = new SocketFeed(
        new Socket(ticket.socketUrl, { headers: { Origin: this.appOrigin } }),
        options.signal,
      );
      const connectedAt = Date.now();
      try {
        const opened = await feed.opened(this.timeoutMs);
        if (opened) {
          const hello: RealtimeClientFrame = {
            type: "hello",
            ticket: ticket.ticket,
            after: cursor,
          };
          feed.send(JSON.stringify(hello));
          let pending = 0;
          let pinged = false;
          while (true) {
            const frame = await feed.next(this.timeoutMs);
            if (frame === null) break;
            if (frame === undefined) {
              // Quiet socket: one ping, then treat continued silence as a dead connection.
              if (pinged) {
                feed.close(1000, "silent");
                break;
              }
              pinged = true;
              feed.send(JSON.stringify({ type: "ping" }));
              continue;
            }
            pinged = false;
            if (frame.type === "event") {
              if (!validEvent(frame.event)) {
                feed.close(1002, "protocol");
                break;
              }
              const id = BigInt(frame.event.id);
              if (last !== null && id <= last) continue;
              last = id;
              cursor = frame.event.id;
              // Acks bound the server's unacked queue; delivery is still tracked by cursor.
              if (++pending >= 50 || feed.idle()) {
                feed.send(JSON.stringify({ type: "ack", id: cursor }));
                pending = 0;
              }
              options.signal?.throwIfAborted();
              this.assertRevision(revision);
              yield frame.event;
            } else if (frame.type === "ready") {
              if (cursor === null && sequenceId(frame.cursor)) {
                cursor = frame.cursor;
                last = BigInt(frame.cursor);
              }
            } else if (frame.type === "resync") {
              // The socket cannot fill the gap; page through GET /events from the cursor instead.
              feed.close(1000, "resync");
              break;
            } else if (frame.type === "reauth") {
              // Access or session changed: reconnect with a fresh ticket and catch up.
              feed.close(1000, "reauth");
              break;
            } else if (frame.type === "error") {
              feed.close(1000, frame.code);
              break;
            }
          }
        }
      } finally {
        feed.close(1000, "done");
      }
      // A connection that held for half a minute resets the backoff; a flapping one keeps doubling it.
      if (Date.now() - connectedAt >= 30_000) backoff = 1_000;
      options.signal?.throwIfAborted();
      this.assertRevision(revision);
      // Catch up from the last delivered event before reconnecting.
      if (cursor !== null) {
        while (true) {
          options.signal?.throwIfAborted();
          this.assertRevision(revision);
          let page: ChatEventPage;
          try {
            page = await this.eventPage(selected, {
              after: cursor,
              limit: MAX_EVENT_PAGE,
              signal: options.signal,
            });
          } catch (error) {
            if (!retryable(error)) throw error;
            await pause(retryDelay(error, backoff), options.signal);
            backoff = Math.min(backoff * 2, 30_000);
            continue;
          }
          if (page.resync)
            options.onResync?.({ oldestRetained: page.oldestRetained });
          for (const event of page.events) {
            const id = BigInt(event.id);
            if (last !== null && id <= last) continue;
            last = id;
            options.signal?.throwIfAborted();
            this.assertRevision(revision);
            yield event;
          }
          if (page.nextAfter !== null) cursor = page.nextAfter;
          if (page.events.length < MAX_EVENT_PAGE || page.nextAfter === null)
            break;
        }
      }
      await pause(backoff + Math.floor(Math.random() * 250), options.signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
