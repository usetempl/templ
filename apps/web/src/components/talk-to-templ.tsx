"use client";

import type { ReactNode } from "react";
import {
  TemplSupportButton,
  templSupportMailto,
  useTemplSupportAvailable,
  type TemplSupportTopic,
} from "@/components/templ-support";
import styles from "./talk-to-templ.module.css";

/** Open Templ's widget. Required notices keep their mailbox fallback. */
export function TalkToTempl({
  label,
  className,
  conversion,
  topic,
  children,
}: {
  /** The button's accessible name when it opens the widget. */
  label: string;
  /** Without a class, the button looks like a link. */
  className?: string;
  /** The landing click this counts as, if any. */
  conversion?: "talk_to_us_clicked";
  /** Prepare a privacy, legal or security question in Templ's widget. */
  topic?: TemplSupportTopic;
  children: ReactNode;
}) {
  const available = useTemplSupportAvailable();
  return available || !topic ? (
    <TemplSupportButton
      className={className ?? styles.link}
      label={label}
      icon={false}
      conversion={conversion}
      topic={topic}
    >
      {children}
    </TemplSupportButton>
  ) : (
    <a
      href={templSupportMailto(topic)}
      className={className}
      data-templ-conversion={conversion}
    >
      {children}
    </a>
  );
}
