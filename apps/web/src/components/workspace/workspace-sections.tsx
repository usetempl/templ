"use client";

import { useEffect } from "react";
import styles from "./workspace-settings.module.css";

export function useWorkspaceSectionFocus(ids: string[]) {
  const key = ids.join("|");
  useEffect(() => {
    let observer: MutationObserver | undefined;
    const reveal = () => {
      observer?.disconnect();
      const id = window.location.hash.slice(1);
      if (!key.split("|").includes(id)) return;
      const focus = () => {
        const section = document.getElementById(id);
        const control = section?.querySelector<HTMLElement>(
          "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], summary",
        );
        if (!control) return false;
        if (section instanceof HTMLDetailsElement) section.open = true;
        section?.scrollIntoView?.({ block: "start" });
        control.focus({ preventScroll: true });
        return true;
      };
      if (focus()) return;
      observer = new MutationObserver(() => {
        if (focus()) observer?.disconnect();
      });
      observer.observe(
        document.getElementById("main-content") ?? document.body,
        { childList: true, subtree: true },
      );
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    window.addEventListener("popstate", reveal);
    return () => {
      observer?.disconnect();
      window.removeEventListener("hashchange", reveal);
      window.removeEventListener("popstate", reveal);
    };
  }, [key]);
}

export function WorkspaceSections({
  items,
}: {
  items: { id: string; label: string }[];
}) {
  useWorkspaceSectionFocus(items.map((item) => item.id));
  return (
    <nav className={styles.sectionNav} aria-label="Page sections">
      {items.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          onClick={() => {
            const section = document.getElementById(id);
            section
              ?.querySelector<HTMLElement>(
                "input, textarea, select, button, a[href]",
              )
              ?.focus({ preventScroll: true });
          }}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
