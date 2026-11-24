import Image from "next/image";
import type { ReactNode } from "react";
import styles from "./chat-loading.module.css";

export function ChatLoading({
  name, logo, href, loadingHistory = false, unavailable = false, retryLink = false,
  retry, status, closeControl,
}: {
  name: string;
  logo?: string;
  href?: string;
  loadingHistory?: boolean;
  unavailable?: boolean;
  retryLink?: boolean;
  retry?: () => void;
  status?: string;
  closeControl?: ReactNode;
}) {
  const connecting = !retry && !unavailable;
  const Title = closeControl ? "strong" : "h1";
  return (
    <div className={styles.chat} data-chat-loading="">
      <header className={styles.header}>
        {logo
          ? <Image src={logo} className={styles.logo} alt="" width={36} height={36} loading="eager" unoptimized />
          : <span className={styles.logoPlaceholder} aria-hidden="true" />}
        <Title className={styles.title}>{name}</Title>
        <div className={styles.controls} aria-hidden="true">
          <span className={styles.theme} />
          <span className={styles.menu}>
            <span className={styles.people} /><span className={styles.bars} />
          </span>
        </div>
        {closeControl && <div className={styles.close}>{closeControl}</div>}
      </header>
      <div className={styles.body}>
        {connecting ? (
          <>
            <div className={styles.lines} aria-hidden="true"><i /><i /></div>
            <p role="status">{status ?? (loadingHistory ? "Loading your conversation…" : `Connecting to ${name}…`)}</p>
          </>
        ) : (
          <>
            <p role="alert">This chat could not load.</p>
            {retry && <button type="button" className="button quiet" onClick={retry}>Try again</button>}
            {retryLink && <a className="button quiet" href={href}>Try again</a>}
          </>
        )}
      </div>
      <div className={styles.composer}>
        <textarea aria-label="Message to the support team" disabled rows={1} placeholder={connecting ? "Loading..." : "Chat unavailable"} />
        <button type="button" aria-label="Send" aria-busy={connecting} disabled />
      </div>
    </div>
  );
}
