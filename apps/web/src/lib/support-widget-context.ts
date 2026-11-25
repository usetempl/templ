/** Ordinary messages offer network, transaction and note details. Captured failures retain their separate, selected app context. */
import type { SupportContextInput } from "@templ/chat/support";
import type { CardHost, CardRules, ContextCard } from "./support-widget";
import type { FailureRow } from "./support-widget-snapshot";
declare const __TEMPL_WIDGET_DETAILS__: string | undefined;
declare const __TEMPL_WIDGET_APP_PARSER__: string | undefined;
declare const __TEMPL_WIDGET_DIAGNOSTICS__: string | undefined;
const parser = (): Promise<typeof import("@templ/chat/support-app-context")> =>
  typeof __TEMPL_WIDGET_APP_PARSER__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_APP_PARSER__,
          import.meta.url,
        ).href
      )
    : import("@templ/chat/support-app-context");
const diagnostics = (): Promise<
  typeof import("./support-widget-diagnostics")
> =>
  typeof __TEMPL_WIDGET_DIAGNOSTICS__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_DIAGNOSTICS__,
          import.meta.url,
        ).href
      )
    : import("./support-widget-diagnostics");
const loadDetails = (): Promise<typeof import("./support-widget-details")> =>
  typeof __TEMPL_WIDGET_DETAILS__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_DETAILS__,
          import.meta.url,
        ).href
      )
    : import("./support-widget-details");

/* The card's chunk, named at build time, with the network rules it uses.
 * Next and test bundles build the card from the widget source. */
declare const __TEMPL_WIDGET_CARD__: string | undefined;
type CardModule = {
  card(widget: CardHost): ContextCard;
  rules: CardRules;
};
let loading: Promise<CardModule> | undefined;
/** One load at a time; a failed one is tried again by the next card. */
const loadCard = () =>
  (loading ??= (
    typeof __TEMPL_WIDGET_CARD__ == "string"
      ? (import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */
          new globalThis.URL(__TEMPL_WIDGET_CARD__, import.meta.url).href
        ) as Promise<CardModule>)
      : Promise.all([
          import("./support-widget"),
          import("@templ/chat/support-context"),
        ]).then(([widget, rules]) => ({
          card: (host: CardHost) => widget.contextCard(host, rules),
          rules,
        }))
  ).catch((reason) => {
    loading = undefined;
    throw reason;
  }));

export async function details() {
  const [loaded, helpers, parsing, diagnostic] = await Promise.all([
    loadCard(),
    loadDetails(),
    parser(),
    diagnostics(),
  ]);
  return {
    ...helpers,
    parseAppContext: parsing.parseAppContext,
    diagnostics: diagnostic.diagnostics,
    allowDiagnostics: diagnostic.allowed,
    diagnosticPicker: diagnostic.picker,
    diagnosticFields: parsing.SUPPORT_DIAGNOSTIC_FIELDS,
    rules: { ...loaded.rules, isSolanaAddress: helpers.isSolanaAddress },
  };
}

export function failureControls(
  widget: CardHost,
  section: HTMLElement,
  now: HTMLElement,
  inner: ContextCard,
) {
  const { el } = widget;
  widget.style.textContent +=
    ".body:has(.failure-card:not([hidden]))>.starter{display:none}.failure-card{padding:10px 12px}.failure-notice{margin-bottom:10px;padding:10px;border-left:3px solid var(--d);background:var(--db);font-size:13px;line-height:1.4}.failure-notice b{display:block;margin-bottom:4px}.failure-notice p+p{margin-top:4px}.failure-preview{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center}.failure-preview p{margin:0;font-size:13px;line-height:1.4;overflow-wrap:anywhere}.failure-preview code{font-size:12px;color:var(--m)}.failure-preview .muted{font-size:11px}.failure-preview button{grid-column:2;grid-row:1/4;min-height:44px;padding:4px 8px;font-size:12px}.failure-preview[hidden],.failure-review[hidden]{display:none}.failure-head{display:flex;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:6px}.failure-card .muted{margin:0;font-size:12px;color:var(--m)}.failure-entry+.failure-entry{margin-top:12px}.failure-rows{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2px 12px}.failure-card label.row{display:grid;grid-template-columns:16px minmax(0,1fr);gap:0 6px;align-items:start;min-height:26px;padding:3px 0;line-height:1.35;cursor:pointer}.failure-card label.row:hover{background:var(--s2)}.failure-card .row input{grid-column:1;grid-row:1/3;width:16px;height:16px;margin:1px 0}.failure-card .row b,.failure-card .row span{grid-column:2;min-width:0;overflow-wrap:anywhere}.failure-card .row b{font-size:11px;color:var(--m);font-weight:400}.failure-card .row span{font-size:13px}.failure-card .row[data-wide]{grid-column:1/-1}.failure-card .row[data-error]{box-shadow:inset 2px 0 var(--d);padding-left:6px}.failure-card .row[data-transaction] span{font:12px/1.4 var(--mono,monospace)}.failure-card .row .shared{grid-column:1/-1;font-size:12px;color:var(--m)}.failure-tech{font-size:12px;margin-top:8px}.failure-tech summary{cursor:pointer;color:var(--m)}.failure-tech p{margin:6px 0;overflow-wrap:anywhere}.failure-tech b{display:block}.failure-card .full-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.failure-foot{display:flex;align-items:center;gap:8px;margin-top:6px}.failure-foot button{min-height:30px;font-size:13px;padding:4px 8px}@media(max-width:480px){.failure-card label.row{min-height:36px}.failure-foot button{min-height:36px}}";
  function updateNow() {
    let follows = false;
    for (
      let next = now.nextElementSibling;
      next;
      next = next.nextElementSibling
    )
      if (
        next instanceof HTMLElement &&
        !next.hidden &&
        next.classList.contains("card") &&
        next.querySelector(".row")
      )
        follows = true;
    const hidden = section.hidden || !follows;
    if (now.hidden !== hidden) now.hidden = hidden;
  }
  const observer = new MutationObserver(updateNow);
  observer.observe(widget.card.parentElement!, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  let expanded = true;
  let latestCapture: string | undefined;
  let previews: HTMLElement[] = [];
  let reviews: HTMLElement[] = [];
  let triggers: HTMLButtonElement[] = [];
  const hide = el("button", "Hide", "quiet");
  hide.type = "button";
  const updateReview = () => {
    for (const preview of previews) preview.hidden = expanded;
    for (const review of reviews) review.hidden = !expanded;
    for (const trigger of triggers)
      trigger.setAttribute("aria-expanded", String(expanded));
  };
  hide.addEventListener("click", () => {
    expanded = false;
    updateReview();
  });
  const controls = {
    render(
      entries: {
        id: string;
        capturedAt: string;
        failureAt: string;
        rows: FailureRow[];
        changed: boolean;
      }[],
    ) {
      section.replaceChildren();
      if (entries.length) {
        const notice = el("aside", undefined, "failure-notice");
        notice.setAttribute("role", "status");
        notice.append(
          el("b", "Error from the app"),
          el("p", "Choose what to send with your message."),
        );
        section.append(notice);
      }
      previews = [];
      reviews = [];
      triggers = [];
      for (const entry of entries) {
        const group = el("section", undefined, "failure-entry");
        const preview = el("div", undefined, "failure-preview");
        const error = entry.rows.find((row) => row.label === "Error");
        const message = error?.preview;
        preview.append(
          el(
            "p",
            message && message.length <= 160 ? message : "App error details",
          ),
        );
        preview.append(
          el(
            "p",
            entry.rows.some((row) => row.pending)
              ? "Waiting to send"
              : "Details ready. Not sent",
            "muted",
          ),
        );
        const trigger = el("button", "Show details", "quiet");
        trigger.type = "button";
        trigger.addEventListener("click", () => {
          expanded = true;
          updateReview();
        });
        preview.append(trigger);
        const review = el("div", undefined, "failure-review");
        const head = el("div", undefined, "failure-head");
        head.append(el("b", "Include with message"));
        const clear = el("button", "Clear all", "quiet");
        clear.type = "button";
        clear.setAttribute("aria-label", "Clear all failure details");
        clear.addEventListener("click", () => {
          for (const row of entry.rows)
            if (!row.pending && !row.shared) {
              row.checked = false;
              row.unticked = true;
            }
          review
            .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
            .forEach((tick) => {
              tick.checked = false;
            });
          updateSummary();
        });
        head.append(clear);
        review.append(head);
        if (entry.changed)
          review.append(
            el(
              "p",
              "Your wallet or network changed since this failure.",
              "muted",
            ),
          );
        const rows = el("div", undefined, "failure-rows");
        const technical = el("section", undefined, "failure-tech");
        const summary = el("h3");
        technical.append(summary);
        const captured = el("p");
        captured.append(el("b", "Captured at"), el("time", entry.capturedAt));
        technical.append(captured);
        const technicalRows = el("div", undefined, "failure-rows");
        technical.append(technicalRows);
        const primary = [
          "Error",
          "Transaction",
          "Wallet",
          "Network",
          "Action",
          "Product",
          "Amount",
          "Asset",
        ];
        const isPrimary = (row: FailureRow) =>
          primary.includes(row.label) &&
          (row.label !== "Action" || row.value !== "Other") &&
          (!["Error", "Product", "Amount", "Asset"].includes(row.label) ||
            !!row.preview);
        const updateSummary = () => {
          const included = entry.rows.filter(
            (row) =>
              !row.shared && !row.pending && row.checked && !isPrimary(row),
          ).length;
          summary.textContent = included
            ? `More details (${included} included)`
            : "More details";
        };
        updateSummary();
        const rank = (row: FailureRow) =>
          primary.includes(row.label)
            ? primary.indexOf(row.label)
            : primary.length;
        for (const row of entry.rows
          .filter((row) => !row.shared)
          .sort((a, b) => rank(a) - rank(b))) {
          const label = el("label", undefined, "row");
          if (row.label === "Error") label.dataset.error = "";
          if (row.label === "Transaction") label.dataset.transaction = "";
          if (row.pending)
            label.append(el("span", "Waiting to send", "shared"));
          else {
            const tick = el("input");
            tick.type = "checkbox";
            tick.checked = !!row.checked;
            tick.setAttribute(
              "aria-label",
              `Share failure ${row.label}: ${row.value}`,
            );
            tick.addEventListener("change", () => {
              row.checked = tick.checked;
              row.unticked = !tick.checked;
              updateSummary();
            });
            label.append(tick);
          }
          const main = isPrimary(row);
          const preview =
            row.label === "Transaction" || row.label === "Wallet"
              ? row.value.replace(
                  /0x[0-9a-fA-F]{40,64}|[1-9A-HJ-NP-Za-km-z]{32,88}/g,
                  (value) => `${value.slice(0, 8)}…${value.slice(-6)}`,
                )
              : ((main ? row.preview : undefined) ?? row.value);
          if (preview.length > 24) label.dataset.wide = "";
          label.append(el("b", row.label), el("span", preview));
          if (main) {
            rows.append(label);
            if (preview !== row.value) {
              const exact = el("p");
              exact.append(el("b", row.label), el("span", row.value));
              technical.append(exact);
            }
          } else technicalRows.append(label);
        }
        review.append(rows, technical);
        group.append(preview, review);
        previews.push(preview);
        reviews.push(review);
        triggers.push(trigger);
        section.append(group);
      }
      if (entries.length) {
        const foot = el("div", undefined, "failure-foot failure-review");
        foot.append(hide);
        reviews.push(foot);
        section.append(foot);
      }
      if (entries[0] && entries[0].id !== latestCapture) {
        latestCapture = entries[0].id;
        expanded = true;
      }
      updateReview();
      updateNow();
    },
    card: {
      destroy() {
        observer.disconnect();
        inner.destroy?.();
      },
      set(next?: SupportContextInput) {
        inner.set(next);
        updateNow();
      },
      typed() {
        inner.typed();
        updateNow();
      },
    },
  };
  return controls;
}

/** @public Ordinary messages offer transaction details without app metadata. */
export async function card(widget: CardHost): Promise<ContextCard> {
  const { rules, parseAppContext, diagnosticPicker } = await details();
  const current = (await loadCard()).card(widget);
  const optional = diagnosticPicker(widget);
  return {
    ...current,
    available: optional.available,
    destroy: optional.destroy,
    confirmed: optional.confirmed,
    cancelled: optional.cancelled,
    ticked() {
      const ordinary = current.ticked();
      const diagnostic = optional.ticked();
      return ordinary || diagnostic
        ? { ...ordinary, ...diagnostic }
        : undefined;
    },
    set(next?: SupportContextInput) {
      optional.clear();
      const { app, ...rest } = next ?? {};
      if (app) {
        try {
          parseAppContext(app, rules);
        } catch {
          console.warn("Templ support: ignored invalid app context.");
        }
      }
      current.set(rest);
    },
  };
}
