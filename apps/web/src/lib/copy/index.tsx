import { type ReactNode } from "react";
import { messages, type MessageKey } from "./messages";

export { messages } from "./messages";
export type { MessageKey } from "./messages";
export type Params = Record<string, string | number>;

/** Fill named values without interpreting them as markup. */
function formatCopy(key: MessageKey, params?: Params): string {
  const text = messages[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Single-level tags mark the words a caller renders as a link or accent. */
function richCopy(
  key: MessageKey,
  components: Record<string, (chunks: ReactNode) => ReactNode>,
  params?: Params,
): ReactNode {
  const text = formatCopy(key, params);
  const parts: ReactNode[] = [];
  const pattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const render = components[match[1]];
    parts.push(
      render ? (
        <span key={index++} style={{ display: "contents" }}>
          {render(match[2])}
        </span>
      ) : (
        match[2]
      ),
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : parts;
}

export const copy = Object.assign(formatCopy, { rich: richCopy });
