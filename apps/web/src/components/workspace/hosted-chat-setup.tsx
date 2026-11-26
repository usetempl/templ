"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconArrowUpRight, IconCode } from "@tabler/icons-react";
import { PRODUCT_STARTER_PRICES } from "@templ/chat/plans";
import { formatUsdCents } from "@templ/chat/resolution-copy";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { SITE } from "@/lib/site-environment";
import { ActivityDots, CopyButton, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./hosted-chat-setup.module.css";

type NameHold = { slug: string; expiresAt: number };

export function HostedChatSetup({ context, paid }: { context: WorkspaceContext; paid: boolean }) {
  const { account, room, workspace, id, revision, openPlans, go } = context;
  const confirmed = workspace.hostedName ? workspace.slug : null;
  const managed = new URL(SITE.origin).hostname === "usetempl.com" || new URL(SITE.origin).hostname === "templ.vip";
  const [name, setName] = useState("");
  const [claimed, setClaimed] = useState(confirmed);
  const [hold, setHold] = useState<NameHold | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const saving = useRef(false);
  const slugPath = roomPath(room, "slug");
  const link = claimed ? new URL(`/${claimed}`, SITE.origin).href
    : context.supportUrl ?? new URL(`/help/${id}`, SITE.origin).href;

  // After a confirmed payment or an interrupted checkout, recover the owner's
  // reservation from the catalog. A paid plan can claim a new name without a second checkout.
  useEffect(() => {
    if (claimed || !managed || !account) return;
    const controller = new AbortController();
    async function recover() {
      const { hold: saved } = await communityFetch<{ hold: NameHold | null }>(slugPath, undefined, controller.signal);
      controller.signal.throwIfAborted();
      setHold(saved);
      if (saved) setName(saved.slug);
      if (paid && saved) {
        const result = await chatMutation<{ slug?: string; hostedName?: boolean }>(account, slugPath,
          { slug: saved.slug, hostedName: true }, undefined, controller.signal);
        if (result.slug !== saved.slug || !result.hostedName) throw new Error("Your name could not be confirmed.");
        controller.signal.throwIfAborted();
        setClaimed(result.slug);
        setMessage("Your hosted chat link is ready.");
      }
    }
    void recover().catch(reason => {
      if (!controller.signal.aborted) setMessage(reason instanceof Error ? reason.message : "Your reserved name could not load.");
    });
    return () => controller.abort();
  }, [account, claimed, managed, paid, revision, retry, slugPath]);

  async function chooseName(event: FormEvent) {
    event.preventDefault();
    if (!account || saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      const slug = name.trim().toLowerCase();
      const saved = await chatMutation<NameHold>(account, slugPath, { slug, hostedName: true, reserveOnly: true });
      if (saved.slug !== slug || saved.expiresAt <= Date.now()) throw new Error("The name could not be reserved.");
      setHold(saved);
      if (paid) setRetry(value => value + 1);
      else openPlans("period");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Could not reserve this name. Try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const choosingName = managed && !claimed;
  return (
    <section className={styles.setup} aria-labelledby="hosted-chat-title">
      <header className={styles.intro}>
        <h2 id="hosted-chat-title">{choosingName ? "Choose a hosted name" : "Your support chat"}</h2>
        {choosingName && !paid && <small>From {formatUsdCents(PRODUCT_STARTER_PRICES.workspaceMonthlyUsdCents)}/month</small>}
      </header>
      {choosingName && (
        <form className={styles.nameForm} onSubmit={chooseName}>
          <label htmlFor="trial-hosted-name">Hosted name</label>
          <div className={styles.nameRow}>
            <div className={styles.nameField}>
              <span aria-hidden="true">{new URL(SITE.origin).host}/</span>
              <input id="trial-hosted-name" className={ui.input} value={name} placeholder="your-team"
                onChange={event => setName(event.target.value)} required minLength={3} maxLength={32}
                pattern="[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]" autoCapitalize="none" autoCorrect="off"
                autoComplete="off" spellCheck={false} aria-describedby="hosted-name-terms" />
            </div>
            <button className="button" disabled={busy}>
              {busy && <ActivityDots />}
              {busy ? "Checking availability…" : paid ? "Claim name" : "Reserve name and choose a plan"}
            </button>
          </div>
          <p id="hosted-name-terms">{paid ? "Your plan includes a hosted name." : "Choose a plan and pay in USDC."}</p>
          {hold && <p>We reserved /{hold.slug} until {new Date(hold.expiresAt).toLocaleString()}.</p>}
        </form>
      )}
      {message && <p role="status" className={styles.notice}>{message}</p>}
      <div className={styles.options}>
        <div className={styles.chatActions}>
          <a className="button secondary" href={link} target="_blank" rel="noopener noreferrer">
            Open chat <IconArrowUpRight aria-hidden="true" />
          </a>
          <CopyButton value={link} label="Copy chat link" />
          <button type="button" className="button secondary" onClick={() => go("inbox")}>Open inbox</button>
        </div>
        <button type="button" className={styles.widgetLink} onClick={() => go("widget")}>
          <IconCode aria-hidden="true" /> Add the chat to your site
        </button>
      </div>
    </section>
  );
}
