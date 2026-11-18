"use client";

import { Fragment, useState, type ReactNode } from "react";
import { copy as t } from "@/lib/copy";
import { ChatMessageMarkup } from "./chat-message-markup";

/** Message formatting never interprets HTML or loads remote images. */
type InlineRenderer = (text: string, key: string) => ReactNode;
const LONG_MESSAGE_CHARS = 1_200;

/** Links complete https/http addresses; everything else is literal text. */
function linkifyText(text: string, key = "text"): ReactNode {
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"`]+/giu)) {
    let label = match[0].replace(/[.,!?;:]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]) {
      while (
        label.endsWith(close) &&
        label.split(close).length > label.split(open).length
      )
        label = label.slice(0, -1);
    }
    let url: URL;
    try {
      url = new URL(label);
    } catch {
      continue;
    }
    if (!url.hostname || url.username || url.password) continue;
    parts.push(
      <Fragment key={`${key}:${match.index}`}>
        {text.slice(end, match.index)}
        <a
          href={url.href}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
        >
          {label}
        </a>
      </Fragment>,
    );
    end = match.index + label.length;
  }
  if (!parts.length) return text;
  return (
    <Fragment key={key}>
      {parts}
      {text.slice(end)}
    </Fragment>
  );
}

export function ChatMessageText({
  text,
  inline: customInline,
  collapseAfter = LONG_MESSAGE_CHARS,
}: {
  text: string;
  inline?: InlineRenderer;
  /** Messages longer than this many characters start collapsed. */
  collapseAfter?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const inline = customInline ?? linkifyText;
  const characters = Array.from(text);
  const long = characters.length > collapseAfter;
  const shown =
    long && !expanded ? characters.slice(0, collapseAfter).join("") : text;
  return (
    <>
      <ChatMessageMarkup text={shown} inline={inline} />
      {long && !expanded && (
        <>
          …{" "}
          <button
            type="button"
            data-show-more
            onClick={() => setExpanded(true)}
          >
            {t("room.message.showMore")}
          </button>
        </>
      )}
    </>
  );
}

const messageDayFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});
export function messageDay(createdAt: string) {
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime())
    ? messageDayFormatter.format(date)
    : date.toLocaleDateString();
}
