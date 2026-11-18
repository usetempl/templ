/** Fields every Workers Logs line of the worker carries so a watch can tell
 * which deployed version wrote it. The version id comes
 * from Cloudflare's version metadata binding; it names a deployment, never a
 * person, workspace or request. */
export type VersionEnv = {
  CF_VERSION_METADATA?: { id?: unknown };
};
const VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The deployed version's id, or "unknown" when the binding is absent or
 * holds anything other than a lowercase UUID. */
export function logVersionId(env: VersionEnv | undefined): string {
  const id = env?.CF_VERSION_METADATA?.id;
  return typeof id === "string" && VERSION_ID.test(id) ? id : "unknown";
}
