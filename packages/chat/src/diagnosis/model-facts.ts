import {
  EVM_TOKENS,
  SOLANA_MINTS,
} from "@templ/chat/diagnosis/known-addresses";
import { NETWORK_INFO } from "@templ/chat/diagnosis/networks";
import {
  MEMBER_TEMPLATES,
  REASON_TEXT,
  STAFF_TEXT,
  fill,
  validMemberSlot,
} from "@templ/chat/diagnosis/templates";
import type { Diagnosis, DiagnosisClaims } from "@templ/chat/diagnosis/types";

const NUMBER = /<0\.000001|\d+(?:[.,]\d+)*/g;
const SHORT_REF =
  /0x[0-9a-f]{4}…[0-9a-f]{4}|[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/g;
const TOKEN = /^[A-Za-z0-9.+-]{1,12}$/;
const STATUS_FACTS: Record<string, string> = {
  failed: "The transaction failed.",
  expired: "The transaction expired.",
  pending: "The transaction is waiting.",
  unavailable: "Templ couldn't check the transaction.",
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unique = (items: string[]) => [...new Set(items)];
const builtInTokens = [
  ...EVM_TOKENS.map((item) => item.label),
  ...SOLANA_MINTS.map((item) => item.label),
  ...Object.values(NETWORK_INFO).map((item) => item.native),
];
const numericSlots = new Set([
  "n",
  "nonce",
  "confirmed",
  "nonceMinusOne",
  "fee",
  "baseFee",
  "parent",
  "gasLimit",
  "gasUsed",
  "block",
  "confirmations",
  "finalized",
  "count",
  "assets",
  "shares",
  "outAmount",
  "inAmount",
  "amount",
  "index",
  "slot",
  "limit",
  "price",
  "shown",
  "total",
  "value",
]);
const refSlots = new Set([
  "short",
  "from",
  "wallet",
  "subjectShort",
  "to",
  "address",
  "owner",
  "receiver",
  "sender",
  "delegate",
  "account",
  "payer",
  "spender",
  "vault",
]);
const tokenSlots = new Set(["token", "asset", "native", "outToken", "inToken"]);

/** Reads only complete fixed templates, then renders their validated slots. */
function fixedText(
  text: unknown,
  template: string,
  valid: (name: string, value: string) => boolean,
): string | null {
  if (typeof text !== "string" || text.length > 600) return null;
  const names: string[] = [];
  let pattern = "";
  let at = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    pattern += escape(template.slice(at, match.index)) + "(.*?)";
    names.push(match[1]);
    at = match.index! + match[0].length;
  }
  pattern += escape(template.slice(at));
  const match = new RegExp(`^${pattern}$`).exec(text);
  if (!match) return null;
  const slots: Record<string, string> = {};
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const value = match[index + 1];
    if (!valid(name, value) || (name in slots && slots[name] !== value))
      return null;
    slots[name] = value;
  }
  return fill(template, slots);
}

function safeMember(
  text: unknown,
  trusted: ReadonlySet<string>,
): string | null {
  if (typeof text === "string" && text.startsWith("Alchemy reports: ")) {
    const body = safeMember(text.slice("Alchemy reports: ".length), trusted);
    return body ? `Alchemy reports: ${body}` : null;
  }
  const valid = (name: string, value: string) =>
    validMemberSlot(name, value) &&
    (!tokenSlots.has(name) || trusted.has(value));
  for (const { text: template, fallback } of Object.values(MEMBER_TEMPLATES)) {
    const result =
      fixedText(text, template, valid) ??
      (fallback ? fixedText(text, fallback, valid) : null);
    if (result !== null) return result;
  }
  // An other-network notice may precede the main member template.
  if (typeof text === "string") {
    const split = text.indexOf(". ");
    if (split >= 0) {
      const lead = fixedText(
        text.slice(0, split + 1),
        MEMBER_TEMPLATES["m.other-network"].text,
        valid,
      );
      const body = lead ? safeMember(text.slice(split + 2), trusted) : null;
      if (lead && body) return `${lead} ${body}`;
    }
  }
  return null;
}

function safeFinding(
  text: unknown,
  trusted: ReadonlySet<string>,
): string | null {
  if (
    typeof text === "string" &&
    [...Object.values(REASON_TEXT), ...Object.values(STATUS_FACTS)].includes(
      text,
    )
  )
    return text;
  const valid = (name: string, value: string) => {
    if (tokenSlots.has(name)) return TOKEN.test(value) && trusted.has(value);
    if (numericSlots.has(name))
      return /^(?:\d{1,3}(?:,\d{3})*(?:\.\d+)?|<0\.000001)$/.test(value);
    if (refSlots.has(name))
      return new RegExp(`^(?:${SHORT_REF.source})$`).test(value);
    return validMemberSlot(name === "networkList" ? "networks" : name, value);
  };
  for (const template of Object.values(STAFF_TEXT)) {
    const result = fixedText(text, template, valid);
    if (result !== null) return result;
  }
  return null;
}

export type ModelCheckInput = {
  status?: string;
  reason?: string | null;
  whatHappened?: unknown;
  memberDraft?: unknown;
  memberEvidence?: unknown;
  findings?: unknown;
  claims?: { status?: string; tokens?: readonly string[] };
};

/** The model and reply guard share this projection. Chain prose and raw
 * evidence never become model facts or allowed numbers. */
export function modelCheckFacts(input: ModelCheckInput) {
  const check = { ...input, status: input.status ?? input.claims?.status };
  const trusted = new Set([
    ...builtInTokens,
    ...(check.claims?.tokens ?? []).filter((value) => TOKEN.test(value)),
  ]);
  const memberDraft = safeMember(check.memberDraft, trusted);
  const memberEvidence = unique(
    (Array.isArray(check.memberEvidence) ? check.memberEvidence : []).flatMap(
      (line) => {
        if (line === "Transaction failed" && check.status === "failed")
          return [line];
        if (check.status !== "failed" || typeof line !== "string") return [];
        const match = /^([A-Za-z0-9.+-]{1,12}) stayed in your wallet$/.exec(
          line,
        );
        return match && trusted.has(match[1])
          ? [`${match[1]} stayed in your wallet`]
          : [];
      },
    ),
  ).slice(0, 16);
  const findings = unique(
    (Array.isArray(check.findings) ? check.findings : []).flatMap((finding) => {
      const text = typeof finding === "string" ? finding : finding?.text;
      const safe = safeFinding(text, trusted);
      return safe ? [safe] : [];
    }),
  );
  const reason =
    check.reason &&
    Object.prototype.hasOwnProperty.call(REASON_TEXT, check.reason)
      ? REASON_TEXT[check.reason as keyof typeof REASON_TEXT]
      : "";
  if (check.status === "failed" && reason) findings.unshift(reason);
  const whatHappened =
    safeFinding(check.whatHappened, trusted) ??
    safeMember(check.whatHappened, trusted) ??
    memberDraft ??
    STATUS_FACTS[check.status ?? ""] ??
    "";
  const texts = [
    whatHappened,
    memberDraft ?? "",
    ...findings,
    ...memberEvidence,
  ];
  const claims = {
    status: check.status,
    networks: Object.values(NETWORK_INFO)
      .map((item) => item.name)
      .filter((name) => texts.some((text) => text.includes(name))),
    numbers: unique(
      texts.flatMap((text) =>
        (text.match(NUMBER) ?? []).flatMap((value) =>
          value.startsWith("<") ? [value, value.slice(1)] : [value],
        ),
      ),
    ),
    tokens: [...trusted].filter((token) =>
      texts.some((text) =>
        new RegExp(`(?:^|[^A-Za-z0-9])${escape(token)}(?![A-Za-z0-9])`).test(
          text,
        ),
      ),
    ),
    shortRefs: unique(texts.flatMap((text) => text.match(SHORT_REF) ?? [])),
  };
  return {
    whatHappened,
    findings: unique(findings),
    memberDraft,
    memberEvidence,
    claims,
  };
}

export function modelDiagnosisFacts(diagnosis: Diagnosis) {
  const trusted = diagnosis.staff.evidence
    .filter(
      (row) =>
        row.id.startsWith("token:") &&
        (row.source === "builtin-list" || row.source === "workspace-label"),
    )
    .map((row) => row.value.split(",")[0]);
  const result = modelCheckFacts({
    status: diagnosis.status,
    reason: diagnosis.reason,
    whatHappened: diagnosis.staff.whatHappened,
    memberDraft: diagnosis.member?.text,
    memberEvidence: diagnosis.member?.evidence,
    findings: diagnosis.staff.findings,
    claims: { tokens: trusted },
  });
  return {
    ...result,
    claims: { ...result.claims, status: diagnosis.status } as DiagnosisClaims,
  };
}
