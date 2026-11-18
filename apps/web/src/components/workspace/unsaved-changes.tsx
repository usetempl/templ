"use client";

import { useEffect } from "react";

const DIRTY = '#main-content [data-unsaved="true"]';
const QUESTION = "You have unsaved changes. Leave without saving?";

/** Draft values stay in their form. Only their dirty state reaches navigation. */
export function UnsavedChanges({ dirty }: { dirty: boolean }) {
  return dirty ? <span hidden data-unsaved="true" /> : null;
}

export function confirmWorkspaceNavigation() {
  return !document.querySelector(DIRTY) || window.confirm(QUESTION);
}

/** Protect full-page exits and links handled outside the workspace tabs. */
export function useWorkspaceLeaveProtection() {
  useEffect(() => {
    let skipUnload = false;
    let reset: ReturnType<typeof setTimeout> | undefined;
    const unload = (event: BeforeUnloadEvent) => {
      if (skipUnload) return;
      if (!document.querySelector(DIRTY)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const link = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      const next = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (next.origin !== current.origin) return;
      if (
        next.origin === current.origin &&
        next.pathname === current.pathname &&
        next.search === current.search
      )
        return;
      if (!confirmWorkspaceNavigation()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else {
        skipUnload = true;
        clearTimeout(reset);
        reset = setTimeout(() => {
          skipUnload = false;
        }, 0);
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", link, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", link, true);
      clearTimeout(reset);
    };
  }, []);
}
