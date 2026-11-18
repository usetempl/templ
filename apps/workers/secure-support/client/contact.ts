import {object, opaqueId, parseCase, type E2eeCase} from "@templ/e2ee/protocol";
import {parseSupportLeadInput} from "@templ/chat/support-lead";

type Choice = {v: 1; clientId: string; email: string; phase: "reviewed" | "bound" | "saved";
  messageId?: string; scope?: E2eeCase; expectedRevision?: number};
type Store = {draft(): Promise<unknown>; saveDraft(value: unknown): Promise<void>; close(): void};
type Options = {store: Store; active(): boolean; request<T>(path: string, body?: object): Promise<T>;
  scope?(): E2eeCase | undefined; status: HTMLElement; prepare(text: string, append?: boolean): Promise<boolean | undefined>};
function checked(value: unknown): Choice | undefined {
  if (value === undefined || value === null) return;
  const row = object(value, ["v", "clientId", "email", "phase"], ["messageId", "scope", "expectedRevision"]);
  const email = parseSupportLeadInput({kind: "email", email: row.email});
  if (row.v !== 1 || email.kind !== "email" || !["reviewed", "bound", "saved"].includes(String(row.phase))) throw new Error("Review your email again.");
  opaqueId(row.clientId);
  if (row.messageId !== undefined) opaqueId(row.messageId);
  if (row.scope !== undefined) parseCase(row.scope);
  if (row.expectedRevision !== undefined && (!Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0)) throw new Error("Review your email again.");
  return row as Choice;
}
/** Contact has its own encrypted local draft and idempotent metadata request.
 * It never enters an encrypted message, AI prompt, parent frame or export. */
export function ownContactChoice(options: Options) {
  let selected: Choice | undefined, approved = false, busy = false, reviewing: Promise<void> | undefined, viewRevision = 0, confirming = false;
  const loaded = options.store.draft().then(value => {if (options.active()) selected = checked(value);}).catch(() => {
    if (options.active()) options.status.textContent = "Your saved email request could not load. Review your email again.";
  });
  const status = (text: string) => {if (options.active()) options.status.textContent = text;};
  const persist = async () => {await options.store.saveDraft(selected ?? null);};
  async function submit() {
    if (busy || !options.active() || selected?.phase !== "bound" || !selected.scope || !selected.messageId) return;
    busy = true;
    const sending = selected, path = `/conversations/${sending.scope!.conversation}/encryption/${sending.scope!.caseSeq}/contact`;
    status("Your message is sent. Saving your contact email…");
    try {
      if (sending.expectedRevision === undefined) {
        const state = await options.request<{revision: number; writable?: boolean}>(path);
        if (!options.active() || selected !== sending) return;
        if (state.writable === false || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error();
        sending.expectedRevision = state.revision; await persist();
      }
      if (!options.active() || selected !== sending) return;
      const saved = await options.request<{saved: boolean; revision: number}>(path, {email: sending.email, clientId: sending.clientId,
        messageId: sending.messageId, expectedRevision: sending.expectedRevision, confirmed: true});
      if (!options.active() || selected !== sending) return;
      if (saved.saved !== true || saved.revision !== sending.expectedRevision! + 1) throw new Error();
      sending.phase = "saved"; approved = false; await persist();
      status("Email shared with the support team.");
    } catch {status("Your email is not confirmed. Open Notify me to retry the email without resending your message.");}
    finally {busy = false;}
  }
  return {
    async review(box: HTMLElement, close: () => void) {
      const view = ++viewRevision;
      await loaded; if (!options.active() || view !== viewRevision) return;
      box.replaceChildren();
      const heading = document.createElement("strong"), cancel = document.createElement("button"), text = document.createElement("p");
      heading.textContent = "Email follow-up"; cancel.type = "button"; cancel.textContent = "Cancel"; cancel.onclick = () => {viewRevision++; if (confirming) approved = false; close();};
      text.textContent = "Templ stores this optional contact email separately from the encrypted chat. Only the support team can read it; it stays out of AI, bots and chat exports.";
      box.append(heading, cancel, text);
      const scope = options.scope?.();
      if (scope) {
        const result = document.createElement("p"); result.textContent = "Checking contact updates…"; result.setAttribute("role", "status"); box.append(result);
        try {
          const state = await options.request<{writable: boolean}>(`/conversations/${scope.conversation}/encryption/${scope.caseSeq}/contact`);
          if (!options.active() || view !== viewRevision) return;
          if (state.writable !== true) {result.textContent = "Contact updates are paused. Your saved email and chat stay available."; return;}
          result.remove();
        } catch {if (options.active() && view === viewRevision) result.textContent = "Contact updates could not be checked. Close and try again."; return;}
      }
      if (selected?.phase === "reviewed") {
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove email request";
        remove.disabled = busy;
        remove.onclick = () => {
          if (busy || !options.active()) return;
          approved = false; selected = undefined;
          void persist().then(() => {status(""); close();}).catch(() => status("The local email request could not be removed. Try again."));
        };
        box.append(remove);
      }
      if (selected?.phase === "bound") {
        const detail = document.createElement("p"), retry = document.createElement("button");
        detail.textContent = "This email request is waiting for confirmation. Retrying it does not send another message.";
        retry.type = "button"; retry.textContent = "Retry email";
        retry.disabled = !selected.scope || busy;
        retry.onclick = () => {retry.disabled = true; void submit().finally(() => {retry.disabled = busy;});};
        box.append(detail, retry); return;
      }
      const form = document.createElement("form"), label = document.createElement("label"), input = document.createElement("input"), review = document.createElement("button"), result = document.createElement("p");
      label.textContent = "Email address"; input.type = "email"; input.autocomplete = "email"; input.required = true; input.maxLength = 254;
      input.value = selected?.email ?? ""; label.append(input);
      review.type = "submit"; review.textContent = "Review with message"; result.setAttribute("role", "status");
      form.append(label, review, result); box.append(form); input.focus();
      form.onsubmit = event => {
        event.preventDefault(); event.stopPropagation();
        if (!options.active() || !input.reportValidity()) return;
        review.disabled = true; approved = false; confirming = true;
        reviewing = (async () => {
          const lead = parseSupportLeadInput({kind: "email", email: input.value.trim()});
          if (lead.kind !== "email") return;
          const prepared = await options.prepare("Please reply to me by email.", true);
          if (!options.active() || view !== viewRevision) return;
          if (!prepared) {result.textContent = "Finish the pending send before preparing an email request."; return;}
          selected = {v: 1, clientId: crypto.randomUUID(), email: lead.email, phase: "reviewed"};
          await persist(); if (!options.active() || view !== viewRevision) return;
          approved = true; confirming = false; status(`Contact email: ${lead.email}. Press Send to share it with the team.`); close();
        })();
        void reviewing.catch(() => {approved = false; result.textContent = "The email request could not be saved. Review it again.";}).finally(() => {review.disabled = false; confirming = false;});
      };
    },
    async sendIntent(messageId: string) {
      await loaded; await reviewing; if (!options.active()) return;
      if (!approved || selected?.phase !== "reviewed") return;
      selected = {...selected, phase: "bound", messageId: opaqueId(messageId)};
      await persist();
    },
    async bindCase(scope: E2eeCase) {
      await loaded; if (!options.active() || selected?.phase !== "bound" || selected.scope) return;
      selected = {...selected, scope: parseCase(scope)}; await persist();
    },
    accepted(scope: E2eeCase, id: string) {
      void (async () => {
        await loaded;
        if (!options.active() || selected?.phase !== "bound" || selected.messageId !== id) return;
        if (selected.scope && JSON.stringify(selected.scope) !== JSON.stringify(scope)) return;
        selected = {...selected, scope: parseCase(scope)}; await persist(); await submit();
      })().catch(() => status("Your email is not confirmed. Open Notify me to retry it."));
    },
    unsent(id: string) {
      if (!options.active() || selected?.phase !== "bound" || selected.messageId !== id) return;
      selected = {v: 1, clientId: crypto.randomUUID(), email: selected.email, phase: "reviewed"}; approved = false;
      status("The message was not sent. Open Notify me to review your email before another send.");
      void persist().catch(() => status("The email request could not reset. Review it again."));
    },
    dismiss() {viewRevision++; if (confirming) approved = false;},
    close() {options.store.close();},
  };
}
