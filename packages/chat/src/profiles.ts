import type { ChatPrincipalId } from "./principal";

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 32;
export const RESERVED_NAME_TERMS = [
  "admin",
  "administrator",
  "mod",
  "moderator",
  "official",
  "staff",
  "support",
  "templ",
  "safe",
  "verified",
  "owner",
  "team",
] as const;
export const PROFILE_CHANGES_PER_DAY = 3;
/** Public profile fields. Email and sign-in details never appear here. */
export type MemberProfile = {
  principalId: ChatPrincipalId;
  displayName: string | null;
  /** Owner-scoped media URL on the selected Templ community host. */
  avatar: string | null;
  /** Self-declared by the account; it grants nothing. */
  agent: boolean;
  updatedAt: string | null;
};
export type MemberProfilePage = { profiles: MemberProfile[] };
export type ProfileUpdate = {
  displayName?: string | null;
  avatar?: string | null;
  agent?: boolean;
};
const LENGTH_ERROR = "Use 2 to 32 characters.";
const UNAVAILABLE_ERROR = "That name isn’t available.";
const HIDDEN_ERROR = "Remove hidden characters from the name.";
// Control, zero-width, bidi override and byte-order characters.
const hidden =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
// A zero-width joiner between two pictographs (after an optional variation
// selector or skin tone) is part of an emoji sequence, not a hidden character.
// eslint-disable-next-line no-misleading-character-class
const emojiJoiner =
  /(\p{Extended_Pictographic}[\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]?)\u200d(?=\p{Extended_Pictographic})/gu;
/** True when `text` carries control, zero-width, bidi override or byte-order
 * characters. Joiners inside emoji sequences such as 🏳️‍🌈 or 👨‍👩‍👧 pass;
 * a joiner between ordinary letters does not. `allowLineBreaks` keeps tab,
 * newline and carriage return for multi-line text. */
export function hasHiddenCharacters(
  text: string,
  options: { allowLineBreaks?: boolean } = {},
): boolean {
  const stripped = text.replace(emojiJoiner, "$1");
  if (!hidden.test(stripped)) return false;
  if (!options.allowLineBreaks) return true;
  return hidden.test(stripped.replace(/[\t\n\r]/g, ""));
}
const addressLike = /0x[0-9a-f]{6,}/i;
const nameServiceSuffix = /\.(eth|base\.eth|cb\.id)$/i;
const AVATAR_URL =
  /^https:\/\/community\.(?:templ\.vip|usetempl\.com)\/media\/([0-9a-f]{64})$/;
/** Returns the owner-scoped media id for a canonical staging or production
 * URL. A service can supply its selected community origin to reject a URL
 * from the other environment. */
export function profileMediaHash(
  value: unknown,
  communityOrigin?: string,
): string | null {
  if (typeof value !== "string") return null;
  const match = AVATAR_URL.exec(value);
  if (!match) return null;
  if (communityOrigin && value !== `${communityOrigin}/media/${match[1]}`)
    return null;
  return match[1];
}
/** NFKC, trim, collapse whitespace; rejects control/zero-width/bidi characters,
 * 0x addresses, `.eth`/`.base.eth`/`.cb.id` suffixes and reserved terms
 * (whole word, case-insensitive). Throws Error with text for the person. */
export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new Error(LENGTH_ERROR);
  const collapsed = value
    .normalize("NFKC")
    .replace(/[\t\n\r\f\v\p{Zs}]+/gu, " ");
  if (hasHiddenCharacters(collapsed)) throw new Error(HIDDEN_ERROR);
  const name = collapsed.trim();
  const length = [...name].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX)
    throw new Error(LENGTH_ERROR);
  if (addressLike.test(name) || nameServiceSuffix.test(name))
    throw new Error(UNAVAILABLE_ERROR);
  const words = name
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (
    words.some((word) =>
      (RESERVED_NAME_TERMS as readonly string[]).includes(word),
    )
  )
    throw new Error(UNAVAILABLE_ERROR);
  return name;
}
/** Validates a profile change body. Avatar URLs must point at an uploaded media
 * hash; the server separately checks that this account uploaded it. */
export function profileUpdate(
  value: unknown,
  communityOrigin?: string,
): ProfileUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a profile change.");
  const body = value as Record<string, unknown>;
  const update: ProfileUpdate = {};
  if (body.displayName !== undefined)
    update.displayName =
      body.displayName === null ? null : normalizeDisplayName(body.displayName);
  if (body.avatar !== undefined) {
    if (body.avatar !== null) {
      if (!profileMediaHash(body.avatar, communityOrigin))
        throw new Error("Upload a profile image first.");
    }
    update.avatar = body.avatar as string | null;
  }
  if (body.agent !== undefined) {
    if (typeof body.agent !== "boolean")
      throw new Error("Choose whether this account is an agent.");
    update.agent = body.agent;
  }
  if (Object.keys(update).length === 0)
    throw new Error("Choose a profile change.");
  return update;
}
