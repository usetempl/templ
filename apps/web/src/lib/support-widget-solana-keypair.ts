const PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function solanaBytesAreKeypair(
  bytes: Uint8Array,
): Promise<boolean> {
  if (bytes.length !== 64) return false;
  const der = new Uint8Array(PREFIX.length + 32);
  der.set(PREFIX);
  der.set(bytes.slice(0, 32), PREFIX.length);
  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "Ed25519" },
      true,
      ["sign"],
    );
  } catch {
    key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" } as never,
      true,
      ["sign"],
    );
  }
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as { x?: unknown };
  if (typeof jwk.x !== "string")
    throw new Error("The secret check is unavailable.");
  return jwk.x === base64url(bytes.slice(32));
}
