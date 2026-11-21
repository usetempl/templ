"use client";

import { IconExternalLink, IconShieldLock } from "@tabler/icons-react";
import { customerSupportUrl } from "@/lib/customer-support-url";
import styles from "./customer-encrypted-support.module.css";

/** The isolated client owns message history, device keys and replies. */
export function CustomerEncryptedSupport({
  origin,
  workspace,
  conversation,
  caseSeq,
  name,
  custody = "customer",
  inline = false,
  account,
}: {
  origin: string;
  workspace: string;
  conversation?: string;
  caseSeq?: number;
  name: string;
  custody?: "customer" | "templ-own-support";
  inline?: boolean;
  account?: string;
}) {
  const href = customerSupportUrl(origin, workspace, conversation, caseSeq, custody);
  if (href && inline && custody === "templ-own-support" && conversation && caseSeq && account) {
    const source = new URL(href);
    source.pathname = "/inbox-case";
    const route = new URLSearchParams(source.hash.slice(1));
    route.set("principal", account);
    source.hash = route.toString();
    return (
      <iframe
        className={styles.caseFrame}
        title="Encrypted case conversation"
        src={source.href}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'"
      />
    );
  }
  return (
    <section className={styles.panel} aria-labelledby="encrypted-support-title">
      <IconShieldLock size={24} aria-hidden="true" />
      <h2 id="encrypted-support-title">Encrypted support</h2>
      <p>
        Read and reply on {custody === "templ-own-support" ? "Templ’s" : `${name}’s`} secure support page.
      </p>
      <p className={styles.detail}>
        {custody === "customer"
          ? "Your workspace manages its keys and backups. Templ cannot read or recover these messages."
          : "Templ’s support workspace manages device approval and recovery. Templ AI can read messages when enabled."}
      </p>
      {href ? (
        <a
          className="button"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open secure chat <IconExternalLink size={16} aria-hidden="true" />
        </a>
      ) : (
        <p role="alert">
          The secure support address could not be verified. Contact the team
          through its website.
        </p>
      )}
      <p className={styles.address}>{href ? new URL(href).host : ""}</p>
    </section>
  );
}
