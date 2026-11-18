/** The fixed reaction set. Counts are public; reactor lists stay inside the room object. */
export const CHAT_REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "🔥",
  "👀",
  "🎉",
  "🙏",
  "😢",
] as const;
export type ChatReactionEmoji = (typeof CHAT_REACTIONS)[number];
export const MAX_REACTORS_PER_EMOJI = 500;
export function chatReaction(value: unknown): ChatReactionEmoji {
  if (
    typeof value !== "string" ||
    !(CHAT_REACTIONS as readonly string[]).includes(value)
  )
    throw new Error("Choose one of the available reactions.");
  return value as ChatReactionEmoji;
}
