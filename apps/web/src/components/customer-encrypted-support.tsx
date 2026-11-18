"use client";

import { IconExternalLink, IconShieldLock } from "@tabler/icons-react";
import { customerSupportUrl } from "@/lib/customer-support-url";
import styles from "./customer-encrypted-support.module.css";

/** A navigation boundary, never a plaintext frame bridge or a key client. */
export function CustomerEncryptedSupport({
  origin,
  workspace,
  conversation,
  caseSeq,
  name,
  custody = "customer",
}: {
  origin: string;
  workspace: string;
  conversation?: string;
  caseSeq?: number;
  name: string;
  custody?: "customer" | "templ-own-support";
}) {
  const href = customerSupportUrl(origin, workspace, conversation, caseSeq, custody);
  return (
    <section className={styles.panel} aria-labelledby="encrypted-support-title">
      <IconShieldLock size={24} aria-hidden="true" />
      <h2 id="encrypted-support-title">Encrypted support</h2>
      <p>
        {custody === "templ-own-support" ? "Templ" : name} keeps the keys for this chat. Write and read messages on its
        secure support page.
      </p>
      <p className={styles.detail}>
        {custody === "customer"
          ? "Templ cannot read or recover these messages. Recovery is handled by the team."
          : "Templ's support team and security and recovery service can read this chat. Templ AI can read messages shared with it."}
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
