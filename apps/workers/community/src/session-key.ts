/** The key a session's leases and challenges are stored under: the SHA-256
 * of its token in lowercase hex, so no store keeps the token itself. */
export async function sessionCacheKey(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
