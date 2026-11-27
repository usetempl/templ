/** Report this answer on every AI answer the transcript shows, earlier
 * pages included: a small warning triangle in the answer's own row. The
 * member lines load this chunk only for a workspace whose policy offers
 * reports, and it loads the dialog on the first report.
 *
 * This is the support case itself: a signed member's or a widget guest's
 * own thread in the room, where each row keeps its server message ID. A
 * preview's practice transport keeps those reports in its own receipt. The
 * service says which answers this member may report, at most 20 per read
 * and once per answer, and it checks the message, its case, the member and
 * the workspace again on every report. Rows by the member, by people on
 * the team and the chat's own lines get no triangle. Nothing here can
 * sign, pay or send a transaction. */
import type { TailHost } from "./support-widget";
import { ANSWER_REPORT_ICON } from "./answer-report-icon";

declare const __TEMPL_WIDGET_REPORT__: string | undefined;
const loadDialog = (): Promise<typeof import("./answer-report-dialog")> =>
  typeof __TEMPL_WIDGET_REPORT__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_REPORT__,
          import.meta.url,
        ).href
      )
    : import("./answer-report-dialog");

/** The member's own call to the widget service. */
const memberCall = (host: TailHost) =>
  (
    host.client as unknown as {
      adopt(): readonly [
        unknown,
        (path: string, body?: object) => Promise<unknown>,
      ];
    }
  ).adopt()[1];

const STYLE =
  ".flag{position:relative;float:right;display:grid;place-items:center;width:24px;height:24px;margin:-2px -6px -6px 4px;border-radius:6px;color:var(--f)}.flag svg{width:14px;height:14px}.flag:is(:hover,:focus-visible){color:var(--t);background:var(--s)}.flag[aria-disabled=true]{color:var(--b2);background:none;cursor:default}.flag:is(:hover,:focus-visible)::after{content:attr(data-tip);position:absolute;right:0;bottom:calc(100% + 4px);padding:2px 8px;border:1px solid var(--b);border-radius:8px;background:var(--bg);color:var(--t);font-size:12px;font-weight:600;line-height:1.5;white-space:nowrap;pointer-events:none}";
const REPORTED = "You reported this answer";
/** The service's own words when it refuses a report. */
const REFUSALS: Record<string, string> = {
  "report-unavailable": "This answer can't be reported.",
  "report-limit": "This case has too many reported answers.",
  "report-reason": "Use up to 280 characters of plain text.",
};
type Flag = {
  button: HTMLButtonElement;
  /** Unread, being read, or the service's answer; null when this member
   * can't report the answer. */
  state?: "reading" | "available" | "reported" | null;
};
type Flags = {
  /** The member and thread the states belong to. */
  scope: string;
  thread: string;
  rows: Map<string, Flag>;
  queue: string[];
  reading?: boolean;
  privatePreview?: boolean;
};
const flags = new WeakMap<TailHost, Flags>();

/** The shared icon as nodes: pages with Trusted Types refuse markup. */
function icon() {
  let svg: Element | undefined;
  for (const [, tag, attributes] of ANSWER_REPORT_ICON.matchAll(
    /<(\w+)([^>]*)>/g,
  )) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g))
      if (name != "xmlns") node.setAttribute(name, value);
    if (svg) svg.append(node);
    else svg = node;
  }
  return svg!;
}

/** The label stays "Report this answer"; a reported answer's triangle is
 * disabled and says so in its description and its tip. */
function show(flag: Flag, state: Flag["state"]) {
  const { button } = flag;
  const reported = state == "reported";
  flag.state = state;
  button.hidden = !reported && state != "available";
  button.dataset.tip = reported ? REPORTED : "Report this answer";
  if (reported) {
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("aria-description", REPORTED);
  } else {
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-description");
  }
}

/** One answer's triangle. It opens the dialog while the service says this
 * member may report the answer; the dialog keeps focus until it closes and
 * then returns it here. */
function newFlag(host: TailHost, held: Flags, id: string): Flag {
  const button = host.el("button", undefined, "flag");
  const flag: Flag = { button };
  button.type = "button";
  button.setAttribute("aria-label", "Report this answer");
  // The chat log announces messages; focus announces this control.
  button.setAttribute("aria-live", "off");
  button.append(icon());
  show(flag, undefined);
  button.addEventListener("click", () => {
    if (flag.state != "available" || flags.get(host) != held) return;
    void host.run(async () => {
      (await loadDialog()).openAnswerReportDialog(button, async (reason) => {
        try {
          await memberCall(host)(`/conversations/${held.thread}/workflow`, {
            action: "report-answer",
            message: id,
            ...(reason.trim() ? { reason } : {}),
          });
        } catch (error) {
          const why = (error as { reason?: string } | null)?.reason ?? "";
          throw Object.assign(
            new Error(REFUSALS[why] ?? host.errorText(error)),
            { reason: why },
          );
        }
        if (flags.get(host) == held) show(flag, "reported");
      }, held.privatePreview);
    });
  });
  return flag;
}

/** Reads the queued answers' states, 20 at a time, the service's limit. An
 * unread answer is asked about again on the next render. */
async function read(host: TailHost, held: Flags) {
  held.reading = true;
  while (held.queue.length && flags.get(host) == held) {
    const ids = held.queue.splice(0, 20);
    let reports: Record<string, string> | undefined;
    let answered = true;
    try {
      const response = (await memberCall(host)(
          `/conversations/${held.thread}/workflow?view=reports&messages=${ids.join(",")}`,
        )) as { reports?: Record<string, string>; privatePreview?: boolean };
      reports = response.reports;
      held.privatePreview = response.privatePreview === true;
    } catch {
      answered = false;
    }
    for (const id of ids) {
      const state = reports?.[id];
      show(
        held.rows.get(id)!,
        !answered
          ? undefined
          : state == "available" || state == "reported"
            ? state
            : null,
      );
    }
  }
  held.reading = false;
}

/** Puts each AI answer's triangle in its row after a render, which may have
 * redrawn the row without it. With reports off, no session or an encrypted
 * case, the triangles go and nothing is read. */
export function drawFlags(host: TailHost, thread: string) {
  if (host.lifetime?.aborted) return;
  let held = flags.get(host);
  if (
    host.policy?.answerReports !== true ||
    !host.client.session ||
    host.walletCase?.()?.encryption
  ) {
    for (const flag of held?.rows.values() ?? []) flag.button.remove();
    flags.delete(host);
    return;
  }
  if (!host.style.textContent?.includes(".flag{"))
    host.style.textContent += STYLE;
  // Another member or thread reads every answer again.
  const scope = `${host.client.session.principalId} ${thread}`;
  if (held?.scope != scope) {
    for (const flag of held?.rows.values() ?? []) flag.button.remove();
    flags.set(host, (held = { scope, thread, rows: new Map(), queue: [] }));
  }
  const root = host.draft.getRootNode() as ParentNode;
  for (const row of root.querySelectorAll<HTMLElement>(
    ".messages>.message[data-assistant][data-message-id]",
  )) {
    const id = row.dataset.messageId!;
    if (!/^[1-9][0-9]{0,14}$/.test(id)) continue;
    let flag = held.rows.get(id);
    if (!flag) held.rows.set(id, (flag = newFlag(host, held, id)));
    if (flag.button.parentElement != row) {
      const time = row.querySelector("time");
      row.insertBefore(flag.button, time?.parentElement == row ? time : null);
    }
    if (flag.state === undefined) {
      flag.state = "reading";
      held.queue.push(id);
    }
  }
  if (held.queue.length && !held.reading) void read(host, held);
}
