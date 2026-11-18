import { communityAccent } from "@templ/chat/appearance";
import { HttpError } from "./common";

export function accentColor(value?: unknown) {
  try {
    return communityAccent(value);
  } catch {
    throw new HttpError(
      400,
      "Choose a bright color with a six-digit hex code.",
    );
  }
}
