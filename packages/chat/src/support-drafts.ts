/** Staff drafts: Ask AI answers and held agent replies that a person approves before anything is sent.
 *
 * One draft store serves three kinds: an answer to a person's Ask AI
 * request, a suggestion the AI agent writes for a member message, and an
 * agent reply the opt-in number check held for the team. Drafts are team
 * only: never sent, counted, exported or shown to the member. A person sends
 * a draft by replying with it ("Use draft"); the reply is then the person's.
 *
 * Also here: the provenance an AI agent may attach to a reply or a draft,
 * and the case views the inbox reads. Pure types and checks with no I/O. */
import type { ChatPrincipalId } from "./principal";
import { checkedAiInteraction, type AiInteraction } from "./support-ai-interactions";
import type {
  CitationAdvice,
  CitationProblem,
  Citation,
  DiagnosisCitation,
} from "./support-citations";
import type { SupportCaseFrame, SupportEvidence } from "./support-evidence";
import type {
  SupportCaseCloser,
  SupportHandoffBy,
  SupportHandoffReason,
} from "./support";

export const SUPPORT_DRAFT_KINDS = [
  "ask-ai",
  "suggestion",
  "held-reply",
] as const;
export type SupportDraftKind = (typeof SUPPORT_DRAFT_KINDS)[number];
/** Why the AI agent declined an Ask AI request. */
export const SUPPORT_AI_DECLINES = [
  "handoff",
  "unsure",
  "no-access",
  "unavailable",
  "refused",
  "other",
] as const;
export type SupportAiDecline = (typeof SUPPORT_AI_DECLINES)[number];
export const SUPPORT_AI_REASONS = [
  "answer",
  "clarifying-question",
  "quote",
  "safety-warning",
  "draft",
] as const;
export type SupportAiReason = (typeof SUPPORT_AI_REASONS)[number];
export const SUPPORT_AI_SOURCE_KINDS = [
  "doc",
  "faq",
  "profile",
  "diagnosis",
  "evidence",
  "chain",
  "ticket",
  "other",
] as const;
export type SupportAiSourceKind = (typeof SUPPORT_AI_SOURCE_KINDS)[number];

export const SUPPORT_DRAFT_LIMITS = {
  /** Pending Ask AI requests per thread. */
  pendingPerThread: 1,
  /** Ask AI requests per member request (case). */
  requestsPerCase: 20,
  /** Pending Ask AI requests per workspace. */
  pendingPerWorkspace: 200,
  /** A request the AI agent has not answered by then is expired. */
  requestMs: 10 * 60_000,
  instructionBytes: 1000,
  /** Open drafts per case; a new one past the cap first removes the oldest
   * closed draft. */
  draftsPerCase: 20,
  draftBytes: 4000,
  provenanceBytes: 4096,
  sources: 8,
  tools: 12,
  summaryBytes: 500,
  sourceTitleBytes: 120,
  sourceUrlChars: 512,
  /** Hosts a workspace lets source links point to. */
  sourceHosts: 20,
  /** Rows per draft request list page. */
  listPage: 50,
  /** Expired pending keys pruned per new request. */
  expiredPrune: 20,
  /** Cases per page of a thread's case list. */
  casesPerPage: 20,
} as const;

export type SupportAiSource = {
  /** Unique in the list: letters, digits and . _ : - */
  id: string;
  kind: SupportAiSourceKind;
  title: string;
  /** https only, a DNS host, no user info. */
  url?: string;
};
/** Why the AI agent wrote a reply or a draft, for the team only. Figures
 * cite evidence rows through [ev:n] markers in the text, not here. */
/** Retained native source-check evidence. This metadata grants no permission. */
export type SupportAiGrounding = {
  policy: "grounded_v1";
  status: "approved" | "summary";
  verifierVersion: string;
  verifierSha256: string;
  answerSha256: string;
  sourcesSha256: string;
  knowledgeVersion: string;
  receiptId: string;
};
export type SupportAiProvenance = {
  reason: SupportAiReason;
  interaction?: AiInteraction;
  grounding?: SupportAiGrounding;
  /** Staff only, plain text. */
  summary?: string;
  sources: SupportAiSource[];
  confidence?: "high" | "medium" | "low";
  model?: string;
  tools?: string[];
};
export type SupportDraftRequestStatus =
  | "pending"
  | "answered"
  | "declined"
  | "expired"
  | "cancelled";
export type SupportDraftRequestView = {
  id: string;
  conversation: string;
  case: number;
  requestedBy: ChatPrincipalId;
  requestedAt: string;
  expiresAt: string;
  /** Team case views only; never in the list route. */
  instruction?: string | null;
  status: SupportDraftRequestStatus;
  decline: SupportAiDecline | null;
  /** The draft that answered it. */
  draft: string | null;
};
/** A row of the agents' draft request list: ids, case and times only. */
export type SupportDraftRequestRow = {
  id: string;
  conversation: string;
  case: number;
  requestedAt: string;
  expiresAt: string;
};
export type SupportDraftStatus = "ready" | "used" | "dismissed";
export type SupportDraft = {
  id: string;
  case: number;
  kind: SupportDraftKind;
  /** The Ask AI request it answers. */
  request: string | null;
  /** The member message a suggestion answers, or the one a held reply read. */
  forMessage: { id: string; revision: number } | null;
  author: ChatPrincipalId;
  at: string;
  /** Markers removed, at most 4,000 bytes. */
  text: string;
  provenance: SupportAiProvenance | null;
  citations: Citation[];
  diagnosisCitations?: DiagnosisCitation[];
  problems: CitationProblem[];
  advice: CitationAdvice[];
  status: SupportDraftStatus;
  usedMessageId: string | null;
  /** Whether the person changed the text before sending it. */
  edited: boolean | null;
  /** A member message newer than the one it answers exists. */
  stale: boolean;
  closedAt: string | null;
  closedBy: ChatPrincipalId | null;
  /** Source ids whose links point to a site the workspace lists; only
   * those open as links. */
  links: Record<string, boolean>;
};
/** How a team member reads the provenance of one sent message. */
export type SupportProvenanceView = {
  case: number;
  /** An AI agent's reply, or a person's reply sent from a draft. */
  kind: "reply" | "assisted";
  ai: SupportAiProvenance | null;
  citations: Citation[];
  diagnosisCitations?: DiagnosisCitation[];
  /** "passed": the check held nothing; "off": the check did not hold;
   * "from-draft": copied from an unedited draft; "none": nothing checked. */
  check: "passed" | "off" | "from-draft" | "none";
  problems: CitationProblem[];
  advice: CitationAdvice[];
  fromDraft?: { draft: string; edited: boolean };
  /** Source ids whose links point to a host the workspace lists. */
  links: Record<string, boolean>;
};
/** One member request in a thread, for the team: times, counts and flags. */
export type SupportCaseView = {
  entry?: "hosted";
  identity?: import("./support-identity").SupportIdentity;
  identityLabel?: string;
  seq: number;
  openedAt: string;
  state: "open" | "resolved";
  resolvedAt: string | null;
  resolvedBy: SupportCaseCloser | null;
  handoff: {
    at: string;
    reason: SupportHandoffReason | null;
    by: SupportHandoffBy | null;
    open: boolean;
  } | null;
  confirmation: "solved" | "not-solved" | null;
  counts: {
    memberMessages: number;
    humanReplies: number;
    botReplies: number;
    notes: number;
  };
  evidence: number;
  drafts: number;
  framed: boolean;
};
export type SupportCaseList = {
  cases: SupportCaseView[];
  /** The `before` of the next page, or null. */
  nextBefore: number | null;
};
export type SupportCaseDetail = {
  case: SupportCaseView;
  frame: SupportCaseFrame | null;
  evidence: SupportEvidence[];
  drafts: SupportDraft[];
  requests: SupportDraftRequestView[];
  /** Rows that failed their read-time checks and are left out. */
  unreadable: number;
};
/** Workspace settings for AI assists. Written only by the manager. */
export type SupportCaseSettings = {
  /** "hold": an AI agent reply whose figures fail the citation check is
   * held as a draft for the team. Absent: "off". */
  agentChecks?: { citations: "off" | "hold" };
  /** Hosts provenance links may point to. Absent: none. */
  aiSourceHosts?: string[];
};
/** Team summary fields the case features add. */
export type SupportSummaryCases = {
  caseSeq?: number;
  /** Agent replies held as drafts and not yet used or dismissed. */
  draftsHeld?: number;
};
/** Activity entries the case features write: field names, counts, E<n> or
 * problem kinds, never values or text. */
export const SUPPORT_CASE_ACTIVITY = [
  "frame",
  "evidence",
  "evidence-withdrawn",
  "draft-request",
  "draft-held",
  "draft-used",
  "draft-dismissed",
  // A follow-up changed (the detail is its code).
  "follow-up",
] as const;
export type SupportCaseActivityAction = (typeof SUPPORT_CASE_ACTIVITY)[number];

export class SupportDraftInputError extends Error {
  readonly reason = "invalid-provenance";
  constructor(message = "Send provenance in the documented shape.") {
    super(message);
    this.name = "SupportDraftInputError";
  }
}

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,64}$/;
const TOOL = /^[A-Za-z0-9._-]{1,48}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T>(list: readonly T[], value: unknown): value is T =>
  (list as readonly unknown[]).includes(value);

function plainText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && bytes(text) <= limit && !CONTROL.test(text) ? text : null;
}
/** The host of an https URL with a DNS name, lowercased; null otherwise. */
export function sourceHost(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    HOST.test(host)
    ? host
    : null;
}
/** A hostname a manager may list: lowercase DNS name, no scheme or path. */
export function isSourceHost(value: unknown): value is string {
  return typeof value === "string" && HOST.test(value);
}

/** Provenance as an AI agent sends it, checked and normalized. Throws
 * SupportDraftInputError on any other shape; nothing is written then. */
export function checkedProvenance(value: unknown): SupportAiProvenance {
  const fail = (): never => {
    throw new SupportDraftInputError();
  };
  if (!isPlain(value)) fail();
  const input = value as Record<string, unknown>;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return fail();
  }
  if (bytes(serialized) > SUPPORT_DRAFT_LIMITS.provenanceBytes) fail();
  for (const key of Object.keys(input))
    if (
      ![
        "reason",
        "summary",
        "sources",
        "confidence",
        "model",
        "tools",
        "grounding",
        "interaction",
      ].includes(key)
    )
      fail();
  if (!oneOf(SUPPORT_AI_REASONS, input.reason)) fail();
  const interaction = input.interaction === undefined ? undefined : checkedAiInteraction(input.interaction) ?? fail();
  if (interaction && input.reason !== (interaction.kind === "clarify" ? "clarifying-question" : "answer")) fail();
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || sources.length > SUPPORT_DRAFT_LIMITS.sources)
    fail();
  const ids = new Set<string>();
  const checkedSources: SupportAiSource[] = (sources as unknown[]).map(
    (raw) => {
      if (!isPlain(raw)) fail();
      const source = raw as Record<string, unknown>;
      for (const key of Object.keys(source))
        if (!["id", "kind", "title", "url"].includes(key)) fail();
      if (typeof source.id !== "string" || !SOURCE_ID.test(source.id)) fail();
      if (ids.has(source.id as string)) fail();
      ids.add(source.id as string);
      if (!oneOf(SUPPORT_AI_SOURCE_KINDS, source.kind)) fail();
      const title = plainText(
        source.title,
        SUPPORT_DRAFT_LIMITS.sourceTitleBytes,
      );
      if (!title) fail();
      let url: string | undefined;
      if (source.url !== undefined) {
        if (
          typeof source.url !== "string" ||
          source.url.length > SUPPORT_DRAFT_LIMITS.sourceUrlChars ||
          !sourceHost(source.url)
        )
          fail();
        url = source.url as string;
      }
      return {
        id: source.id as string,
        kind: source.kind as SupportAiSourceKind,
        title: title!,
        ...(url ? { url } : {}),
      };
    },
  );
  let summary: string | undefined;
  if (input.summary !== undefined) {
    summary =
      plainText(input.summary, SUPPORT_DRAFT_LIMITS.summaryBytes) ?? fail();
  }
  if (
    input.confidence !== undefined &&
    !oneOf(["high", "medium", "low"] as const, input.confidence)
  )
    fail();
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || !MODEL.test(input.model))
  )
    fail();
  let tools: string[] | undefined;
  if (input.tools !== undefined) {
    if (
      !Array.isArray(input.tools) ||
      input.tools.length > SUPPORT_DRAFT_LIMITS.tools ||
      input.tools.some((tool) => typeof tool !== "string" || !TOOL.test(tool))
    )
      fail();
    tools = [...new Set(input.tools as string[])];
  }
  let grounding: SupportAiGrounding | undefined;
  if (input.grounding !== undefined) {
    const item = input.grounding;
    if (
      !isPlain(item) ||
      Object.keys(item).sort().join() !==
        "answerSha256,knowledgeVersion,policy,receiptId,sourcesSha256,status,verifierSha256,verifierVersion" ||
      item.policy !== "grounded_v1" ||
      !["approved", "summary"].includes(String(item.status)) ||
      typeof item.verifierVersion !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.verifierVersion) ||
      typeof item.receiptId !== "string" ||
      !/^[a-f0-9]{32}$/.test(item.receiptId) ||
      [
        "answerSha256",
        "sourcesSha256",
        "knowledgeVersion",
        "verifierSha256",
      ].some(
        (key) =>
          typeof item[key] !== "string" ||
          !/^[a-f0-9]{64}$/.test(item[key] as string),
      )
    )
      fail();
    grounding = item as SupportAiGrounding;
  }
  return {
    reason: input.reason as SupportAiReason,
    ...(interaction ? { interaction } : {}),
    ...(grounding ? { grounding } : {}),
    ...(summary ? { summary } : {}),
    sources: checkedSources,
    ...(input.confidence
      ? { confidence: input.confidence as "high" | "medium" | "low" }
      : {}),
    ...(input.model ? { model: input.model as string } : {}),
    ...(tools ? { tools } : {}),
  };
}
/** Which source links the team may open: only hosts the workspace lists. */
export function sourceLinks(
  provenance: SupportAiProvenance | null,
  hosts: readonly string[],
): Record<string, boolean> {
  const allowed = new Set(hosts);
  const links: Record<string, boolean> = {};
  for (const source of provenance?.sources ?? [])
    if (source.url) {
      const host = sourceHost(source.url);
      links[source.id] = host !== null && allowed.has(host);
    }
  return links;
}
