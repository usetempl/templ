/** Public notice inputs. They never confer legal authority or access rights. */
/** Bounded daily intake capacity. Linked accounts share one principal budget. */
export const SAFETY_REPORT_LIMITS = {
  principal: 100,
  ip: 200,
  service: 10_000,
} as const;
export const SAFETY_REASONS = [
  ["legal-request", "Request from a legal authority"],
  ["mandatory-notice", "Notice required by law"],
  ["child-safety", "Child sexual exploitation or abuse"],
  ["imminent-harm", "Immediate threat to life or serious injury"],
  ["appeal", "Appeal a platform decision"],
] as const;
export type SafetyReason = (typeof SAFETY_REASONS)[number][0];
export type LegalNotice = {
  jurisdiction: string | null;
  legalBasis: string | null;
  noticeObligation: string | null;
  evidence: string | null;
  reporterName: string | null;
  contactEmail: string | null;
  goodFaith: boolean;
  authority: {
    organization: string;
    officialContact: string;
    reference: string;
    requestedAction: "removal" | "preservation" | "disclosure";
  } | null;
};
export function ordinaryLegalNotice(reason: string) {
  return reason === "mandatory-notice" || reason === "legal-request";
}
const plain = (
  value: unknown,
  label: string,
  max: number,
  required: boolean,
) => {
  if (value == null || value === "") {
    if (required) throw new Error(`Add ${label}.`);
    return null;
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new Error(`Check ${label}.`);
  return value.trim();
};
export function legalNotice(reason: string, input: unknown): LegalNotice {
  if (!SAFETY_REASONS.some(([value]) => value === reason))
    throw new Error(
      "Choose a legal report reason. Contact the room’s moderators for community disputes.",
    );
  if (input != null && (typeof input !== "object" || Array.isArray(input)))
    throw new Error("Check the notice details.");
  const data = (input ?? {}) as Record<string, unknown>;
  const required = ordinaryLegalNotice(reason);
  const email = plain(data.contactEmail, "a contact email", 254, required);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Check the contact email.");
  if (required && data.goodFaith !== true)
    throw new Error(
      "Confirm that this notice is accurate and made in good faith.",
    );
  let authority: LegalNotice["authority"] = null;
  if (reason === "legal-request") {
    if (
      !data.authority ||
      typeof data.authority !== "object" ||
      Array.isArray(data.authority)
    )
      throw new Error("Add the requesting authority and legal instrument.");
    const claim = data.authority as Record<string, unknown>;
    if (
      !["removal", "preservation", "disclosure"].includes(
        String(claim.requestedAction),
      )
    )
      throw new Error("Choose what the legal request asks Templ to do.");
    authority = {
      organization: plain(
        claim.organization,
        "the authority’s name",
        200,
        true,
      )!,
      officialContact: plain(
        claim.officialContact,
        "the authority’s official contact reference",
        500,
        true,
      )!,
      reference: plain(
        claim.reference,
        "the order or request reference",
        500,
        true,
      )!,
      requestedAction: claim.requestedAction as NonNullable<
        LegalNotice["authority"]
      >["requestedAction"],
    };
  }
  return {
    jurisdiction: plain(
      data.jurisdiction,
      "the country or jurisdiction",
      200,
      required,
    ),
    legalBasis: plain(
      data.legalBasis,
      "the law or legal basis",
      1000,
      required,
    ),
    noticeObligation: plain(
      data.noticeObligation,
      "the law and provision requiring Templ to accept this notice",
      1000,
      reason === "mandatory-notice",
    ),
    evidence: plain(
      data.evidence,
      "the exact content location and supporting facts or references",
      1500,
      required,
    ),
    reporterName: plain(
      data.reporterName,
      "your name or organization",
      200,
      required,
    ),
    contactEmail: email,
    goodFaith: data.goodFaith === true,
    authority,
  };
}
