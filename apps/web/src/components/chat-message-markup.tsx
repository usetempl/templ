import { Fragment, type ReactNode } from "react";
import styles from "./chat-message-markup.module.css";

type InlineRenderer = (text: string, key: string) => ReactNode;

function linkAt(text: string, at: number) {
  const labelEnd = text.indexOf("](", at + 1);
  if (labelEnd < 0 || text.slice(at, labelEnd).includes("\n")) return;
  let depth = 1;
  for (let end = labelEnd + 2; end < text.length; end++) {
    if (text[end] === "\n") return;
    if (text[end] === "(") depth++;
    if (text[end] !== ")" || --depth !== 0) continue;
    const raw = text.slice(at, end + 1);
    const destination = text.slice(labelEnd + 2, end).trim();
    let href: string | undefined;
    if (
      /^https?:\/\//i.test(destination) &&
      !/[\s\\<>"\u0000-\u001f\u007f]/u.test(destination)
    ) {
      try {
        const url = new URL(destination);
        if (url.hostname && !url.username && !url.password) href = url.href;
      } catch {
        href = undefined;
      }
    }
    return { raw, label: text.slice(at + 1, labelEnd), href };
  }
}

function inlineText(
  text: string,
  inline: InlineRenderer,
  key: string,
  depth = 0,
  links = true,
): ReactNode {
  if (depth >= 6) return inline(text, key);
  const nodes: ReactNode[] = [];
  let start = 0;
  let at = 0;
  const flush = () => {
    if (at > start)
      nodes.push(inline(text.slice(start, at), `${key}:${start}`));
  };
  const push = (node: ReactNode, length: number) => {
    flush();
    nodes.push(<Fragment key={`${key}:token:${at}`}>{node}</Fragment>);
    at += length;
    start = at;
  };
  while (at < text.length) {
    if (
      text[at] === "\\" &&
      /[\\`*_{}[\]()#+\-.!>~]/.test(text[at + 1] ?? "")
    ) {
      push(text[at + 1], 2);
      continue;
    }
    const autoLink = links && /^<https?:\/\/[^<>\s]+>/i.exec(text.slice(at));
    if (autoLink) {
      push(
        inline(autoLink[0].slice(1, -1), `${key}:url:${at}`),
        autoLink[0].length,
      );
      continue;
    }
    const literalTag = /^<\/?[A-Za-z][^>\n]*>/.exec(text.slice(at));
    if (literalTag) {
      push(literalTag[0], literalTag[0].length);
      continue;
    }
    const bare = links && /^https?:\/\/[^\s<>"`]+/i.exec(text.slice(at));
    if (bare) {
      at += bare[0].length;
      continue;
    }
    if (text[at] === "`") {
      const marker = /^`+/.exec(text.slice(at))![0];
      const end = text.indexOf(marker, at + marker.length);
      if (end >= 0 && !text.slice(at, end).includes("\n")) {
        push(
          <code>{text.slice(at + marker.length, end)}</code>,
          end + marker.length - at,
        );
        continue;
      }
    }
    const image = text[at] === "!" && text[at + 1] === "[";
    if (links && (image || text[at] === "[")) {
      const link = linkAt(text, image ? at + 1 : at);
      if (link) {
        push(
          image ? (
            `!${link.raw}`
          ) : link.href ? (
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
            >
              {inlineText(
                link.label,
                (value) => value,
                `${key}:label:${at}`,
                depth + 1,
                false,
              )}
            </a>
          ) : (
            link.raw
          ),
          link.raw.length + Number(image),
        );
        continue;
      }
    }
    const marker = ["***", "___", "**", "__", "~~", "*", "_"].find((value) =>
      text.startsWith(value, at),
    );
    if (
      marker &&
      !/\s/.test(text[at + marker.length] ?? " ") &&
      !(marker.includes("_") && /[\p{L}\p{N}_]/u.test(text[at - 1] ?? ""))
    ) {
      let end = text.indexOf(marker, at + marker.length);
      while (end >= 0 && (text[end - 1] === "\\" || /\s/.test(text[end - 1])))
        end = text.indexOf(marker, end + marker.length);
      if (end > at + marker.length && !text.slice(at, end).includes("\n")) {
        const content = inlineText(
          text.slice(at + marker.length, end),
          inline,
          `${key}:em:${at}`,
          depth + 1,
          links,
        );
        push(
          marker.length === 3 ? (
            <strong>
              <em>{content}</em>
            </strong>
          ) : marker === "~~" ? (
            <s>{content}</s>
          ) : marker.length === 2 ? (
            <strong>{content}</strong>
          ) : (
            <em>{content}</em>
          ),
          end + marker.length - at,
        );
        continue;
      }
    }
    at++;
  }
  flush();
  return nodes;
}

const listItem = (line: string) =>
  /^( {0,12})([-+*]|\d{1,9}[.)])[ \t]+(.+)$/.exec(line);
const fence = (line: string) =>
  /^ {0,3}(`{3,}|~{3,})([A-Za-z0-9_+-]{0,20})[ \t]*$/.exec(line);
const heading = (line: string) =>
  /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
const quote = (line: string) => /^ {0,3}>[ \t]?(.*)$/.exec(line);

function blocks(
  lines: string[],
  inline: InlineRenderer,
  key: string,
  depth = 0,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  while (at < lines.length) {
    if (!lines[at].trim()) {
      at++;
      continue;
    }
    const blockKey = `${key}:${at}`;
    const open = fence(lines[at]);
    if (open) {
      const close = lines.findIndex(
        (line, index) =>
          index > at &&
          line.trim().length >= open[1].length &&
          [...line.trim()].every((character) => character === open[1][0]),
      );
      if (close >= 0) {
        nodes.push(
          <pre key={blockKey} data-language={open[2] || undefined}>
            <code>{lines.slice(at + 1, close).join("\n")}</code>
          </pre>,
        );
        at = close + 1;
        continue;
      }
      nodes.push(
        <p key={blockKey}>{inline(lines.slice(at).join("\n"), blockKey)}</p>,
      );
      break;
    }
    const title = heading(lines[at]);
    if (title) {
      nodes.push(
        <p className={styles.heading} key={blockKey}>
          <strong>{inlineText(title[1], inline, blockKey)}</strong>
        </p>,
      );
      at++;
      continue;
    }
    if (depth < 4 && quote(lines[at])) {
      const quoted: string[] = [];
      while (at < lines.length) {
        const part = quote(lines[at]);
        if (!part) break;
        quoted.push(part[1]);
        at++;
      }
      nodes.push(
        <blockquote key={blockKey}>
          {blocks(quoted, inline, blockKey, depth + 1)}
        </blockquote>,
      );
      continue;
    }
    const first = depth < 4 && listItem(lines[at]);
    if (first) {
      const ordered = /^\d/.test(first[2]);
      const indent = first[1].length;
      const items: ReactNode[] = [];
      while (at < lines.length) {
        const item = listItem(lines[at]);
        if (
          !item ||
          item[1].length !== indent ||
          /^\d/.test(item[2]) !== ordered
        )
          break;
        const itemKey = `${blockKey}:item:${at}`;
        const content = [item[3]];
        const contentIndent = item[0].length - item[3].length;
        at++;
        while (at < lines.length && lines[at].trim()) {
          const next = listItem(lines[at]);
          if (next && next[1].length <= indent) break;
          const padding = /^ */.exec(lines[at])![0].length;
          if (
            padding <= indent &&
            (fence(lines[at]) || heading(lines[at]) || quote(lines[at]))
          )
            break;
          content.push(lines[at].slice(Math.min(contentIndent, padding)));
          at++;
        }
        items.push(
          <li key={itemKey}>{blocks(content, inline, itemKey, depth + 1)}</li>,
        );
        if (!lines[at]?.trim()) {
          let next = at;
          while (next < lines.length && !lines[next].trim()) next++;
          const nextItem = listItem(lines[next] ?? "");
          if (
            !nextItem ||
            nextItem[1].length !== indent ||
            /^\d/.test(nextItem[2]) !== ordered
          )
            break;
          at = next;
        }
      }
      nodes.push(
        ordered ? (
          <ol key={blockKey} start={Number.parseInt(first[2], 10)}>
            {items}
          </ol>
        ) : (
          <ul key={blockKey}>{items}</ul>
        ),
      );
      continue;
    }
    const paragraph = [lines[at++]];
    while (
      at < lines.length &&
      lines[at].trim() &&
      !fence(lines[at]) &&
      !heading(lines[at]) &&
      !(depth < 4 && (listItem(lines[at]) || quote(lines[at])))
    )
      paragraph.push(lines[at++]);
    nodes.push(
      <p key={blockKey}>
        {inlineText(paragraph.join("\n"), inline, blockKey)}
      </p>,
    );
  }
  return nodes;
}

/** Formats support text as React nodes. HTML and remote images stay literal. */
export function ChatMessageMarkup({
  text,
  inline,
}: {
  text: string;
  inline: InlineRenderer;
}) {
  return (
    <div className={styles.message}>
      {blocks(text.replace(/\r\n?/g, "\n").split("\n"), inline, "message")}
    </div>
  );
}
