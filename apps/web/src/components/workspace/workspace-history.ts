"use client";

import { useCallback, useEffect, useRef } from "react";
import { confirmWorkspaceNavigation } from "./unsaved-changes";

type Position = { scope: string; index: number };
const position = (state: unknown): Position | undefined => {
  const value = (state as { templWorkspaceNavigation?: Position } | null)
    ?.templWorkspaceNavigation;
  return value &&
    typeof value.scope === "string" &&
    Number.isSafeInteger(value.index)
    ? value
    : undefined;
};

/** Keep tab history without replacing Next's own history state. */
export function useWorkspaceHistory(scope: string, onPop: () => void) {
  const accepted = useRef("");
  const acceptedState = useRef<Record<string, unknown>>({});
  const index = useRef(0);
  const restoring = useRef(false);
  useEffect(() => {
    const initial = position(window.history.state);
    index.current = initial?.scope === scope ? initial.index : 0;
    accepted.current = window.location.href;
    window.history.replaceState(
      {
        ...window.history.state,
        templWorkspaceNavigation: { scope, index: index.current },
      },
      "",
      accepted.current,
    );
    acceptedState.current = { ...window.history.state };
    const pop = (event: PopStateEvent) => {
      if (restoring.current) {
        restoring.current = false;
        event.stopImmediatePropagation();
        return;
      }
      const previous = new URL(accepted.current);
      const next = new URL(window.location.href);
      const changesPage =
        previous.pathname !== next.pathname || previous.search !== next.search;
      const target = position(event.state);
      if (changesPage && !confirmWorkspaceNavigation()) {
        event.stopImmediatePropagation();
        if (target?.scope === scope && target.index !== index.current) {
          restoring.current = true;
          window.history.go(index.current - target.index);
        } else {
          window.history.pushState(
            {
              ...acceptedState.current,
              templWorkspaceNavigation: { scope, index: index.current },
            },
            "",
            accepted.current,
          );
        }
        return;
      }
      index.current = target?.scope === scope ? target.index : 0;
      accepted.current = next.href;
      acceptedState.current = { ...window.history.state };
      onPop();
    };
    window.addEventListener("popstate", pop, true);
    return () => window.removeEventListener("popstate", pop, true);
  }, [scope, onPop]);
  return useCallback(
    (url: URL, replace = false) => {
      if (url.href === window.location.href) return true;
      if (!replace && !confirmWorkspaceNavigation()) return false;
      if (!replace) index.current += 1;
      window.history[replace ? "replaceState" : "pushState"](
        {
          ...window.history.state,
          templWorkspaceNavigation: { scope, index: index.current },
        },
        "",
        url,
      );
      accepted.current = url.href;
      acceptedState.current = { ...window.history.state };
      return true;
    },
    [scope],
  );
}
