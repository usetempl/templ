/** Member screenshots from the widget. A member adds a PNG
 * to their own open request; the browser has already redrawn it without its
 * metadata, and the room re-encodes it from its pixels again
 * (`normalizePng`). The widget sends the bytes only while Templ has
 * `SUPPORT_MEMBER_SCREENSHOTS` on, which waits for the private media storage
 * trial. The widget never reads screenshots back; the team reads them
 * through the inbox's authorized attachment read.
 *
 * Limits: each file at most `memberScreenshotMaxBytes`, at most
 * `memberScreenshotsPerRequest` per request (counted from the request's
 * start), beside the thread's and the workspace's own screenshot caps. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportAttachment } from "@templ/chat/support";
import { HttpError } from "./common";
import { readCase, type CaseThreadId } from "./support-case-data";
import type { LedgerFields } from "./support-cases";

export type MemberScreenshotEnv = { SUPPORT_MEMBER_SCREENSHOTS?: string };
export const screenshotsOffered = (env: MemberScreenshotEnv) =>
  env.SUPPORT_MEMBER_SCREENSHOTS === "true";

/** A widget upload: a PNG body on the thread's workflow route. */
export const isScreenshotUpload = (path: string, request: Request) =>
  request.method === "POST" &&
  /^\/conversations\/tc-[0-9a-f]{32}\/workflow$/.test(path) &&
  request.headers.get("Content-Type") === "image/png";

const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The upload's bytes, read in full within the member limit before any
 * session read, and its retry id. A lost answer is retried with the same
 * id, which the room matches to the file it already took. */
export async function readScreenshotUpload(
  request: Request,
  url: URL,
): Promise<{ bytes: Uint8Array; clientId: string }> {
  if (request.headers.has("Content-Encoding"))
    throw new HttpError(415, "Choose a PNG screenshot.");
  const clientId = url.searchParams.get("clientId") ?? "";
  if (!CLIENT_ID.test(clientId) || [...url.searchParams.keys()].length !== 1)
    throw new HttpError(400, "Send a valid screenshot request id.");
  const limit = FEATURE_LIMITS.memberScreenshotMaxBytes;
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(415, "Choose a PNG screenshot.");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  if (!size) throw new HttpError(415, "Choose a PNG screenshot.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, clientId };
}
const tooLarge = () =>
  new HttpError(
    413,
    "This image is too large. Try a smaller screenshot.",
    undefined,
    "screenshot-too-large",
  );

/** A member's new screenshot fits the request's allowance: fewer than the
 * limit from this member since the current request opened. */
export async function assertMemberScreenshotRoom(
  storage: { get<T = unknown>(key: string): Promise<T | undefined> },
  thread: string,
  data: { attachments: SupportAttachment[] } & LedgerFields,
  aliases: readonly ChatPrincipalId[],
) {
  const seq = data.caseSeq ?? 0;
  const opened =
    seq > 0
      ? ((
          await readCase(storage as never, {
            thread: thread as CaseThreadId,
            seq,
          })
        )?.case.openedAt ?? 0)
      : 0;
  const count = data.attachments.filter(
    (item) =>
      (item.author === undefined || aliases.includes(item.author)) &&
      Date.parse(item.at) >= opened,
  ).length;
  const limit = FEATURE_LIMITS.memberScreenshotsPerRequest;
  if (count >= limit)
    throw new HttpError(
      409,
      `This case already has ${limit} screenshots.`,
      undefined,
      "screenshot-limit",
    );
}
