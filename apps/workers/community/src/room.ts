import { HttpError } from "./common";
import { ChannelRoom } from "./channels";

export const MAX_MESSAGE_BYTES = 4_000;

export function messageText(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(400, "Write a message first.");
  const text = value.trim();
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES)
    throw new HttpError(413, "Messages must be 4,000 UTF-8 bytes or less.");
  // Messages allow tabs and line breaks, but reject other control characters.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    throw new HttpError(
      400,
      "Message contains unsupported control characters.",
    );
  return text;
}

/** Factory-scoped room storage; only the worker may dispatch verified access. */
export class CommunityRoom extends ChannelRoom {}
