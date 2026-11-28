"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { setPageChatAccent, type WidgetAccent } from "@/lib/support-widget-appearance";
import styles from "./help.module.css";

// This element stays mounted while the server replaces the initial loading frame.
const restoreChatTheme = `try{const s=document.currentScript.parentElement;s.dataset.connectingTheme=localStorage.getItem("templ:chat-theme:"+s.dataset.chatThemeScope)==="dark"?"dark":"light"}catch{}`;

export function SupportChatThemeScope({ children, workspace, nonce }: {
  children: ReactNode; workspace: string; nonce?: string;
}) {
  const scope = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Client-side navigation creates the element without executing its inline script.
    if (!scope.current) return;
    try {
      scope.current.dataset.connectingTheme =
        localStorage.getItem("templ:chat-theme:" + workspace) === "dark" ? "dark" : "light";
    } catch { /* The first-visit theme also works when storage is unavailable. */ }
  }, [workspace]);
  return (
    <div className={styles.themeScope} data-chat-theme-scope={workspace} ref={scope} suppressHydrationWarning>
      <script nonce={nonce} dangerouslySetInnerHTML={{__html: restoreChatTheme}} />
      {children}
    </div>
  );
}

export function SupportChatFrame({ children, label, accent, workspace, siteAppearance = false, lang, dir }: {
  children: ReactNode; label?: string; accent?: WidgetAccent; workspace?: string; siteAppearance?: boolean;
  /** The visitor's chosen interface language, when it is not the page's. */
  lang?: string; dir?: "ltr" | "rtl";
}) {
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page.current) setPageChatAccent(page.current, accent);
  }, [accent]);
  useEffect(() => {
    const root = page.current;
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
    const fitViewport = () => {
      root.style.setProperty("--chat-height", viewport.scale === 1 ? `${viewport.height}px` : "100dvh");
      root.style.setProperty("--chat-top", viewport.scale === 1 ? `${viewport.offsetTop}px` : "0px");
    };
    fitViewport();
    window.addEventListener("resize", fitViewport);
    window.addEventListener("pageshow", fitViewport);
    viewport.addEventListener("resize", fitViewport);
    viewport.addEventListener("scroll", fitViewport);
    return () => {
      window.removeEventListener("resize", fitViewport);
      window.removeEventListener("pageshow", fitViewport);
      viewport.removeEventListener("resize", fitViewport);
      viewport.removeEventListener("scroll", fitViewport);
    };
  }, []);
  return (
    <main id="main-content" data-chat-workspace={workspace} data-templ-site-appearance={siteAppearance ? "" : undefined} aria-label={label} lang={lang} dir={dir} tabIndex={-1} ref={page} className={styles.fullPage}>
      {children}
    </main>
  );
}

export { ChatLoading as SupportChatLoading } from "@/components/chat-loading";
