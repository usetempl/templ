/** The member sees shared details before a send opens or adds to a case.
 * The chunk also draws the empty chat's help note and the lines that say
 * a person from the team joined. */
import type { SupportSelectedWallet, TailHost } from "./support-widget";
// The key warning, outcome consent and install check.
// They load in their own chunk, only when a page or a draft needs them.
import type { Outcome } from "./support-widget-ops";
declare const __TEMPL_WIDGET_OPS__: string | undefined;
const loadOps = (): Promise<typeof import("./support-widget-ops")> =>
  typeof __TEMPL_WIDGET_OPS__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(__TEMPL_WIDGET_OPS__, import.meta.url).href
      )
    : import("./support-widget-ops");

type JoinLine = { at: string; name?: string };
export type ReviewResult = "shown" | "sent" | "busy" | "cancelled";
export const leadStyles =
  ".lead-content .primary{width:100%}.lead-content input{width:100%;padding:8px;border:1px solid var(--b2);border-radius:var(--rc);background:var(--s);color:var(--t);font:inherit}.lead-content label{display:grid;gap:5px;font-size:13px}.lead-content p{color:var(--m);font-size:15px}.starter>.quiet{display:none}.tail[data-state=hatch]>button:first-child{display:none}@media(max-width:480px){.stamp-state{display:none!important}.head{padding:9px 12px;gap:8px}.avatar{width:30px;height:30px;border-radius:9px}.body{padding:10px 12px}.form{padding:7px 10px}.starter{padding:9px}.starter>.suggestions{display:none}.suggestions{margin-top:8px;gap:5px}.suggestions button{padding:4px 9px;min-height:28px;font-size:13px}.tools{display:flex}.lead-sheet{padding:12px}}";

export function consent(
  host: TailHost,
  form: HTMLFormElement,
  starter: HTMLElement,
  state: () => { conversation: string | null; state?: string },
) {
  const { el, client, draft } = host;
  const summary = el("section", undefined, "consent card nudge");
  host.style.textContent +=
    ".joined{text-align:center}.consent{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;margin:8px;padding:16px;font-size:15px;line-height:1.5;border:1px solid var(--b);border-radius:var(--rc);background:var(--s)}.consent .summary-rows{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.consent>b,.consent>button{flex:none}.panel:has(.consent:not([hidden]))>.body{display:none}.consent .row{flex-wrap:wrap}.consent p{margin:10px 0;overflow-wrap:anywhere}.consent .said{white-space:pre-wrap;max-height:9em;overflow:auto}.consent>label{display:flex;gap:8px;align-items:start}.consent .primary{width:100%}.consent .quiet{display:block;margin:8px auto 0}";
  summary.setAttribute("aria-label", "The team will see");
  summary.hidden = true;
  form.before(summary);
  const help = el(
    "p",
    "Replies appear here. The support team and any AI it adds can read your messages and shared details. Templ stores this chat.",
    "muted chat-help",
  );
  const helpText = help.textContent;
  starter.append(help);
  let showing = false,
    reading = false,
    revision = 0;
  let cancelled: (() => void) | undefined;
  const privacy = (parent: HTMLElement) => {
    const notice = client.dataNotice?.();
    if (!notice) return false;
    const line = el(
      "p",
      "Templ keeps a copy of finished cases to improve answers. It removes wallets, contacts and the names it finds. ",
    );
    const link = el("a", "Privacy");
    link.href = notice.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    line.className = "safety";
    line.append(link);
    parent.append(line);
    return true;
  };
  const short = (address: string) =>
    `${address.slice(0, 6)}…${address.slice(-4)}`;
  const included = el("section", undefined, "send-consent safety");
  const walletSlot = el("div");
  const copy = el("div");
  included.append(walletSlot, copy);
  form.prepend(included);
  let offeredWallet: SupportSelectedWallet | undefined;
  let walletTick: HTMLInputElement | undefined;
  const updateIncluded = () => {
    copy.replaceChildren();
    privacy(copy);
    included.hidden = !copy.childNodes.length && !walletSlot.childNodes.length;
  };
  const offerWallet = (wallet?: SupportSelectedWallet) => {
    offeredWallet = wallet;
    walletTick = undefined;
    walletSlot.replaceChildren();
    const session = client.session;
    if (
      wallet &&
      session?.level !== "signed" &&
      wallet.address !== session?.address
    ) {
      const label = el("label");
      walletTick = el("input");
      walletTick.type = "checkbox";
      walletTick.checked = walletTick.disabled =
        host.policy?.minimumLevel === "connected";
      label.append(
        "Share: ",
        walletTick,
        el("span", `Wallet ${short(wallet.address)} (not verified)`),
      );
      walletSlot.append(label);
    }
    updateIncluded();
  };
  // Reading the page's wallet is passive. Sharing still needs its visible tick.
  let walletReadRevision: number | undefined;
  const warm = () => {
    if (client.session?.level === "signed" || walletReadRevision === revision)
      return;
    const current = (walletReadRevision = revision);
    void client
      .reportedWallet?.()
      .then((wallet) => {
        if (current === revision) offerWallet(wallet);
      })
      .catch(() => {});
  };
  updateIncluded();
  warm();
  draft.addEventListener("input", warm);
  const step = (event: string) =>
    form.dispatchEvent(
      new CustomEvent("templ:widget-step", { detail: { event } }),
    );
  const pickedInputs = () =>
    [
      ...(host.choices ?? form).querySelectorAll<HTMLInputElement>(
        '.card input[type="checkbox"]',
      ),
    ].filter((box) => box.checked);
  const pickedRows = (inputs: HTMLInputElement[]) =>
    inputs
      .map((box) => box.closest("label")!)
      .map((row) => [
        row.querySelector("b")?.textContent ?? "",
        row.querySelector("span")?.textContent ?? "",
      ]);
  const close = (cancel = true) => {
    const notify = cancelled;
    cancelled = undefined;
    revision++;
    showing = reading = false;
    summary.hidden = true;
    form.style.removeProperty("display");
    starter.style.removeProperty("display");
    draft.focus();
    if (cancel) notify?.();
  };
  client.onSessionChange(() => {
    close();
    offerWallet();
    warm();
  });
  // Message formatting, a page action or a key-like draft loads these helpers.
  let loadingOps:
    | Promise<ReturnType<typeof import("./support-widget-ops").ops>>
    | undefined;
  let loadedOps:
    | ReturnType<typeof import("./support-widget-ops").ops>
    | undefined;
  const ops = () =>
    (loadingOps ??= loadOps().then(
      (module) =>
        (loadedOps = module.ops({
          host,
          form,
          thread: () => state().conversation,
        })),
      (reason) => {
        loadingOps = undefined;
        throw reason;
      },
    ));
  const opsNeeded = () =>
    !!host.offered?.app?.action || /^#templ-check=/.test(location.hash);
  if (opsNeeded()) void ops().catch(() => {});
  return {
    // The page reports an action's result.
    // Nothing is recorded unless the user ticked the consent box.
    outcome: (value: Outcome) =>
      ops().then((current) => current.outcome(value)),
    get linksReady() {
      return !!loadedOps;
    },
    linkify(node: HTMLElement, value: string) {
      if (loadedOps) loadedOps.linkify(node, value);
      else {
        node.append(value);
        void ops().then(
          () => host.render(),
          () => {},
        );
      }
    },
    join(lines: Record<string, JoinLine>, format: Intl.DateTimeFormat) {
      return loadedOps?.join(lines, format) ?? [];
    },
    empty(show: boolean) {
      const compact = host.options.chatFirst && host.policy?.chatFirst;
      help.textContent = compact
        ? "The team and any AI it adds can read this chat. Templ stores it."
        : helpText;
      help.style.fontSize = compact ? "12px" : "";
      updateIncluded();
      // A page action named after load.
      // The consent box shows once the page names the action.
      if (opsNeeded())
        void ops().then(
          (current) => current.context(),
          () => {},
        );
      help.hidden = !show;
    },
    async send(
      text: string,
      send: (wallet?: SupportSelectedWallet) => void,
    ): Promise<ReviewResult> {
      if (showing || reading) return "busy";
      reading = true;
      const current = revision;
      const session = client.session;
      const inputs = pickedInputs();
      const rows = JSON.stringify(pickedRows(inputs));
      const selected = walletTick?.checked ? offeredWallet : undefined;
      const told = !!copy.childNodes.length;
      try {
        if (/[a-z0-9]{64}|\[/i.test(text)) {
          const currentOps = await ops();
          if (!currentOps.beforeSend()) return "cancelled";
        }
        if (selected) {
          const wallet = await client.reportedWallet?.();
          if (JSON.stringify(wallet) !== JSON.stringify(selected)) {
            if (current === revision) offerWallet(wallet);
            return "cancelled";
          }
        }
        if (
          current !== revision ||
          session?.principalId !== client.session?.principalId ||
          draft.value.trim() !== text ||
          rows !== JSON.stringify(pickedRows(pickedInputs())) ||
          selected !== (walletTick?.checked ? offeredWallet : undefined)
        )
          return "cancelled";
        if (
          host.policy?.minimumLevel === "connected" &&
          session?.level !== "signed" &&
          session?.level !== "connected" &&
          !selected &&
          !session
        )
          return "cancelled";
        step("widget_send_clicked");
        if (told) client.dataNotice?.(true);
        send(selected);
        return "sent";
      } finally {
        if (current === revision) reading = false;
      }
    },
    async review(
      text: string,
      send: (wallet?: SupportSelectedWallet) => void,
      details?: { rows: [string, string][]; edit(): void; cancel?(): void },
    ): Promise<ReviewResult> {
      if (showing || reading) return "busy";
      reading = true;
      const currentReview = ++revision;
      cancelled = details?.cancel;
      try {
        // A key-like value waits for the warning.
        // Deleting it or sharing it as a transaction lets the send go on.
        if (/[a-z0-9]{64}|\[/i.test(text)) {
          const current = await ops();
          if (currentReview !== revision || !current.beforeSend())
            return "cancelled";
        }
        if (currentReview !== revision) return "cancelled";
        const inputs = details ? [] : pickedInputs();
        const picked = pickedRows(inputs);
        if (
          !picked.length &&
          !details &&
          !client.dataNotice?.() &&
          (host.policy?.minimumLevel !== "connected" ||
            client.session?.level === "connected" ||
            client.session?.level === "signed")
        ) {
          send();
          return "sent";
        }
        const session = client.session;
        const read =
          session?.level === "signed" ? undefined : client.reportedWallet?.();
        // A slow wallet doesn't hold the summary; its row joins when read.
        let wallet = await Promise.race([
          read,
          new Promise<undefined>((done) => setTimeout(done, 800)),
        ]);
        // A wallet change requires a fresh review for the current session.
        if (
          currentReview !== revision ||
          client.session?.principalId !== session?.principalId ||
          (!details && draft.value.trim() !== text)
        )
          return "cancelled";
        summary.replaceChildren(el("b", "The team will see"));
        summary.classList.toggle("lead-review", !!details);
        const rows = el(
          "div",
          undefined,
          details ? "summary-rows lead-summary-rows" : "summary-rows",
        );
        summary.append(rows);
        const row = (label: string, value: string, status?: string) => {
          const line = el("p");
          line.append(el("b", label), document.createTextNode(` ${value}`));
          if (status) line.append(" ", el("span", status, "tag"));
          rows.append(line);
          return line;
        };
        row("Your message", text).className = "said";
        for (const [label, value] of details?.rows ?? []) row(label, value);
        const shared = session?.level === "connected" ? session.address : "";
        const needed = host.policy?.minimumLevel === "connected" && !shared;
        if (session?.level === "signed")
          row("Your wallet", short(session.address), "Verified");
        else if (shared)
          row("Wallet you shared", short(shared), "Not verified");
        const slot = el("div");
        rows.append(slot);
        let tick: HTMLInputElement | undefined;
        const offer = (reported?: SupportSelectedWallet) => {
          wallet = reported;
          if (!reported || reported.address === shared) return;
          const label = el("label", undefined, "row");
          tick = el("input");
          tick.type = "checkbox";
          tick.checked = tick.disabled = needed;
          label.append(
            "Share: ",
            tick,
            el("span", `Wallet ${short(reported.address)}`),
            " ",
            el("span", "Not verified", "tag"),
          );
          slot.append(label);
          if (needed)
            slot.append(
              el("p", "This team needs this wallet to answer.", "muted"),
            );
        };
        offer(wallet);
        if (picked.length) {
          const names = [
            ...new Set(
              picked.map(([label]) =>
                label === "Widget build" ? "App information" : label,
              ),
            ),
          ];
          row("Details included", names.join(", "));
          const full = el("details");
          full.append(el("summary", "View details"));
          rows.append(full);
          for (const [label, value] of picked) full.append(row(label, value));
        }
        const told = privacy(rows);
        const submit = el("button", "Send", "primary");
        submit.type = "button";
        if (read && !wallet) {
          // Where this team needs the wallet, Send waits for the read.
          submit.disabled = needed;
          void read.then((late) => {
            if (showing && summary.contains(submit)) {
              offer(late);
              submit.disabled = false;
            }
          });
        }
        submit.addEventListener("click", () => {
          if (!showing || currentReview !== revision) return;
          if (!details && draft.value.trim() !== text) {
            close(false);
            return;
          }
          const current = details ? [] : pickedInputs();
          if (
            inputs.length !== current.length ||
            JSON.stringify(picked) !== JSON.stringify(pickedRows(current))
          ) {
            close();
            void this.review(draft.value.trim(), send, details);
            return;
          }
          const approved = tick?.checked ? wallet : undefined;
          step("widget_summary_sent");
          close(false);
          if (told) client.dataNotice?.(true);
          send(approved);
        });
        const edit = el("button", "Edit", "quiet");
        edit.type = "button";
        edit.addEventListener("click", () => {
          if (!showing || currentReview !== revision) return;
          step("widget_summary_edited");
          close(false);
          details?.edit();
        });
        summary.append(submit, edit);
        step("widget_summary_opened");
        showing = true;
        summary.hidden = false;
        form.style.display = starter.style.display = "none";
        submit.focus();
        return "shown";
      } finally {
        if (currentReview === revision) {
          reading = false;
          if (!showing) cancelled = undefined;
        }
      }
    },
  };
}
