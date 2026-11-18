/** Shared labels for wallet proof. An address alone grants no authority. */
export const SUPPORT_IDENTITY = ["guest", "attached", "verified"] as const;
export type SupportIdentity = (typeof SUPPORT_IDENTITY)[number];
export const SUPPORT_IDENTITY_LABELS = {
  guest: "Guest",
  attached: "Attached wallet",
  verified: "Verified wallet",
} as const;
/** The label for an access level. "app" is a Templ app session, which is a
 * wallet sign-in. */
export function identityOf(access: {
  level: string;
  wallet?: unknown;
}): SupportIdentity {
  if (access.level === "signed" || access.level === "app") return "verified";
  if (access.level === "connected") return "attached";
  return "guest";
}
/** The member's identity on a thread. Widget threads record their access
 * level from the first request; a thread without one was written from the
 * Templ app. */
export function threadIdentity(thread: {
  access?: { level: string } | null;
  wallet?: unknown;
}): SupportIdentity {
  return identityOf({
    level: thread.access?.level ?? (thread.wallet ? "signed" : "app"),
  });
}
