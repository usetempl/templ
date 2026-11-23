"use client";

import Image from "next/image";
import { useEffect, useRef, type ReactNode } from "react";
import styles from "./help.module.css";

export function SupportChatFrame({ children, label, siteAppearance = false }: { children: ReactNode; label?: string; siteAppearance?: boolean }) {
  const page = useRef<HTMLElement>(null);
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
    <main id="main-content" data-templ-site-appearance={siteAppearance ? "" : undefined} aria-label={label} tabIndex={-1} ref={page} className={styles.fullPage}>
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
