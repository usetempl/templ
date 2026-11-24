/** Message links, team join lines, the key warning and action-result consent.
 * The consent chunk loads these helpers when a message or draft needs them. */
import { ambiguousHexValues } from "@templ/chat/support-safety-hex";
import type { SupportClient, TailHost } from "./support-widget";
type JoinLine = { at: string; name?: string };
import type { CheckHost } from "./support-widget-check";

export type Outcome = { action: "deposit" | "withdraw" | "swap" | "bridge" | "stake" | "claim" | "other"; status: "completed" | "failed" };
/* The install check's chunk, named at build time. Next and test bundles
 * import it from source. */
declare const __TEMPL_WIDGET_CHECK__: string | undefined;
const loadCheck = (): Promise<typeof import("./support-widget-check")> =>
  typeof __TEMPL_WIDGET_CHECK__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(__TEMPL_WIDGET_CHECK__, import.meta.url).href
      )
    : import("./support-widget-check");
const WARNING = "This could be a private key. If it is, delete it. If it's a transaction hash, share it as a transaction.";
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag); if (text) node.textContent = text; return node;
};

export function ops({ host, form, thread }: { host: TailHost; form: HTMLFormElement; thread(): string | null }) {
  const client = host.client as unknown as SupportClient, draft = host.draft, el = host.el;
  // The widget's own transaction field and the button that shows it.
  const attach = form.querySelector<HTMLElement>(".attach"), tx = attach?.querySelector("input");
  const toggle = attach && form.querySelector<HTMLButtonElement>(`[aria-controls="${attach.id}"]`);
  const note = element("div"); note.setAttribute("role", "status"); note.hidden = true;
  const warning = element("p", WARNING), move = element("button", "Share as a transaction");
  move.type = "button"; note.append(warning, move); form.append(note);
  const fail = (text: string) => { note.hidden = false; warning.textContent = text; move.hidden = true; };
  let values: string[] = [];
  move.onclick = () => void (async () => {
    const value = values[0]; if (!value || !tx || !attach || !toggle) return;
    if (attach.hidden) {
      toggle.click();
      for (let tries = 0; attach.hidden && tries < 60; tries++) await new Promise((done) => setTimeout(done, 50));
      if (attach.hidden) throw new Error("closed");
    }
    tx.value = /^[0-9a-f]{64}$/i.test(value) ? `0x${value}` : value;
    tx.dispatchEvent(new Event("input"));
    draft.value = draft.value.replace(value, "");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    note.hidden = true; draft.focus();
  })().catch(() => fail("The transaction could not be added. Try again."));

  // The consent box shows once the page names the action it may report on.
  let label: HTMLLabelElement | undefined, tick: HTMLInputElement | undefined;
  let scope = client.adopt()[0]?.token, consent: { thread: string; seq: number } | undefined;
  let pending = false, revision = 0, choiceThread: string | null = null;
  const call = <T>(path: string, body?: object) => client.adopt()[1]<T>(path, body);
  const resetConsent = () => { if (tick) tick.checked = false; pending = false; consent = undefined; choiceThread = null; revision++; };
  const unlisten = client.onSessionChange(() => {
    const next = client.adopt()[0]?.token;
    if (scope && next !== scope) resetConsent();
    scope = next;
  });
  async function saveConsent(current: string, allowed: boolean) {
    if (allowed) choiceThread ??= current;
    const attempt = ++revision;
    const result = await call<{ case: number }>(`/conversations/${current}/outcome`, { consent: allowed });
    if (attempt !== revision || thread() !== current || tick?.checked !== allowed) return;
    pending = false; consent = allowed ? { thread: current, seq: result.case } : undefined;
  }
  const consentBox = () => {
    const action = host.offered?.app?.action;
    if (!action || label) return;
    const box = tick = element("input"); box.type = "checkbox";
    label = element("label");
    label.append(box, `Let the team see if this ${action == "other" ? "action" : action} completes`);
    form.append(label);
    box.onchange = () => {
      consent = undefined; pending = box.checked; revision++;
      const current = choiceThread = thread();
      if (current) void saveConsent(current, box.checked).catch(() => { resetConsent(); fail("The choice could not be saved. Choose again to retry."); });
    };
  };
  consentBox();

  const checkHost: CheckHost = {
    client, form, draft,
    offered: () => host.offered,
    thread,
    api: host.api!,
    refresh: () => host.refresh(false),
  };
  if (/^#templ-check=/.test(location.hash) && host.api)
    void loadCheck().then((module) => module.check(checkHost), () => fail("The install check could not load. Start it again from Settings → Chat."));
  return {
    /** Message text stays text. Complete http(s) addresses become links that
     * show their destination; "[label](url)" reads "label: url". */
    linkify(node: HTMLElement, value: string) {
      const text = value.replace(
        /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/gi,
        "$1: $2",
      );
      let end = 0;
      for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"`]+/gi)) {
        let label = match[0].replace(/[.,!?;:]+$/, "");
        for (const pair of ["()", "[]", "{}"])
          while (
            label.endsWith(pair[1]) &&
            label.split(pair[1]).length > label.split(pair[0]).length
          )
            label = label.slice(0, -1);
        let url;
        try {
          url = new URL(label);
        } catch {
          continue;
        }
        if (!url.hostname || url.username || url.password) continue;
        const link = el("a", label);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer nofollow ugc";
        link.referrerPolicy = "no-referrer";
        node.append(text.slice(end, match.index), link);
        end = match.index + label.length;
      }
      node.append(text.slice(end));
    },
    /** One timed line per case a person from the team joined, oldest first. */
    join(
      lines: Record<string, JoinLine>,
      format: Intl.DateTimeFormat,
    ): [string, [string, string | undefined], (node: HTMLElement) => void][] {
      return Object.values(lines)
        .sort((a, b) => (a.at < b.at ? -1 : 1))
        .map((line) => [
          `~joined${line.at}`,
          [line.at, line.name],
          (node) => {
            node.className = "system joined";
            const time = el("time", format.format(new Date(line.at)));
            time.dateTime = line.at;
            node.append(
              el(
                "p",
                line.name
                  ? `${line.name} from the team joined`
                  : "A person from the team joined",
              ),
              time,
            );
          },
        ]);
    },
    /** The page named an action: offer the consent box. */
    context: consentBox,
    beforeSend() {
      values = ambiguousHexValues(draft.value, tx ? ambiguousHexValues(tx.value) : []);
      warning.textContent = WARNING; note.hidden = !values.length;
      move.hidden = !tx || !!toggle?.hidden || values[0]?.startsWith("[") === true;
      return !values.length;
    },
    async outcome(value: Outcome) {
      const current = thread(); if (!current || !tick?.checked) return;
      if (choiceThread && choiceThread !== current) { resetConsent(); return; }
      try {
        if (pending) await saveConsent(current, true);
        if (tick.checked && consent?.thread === current) await call(`/conversations/${current}/outcome`, { ...value, case: consent.seq });
      } catch { resetConsent(); fail("The result could not be shared. Choose again to retry."); }
    },
    destroy() { unlisten(); note.remove(); label?.remove(); },
  };
}
