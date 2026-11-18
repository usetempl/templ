/** Preserve the local part. Provider-specific dot/plus/case merging can join distinct mailboxes. */
export function normalizeEmailValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  const match =
    /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/.exec(
      email,
    );
  if (
    !match ||
    email.length > 254 ||
    match[1].startsWith(".") ||
    match[1].endsWith(".") ||
    match[1].includes("..") ||
    !match[2].includes(".") ||
    match[2]
      .split(".")
      .some(
        (label) =>
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      )
  )
    return null;
  return `${match[1]}@${match[2].toLowerCase()}`;
}
