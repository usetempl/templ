import { hasHiddenCharacters, profileMediaHash } from "@templ/chat/profiles";
import type {
  SupportContactRole,
  WorkspaceSupportProfiles,
} from "@templ/chat/support";
import { HttpError } from "./common";

const KEY = "support-contact-profiles-v1";
const PAUSED_AT = "support-assistant-last-pause-v1";

/** Work accepted before a pause must not restart after the assistant is enabled. */
export async function lastAssistantPause(
  storage: Pick<DurableObjectTransaction, "get">,
) {
  const pause = await storage.get<number>(PAUSED_AT);
  if (pause === undefined) return 0;
  if (!Number.isSafeInteger(pause) || pause < 0)
    throw new HttpError(503, "The assistant settings could not be read.");
  return pause;
}
const empty = () => ({ name: null, image: null });
export const isSupportContactRole = (
  value: unknown,
): value is SupportContactRole => value === "founder" || value === "assistant";

export function readSupportProfiles(
  storage: Pick<DurableObjectTransaction, "get">,
) {
  return storage.get<WorkspaceSupportProfiles>(KEY);
}

export async function saveSupportProfile(
  storage: DurableObjectTransaction,
  role: SupportContactRole,
  body: Record<string, unknown>,
  communityOrigin?: string,
) {
  const previous = await readSupportProfiles(storage);
  const current: WorkspaceSupportProfiles = previous ?? {
    revision: 0,
    founder: empty(),
    assistant: empty(),
    assistantEnabled: true,
  };
  if (body.profileRevision !== current.revision)
    throw new HttpError(
      409,
      "The support profiles changed. Reload before saving.",
    );
  const next = { ...current, [role]: { ...current[role] } };
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string")
      throw new HttpError(400, "Enter a display name.");
    const name = body.name.normalize("NFKC").trim();
    if (!name || Array.from(name).length > 48 || hasHiddenCharacters(name))
      throw new HttpError(
        400,
        "Enter a display name of up to 48 visible characters.",
      );
    next[role].name = name;
  } else if (body.name === null) next[role].name = null;
  if (body.image !== undefined) {
    if (body.image !== null && !profileMediaHash(body.image, communityOrigin))
      throw new HttpError(400, "Upload a support profile photo first.");
    next[role].image = body.image as string | null;
  }
  if (role === "founder" && body.teamLink !== undefined) {
    if (body.teamLink === null) delete next.teamLink;
    else {
      const value = body.teamLink as { name?: unknown; website?: unknown };
      if (typeof value.name !== "string" || typeof value.website !== "string")
        throw new HttpError(400, "Enter a team name and its HTTPS website.");
      const name = value.name.normalize("NFKC").trim();
      if (!name || Array.from(name).length > 48 || hasHiddenCharacters(name))
        throw new HttpError(400, "Enter a team name of up to 48 visible characters.");
      let site: URL;
      try { site = new URL(value.website); } catch { throw new HttpError(400, "Enter the team's HTTPS website."); }
      if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash ||
          site.pathname !== "/" || !site.hostname.includes(".") || value.website.length > 2048)
        throw new HttpError(400, "Enter an HTTPS website such as https://example.com.");
      next.teamLink = { name, website: site.origin };
    }
  }
  if (body.assistantEnabled !== undefined) {
    if (role !== "assistant" || typeof body.assistantEnabled !== "boolean")
      throw new HttpError(400, "Choose whether the assistant can answer.");
    if (current.assistantEnabled && !body.assistantEnabled)
      await storage.put(PAUSED_AT, Date.now());
    next.assistantEnabled = body.assistantEnabled;
  }
  next.revision++;
  await storage.put(KEY, next);
  return next;
}
