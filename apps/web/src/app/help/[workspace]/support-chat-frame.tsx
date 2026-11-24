"use client";

import Image from "next/image";
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

export function SupportChatFrame({ children, label, accent, workspace, siteAppearance = false }: {
  children: ReactNode; label?: string; accent?: WidgetAccent; workspace?: string; siteAppearance?: boolean;
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
    <main id="main-content" data-chat-workspace={workspace} data-templ-site-appearance={siteAppearance ? "" : undefined} aria-label={label} tabIndex={-1} ref={page} className={styles.fullPage}>
      {children}
    </main>
  );
}

export function SupportChatLoading({
  name, logo, href,
  loadingHistory = false,
  unavailable = false,
  retryLink = false,
  retry,
}: {
  name: string; logo?: string; href?: string;
  loadingHistory?: boolean;
  unavailable?: boolean;
  retryLink?: boolean;
  retry?: () => void;
}) {
  const connecting = !retry && !unavailable;
  return (
    <div className={styles.loadingChat}>
      <header className={styles.loadingTitle}>
        {logo && <Image
          src={logo}
          alt=""
          width={36}
          height={36}
          loading="eager"
          unoptimized
        />}
        <h1>{name}</h1>
      </header>
      <div className={styles.loadingBody}>
        {retry || unavailable ? (
          <>
            <p role="alert">This chat could not load.</p>
            {retry && <button type="button" className="button quiet" onClick={retry}>Try again</button>}
            {retryLink && <a className="button quiet" href={href}>Try again</a>}
          </>
        ) : (
          <p role="status">
            {loadingHistory
              ? "Loading your conversation…"
              : `Connecting to ${name}…`}
          </p>
        )}
      </div>
      <div className={styles.loadingComposer}>
        <textarea aria-label="Message to the support team" disabled rows={1} placeholder={connecting ? "Loading..." : "Chat unavailable"} />
        <button type="button" aria-label="Send" aria-busy={connecting} disabled />
      </div>
    </div>
  );
}
