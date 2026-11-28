/** The member lines under a thread, loaded by the extras once a thread
 * shows:
 *
 * - on every AI answer the transcript shows, earlier pages included:
 *   Report this answer, a small warning triangle, while the workspace's
 *   policy offers it;
 * - above the lines: the sources of the AI agent's newest reply (titles,
 *   and links only to sites the team listed);
 * - below them: how long the team usually takes to reply, the team's
 *   follow-up line, reply email for a signed member, and the details the
 *   member shared, each with Remove.
 *
 * Every read is the member's own, through the widget session, and is made
 * once per thread and message; failed reads retry on the next render. Nothing here
 * can sign, pay or send a transaction. */
import type { SupportContextTarget } from "@templ/chat/support-context";
import type { SupportAppContext } from "@templ/chat/support-app-context";
import type {
  SupportFailureSnapshot,
  SupportNetwork,
} from "@templ/chat/support";
import { SUPPORT_IDENTITY_LABELS } from "@templ/chat/support-identity";
import type { TailHost, WidgetMessage, WidgetMessages } from "./support-widget";
import { screenshotButton } from "./support-widget-shot";
import { emailLines } from "./support-widget-email-loader";

declare const __TEMPL_WIDGET_CONTEXT__: string | undefined;
const loadContext = (): Promise<typeof import("./support-widget-context")> =>
  typeof __TEMPL_WIDGET_CONTEXT__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_CONTEXT__,
          import.meta.url,
        ).href
      )
    : import("./support-widget-context");
/* Report this answer on each AI answer, loaded only for a workspace whose
 * policy offers it. */
declare const __TEMPL_WIDGET_FLAGS__: string | undefined;
const loadFlags = (): Promise<typeof import("./support-widget-report-flags")> =>
  typeof __TEMPL_WIDGET_FLAGS__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_FLAGS__,
          import.meta.url,
        ).href
      )
    : import("./support-widget-report-flags");

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

type Line = [string, unknown[], (node: HTMLElement) => void];
export type MemberView = {
  messages: WidgetMessage[];
  info: WidgetMessages["conversation"];
  authors: WidgetMessages["authors"];
  thread: string;
  /** The newest message is the member's own. */
  mine: boolean;
  /** The member waits on the team: the line under the newest message says
   * so (not while it only says Received, the team is typing or the request
   * is on hold). */
  waits: boolean;
};
type Source = { title: string; url?: string };
type Shared = {
  snapshots?: SupportFailureSnapshot[];
  description?: string;
  network?: string;
  chainId?: number;
  transactions?: { hash: string; network?: string }[];
  app?: SupportAppContext;
};
/** The wait line's answer is read again after this long. */
const WAIT_REREAD_MS = 10 * 60_000;
const STYLE =
  ".sources{display:flex;flex-wrap:wrap;gap:2px 8px;font-size:12px}.sources a{color:inherit}.shared-tail{align-self:stretch;min-width:0}.shared-list{font-size:12px;text-align:left}.shared-list summary{cursor:pointer}.shared-list .row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;margin-top:12px}.shared-list .row b{grid-column:1/-1}.shared-list .row span{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.shared-list .actions{display:flex;align-items:flex-start;gap:8px}";

/** Answers per host, by key. `undefined` is not read yet; `null` holds nothing. */
const answers = new WeakMap<TailHost, Map<string, unknown>>();

/** Reads `path` once per key and draws again when it lands. */
function read<T>(
  host: TailHost,
  key: string,
  path: string,
  pick: (body: never) => T | Promise<T>,
): T | null | undefined {
  let held = answers.get(host);
  if (!held) answers.set(host, (held = new Map()));
  if (held.has(key)) return held.get(key) as T | null;
  held.set(key, undefined);
  memberCall(host)(path)
    .then((body) => pick(body as never))
    .then(
      (value) => {
        if (answers.get(host) !== held) return;
        held.set(key, value ?? null);
        host.render();
      },
      () => {
        if (answers.get(host) === held) held.delete(key);
      },
    );
  return undefined;
}

/** "5 minutes", "1 hour", "3 days". */
export function waitText(minutes: number) {
  const [count, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 2880
        ? [Math.round(minutes / 60), "hour"]
        : [Math.round(minutes / 1440), "day"];
  return `${count} ${unit}${count == 1 ? "" : "s"}`;
}

type SharedRow = {
  label: string;
  value: string;
  target?: SupportContextTarget;
  hash?: string;
};
/** Each stored detail appears once. Only mutable fields have Remove. */
async function sharedRows(context: Shared): Promise<SharedRow[]> {
  const {
    APP_FIELDS,
    APP_LABELS,
    FAILURE_KIND_LABELS,
    appValue,
    utcTime,
    rules: { supportNetworkName },
  } = await (await loadContext()).details();
  const rows: SharedRow[] = [];
  const add = (
    label: string,
    value: string,
    target?: SupportContextTarget,
    hash?: string,
  ) => rows.push({ label, value, target, hash });
  const appRows = (app: SupportAppContext, removable = false) => {
    for (const field of APP_FIELDS)
      if (app[field] !== undefined)
        add(
          APP_LABELS[field],
          appValue(field, app, FAILURE_KIND_LABELS),
          removable ? { field } : undefined,
        );
  };
  const snapshotHashes = new Set(
    (context.snapshots ?? []).flatMap((snapshot) =>
      (snapshot.transactions ?? []).map((tx) => tx.hash),
    ),
  );
  if (context.network)
    add("Network", supportNetworkName(context.network as SupportNetwork), {
      field: "network",
    });
  for (const tx of context.transactions ?? [])
    if (!snapshotHashes.has(tx.hash))
      add("Transaction", tx.hash, { transaction: tx.hash }, tx.hash);
  if (context.description)
    add("Note", context.description, { field: "description" });
  appRows(context.app ?? {}, true);
  for (const snapshot of context.snapshots ?? []) {
    if (snapshot.wallet.address)
      add(
        "Wallet",
        `${SUPPORT_IDENTITY_LABELS[snapshot.wallet.level]} ${snapshot.wallet.address}${snapshot.wallet.level === "verified" && snapshot.network ? ` on ${supportNetworkName(snapshot.network)}` : ""}`,
      );
    if (snapshot.network) add("Network", supportNetworkName(snapshot.network));
    appRows(snapshot.app ?? {});
    for (const tx of snapshot.transactions ?? [])
      add(
        "Transaction",
        tx.network
          ? `${tx.hash} on ${supportNetworkName(tx.network)}`
          : tx.hash,
        undefined,
        tx.hash,
      );
    if (snapshot.failure) {
      const { kind, at, amount, asset } = snapshot.failure;
      const time = at ? utcTime(at) : "";
      add(
        "Failure",
        [
          FAILURE_KIND_LABELS[kind],
          time && `${time.includes(",") ? "on" : "at"} ${time}`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (amount !== undefined)
        add(
          "Amount",
          [amount, asset?.symbol ?? asset?.address].filter(Boolean).join(" "),
        );
      else if (asset) add("Asset", asset.symbol ?? asset.address ?? "");
    }
    if (snapshot.sdk)
      add("Widget build", `${snapshot.sdk.widget} / ${snapshot.sdk.api}`);
  }
  return rows;
}

/** The triangles' chunk, once a workspace's policy offered reports. */
let flags: typeof import("./support-widget-report-flags") | undefined;
let loadingFlags = false;

export const member = {
  lines(host: TailHost, view: MemberView): [Line[], Line[]] {
    const { el } = host;
    const { messages, info, authors, thread, mine, waits } = view;
    if (!host.style.textContent?.includes(".sources{"))
      host.style.textContent += STYLE;
    // Add screenshot, while the workspace allows it.
    screenshotButton(host, thread);
    // Report this answer, once this render has placed its rows.
    if (flags) queueMicrotask(() => flags!.drawFlags(host, thread));
    else if (host.policy?.answerReports === true && !loadingFlags) {
      loadingFlags = true;
      loadFlags().then(
        (module) => {
          flags = module;
          host.render();
        },
        () => (loadingFlags = false),
      );
    }
    const base = `/conversations/${thread}`;
    const last = messages.at(-1)!;
    const above: Line[] = [];
    const below: Line[] = [];
    const button = (text: string, action: () => Promise<void>) => {
      const node = el("button", text);
      node.type = "button";
      node.addEventListener("click", () => void host.run(action));
      return node;
    };

    // The sources the AI agent's newest reply used.
    if (!mine && last.id && authors?.[last.author]?.badges?.includes("bot")) {
      const cited = read(
        host,
        `s:${thread}:${last.id}`,
        `${base}/workflow?view=sources&messages=${last.id}`,
        (body: {
          sources?: Record<string, Source[]>;
          checks?: Record<string, { id: string; evidence: string[] }[]>;
        }) => body,
      );
      const citedSources = cited?.sources?.[last.id];
      const sources = citedSources && (host.options.reviewSources?.(citedSources, last.text) ?? citedSources);
      const checks = cited?.checks?.[last.id];
      if (sources?.length || checks?.length)
        above.push([
          "~sources",
          [thread, last.id, cited],
          (node) => {
            node.className = "system tail";
            const list = el("div", undefined, "sources");
            if (sources?.length) list.append(el("span", "Sources:"));
            for (const source of sources ?? []) {
              if (source.url) {
                const link = el("a", source.title);
                link.href = source.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer nofollow";
                link.referrerPolicy = "no-referrer";
                list.append(link);
              } else list.append(el("span", source.title));
            }
            if (sources?.length) node.append(list);
            for (const check of checks ?? []) {
              const group = el("div");
              group.dataset.checkId = check.id;
              for (const line of check.evidence) group.append(el("p", line));
              node.append(group);
            }
          },
        ]);
    }

    // The member waits on the team: how long it usually takes, and reply
    // email for a signed member.
    if (waits) {
      const wait = read(
        host,
        `w:${thread}:${Math.floor(Date.now() / WAIT_REREAD_MS)}`,
        `${base}/workflow?view=wait`,
        (body: { wait?: { minutes: number } | null }) => body.wait,
      );
      if (wait)
        below.push([
          "~wait-time",
          [wait.minutes],
          (node) => {
            node.className = "system tail";
            node.append(
              `The team usually replies in about ${waitText(wait.minutes)}.`,
            );
          },
        ]);
    }
    below.push(...emailLines(host, view));

    // The team's follow-up line.
    const followUp = info?.followUp?.text;
    if (followUp)
      below.push([
        "~follow-up",
        [followUp],
        (node) => {
          node.className = "system nudge tail";
          node.append(followUp);
        },
      ]);

    // What the member shared, read again after each of their messages.
    const own = messages.filter((message) => host.own(message.author));
    const sharedKey = `c:${thread}:${own.length}:${own.at(-1)?.id}`;
    const rows =
      read(
        host,
        sharedKey,
        `${base}/workflow?view=context`,
        (body: { context?: Shared | null }) =>
          body.context ? sharedRows(body.context) : [],
      ) ?? [];
    if (rows.length)
      below.push([
        "~shared",
        [thread, rows],
        (node) => {
          node.className = "system tail shared-tail";
          const list = el("section", undefined, "shared-list");
          list.append(el("h3", `Details you shared (${rows.length})`));
          for (const row of rows) {
            const line = el("div", undefined, "row");
            line.append(el("b", row.label), el("span", row.value));
            const actions = el("div", undefined, "actions");
            if (row.hash) {
              const copy = button("Copy", async () => {
                await navigator.clipboard.writeText(row.hash!);
                copy.textContent = "Copied";
              });
              copy.setAttribute("aria-label", "Copy transaction hash");
              actions.append(copy);
            }
            if (row.target) {
              const remove = button("Remove", async () => {
                const answer = (await memberCall(host)(`${base}/workflow`, {
                  action: "context",
                  remove: row.target,
                })) as { context?: Shared };
                const held = new Map<string, unknown>([[sharedKey, undefined]]);
                answers.set(host, held);
                held.set(
                  sharedKey,
                  answer.context
                    ? await sharedRows(answer.context).catch(() => null)
                    : null,
                );
                host.render();
              });
              remove.setAttribute(
                "aria-label",
                `Remove ${row.label}: ${row.value}`,
              );
              actions.append(remove);
            }
            if (actions.childElementCount) line.append(actions);
            list.append(line);
          }
          node.append(list);
        },
      ]);
    return [above, below];
  },
};
export type MemberLines = typeof member;
