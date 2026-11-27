/** Report this answer: the modal a chat opens from an answer's warning
 * triangle. It asks for an optional short reason, sends it with the caller's
 * `submit` and shows the result. It draws in the trigger's own document or
 * shadow root, so a widget's theme reaches it, and focus returns to the
 * trigger when it closes.
 *
 * `submit` resolves only once the service accepted the report and rejects
 * otherwise. The dialog shows a rejection's message as given, so callers
 * reject with reviewed text. A refused secret (`reason: "secret-refused"`)
 * also clears the field, as a refused draft does. */
const STYLE =
  ".answer-report{position:fixed;inset:0;z-index:2147483002;box-sizing:border-box;width:min(360px,calc(100% - 32px));height:fit-content;max-height:calc(100% - 32px);margin:auto;padding:16px;overflow:auto;border:1px solid var(--b,var(--templ-line,GrayText));border-radius:var(--rp,var(--templ-radius-surface,12px));background:var(--bg,var(--templ-bg,Canvas));color:var(--t,var(--templ-text,CanvasText));box-shadow:var(--sh,0 24px 64px rgb(0 0 0/.24));font:inherit;font-size:15px;line-height:1.5}.answer-report::backdrop{background:rgb(0 0 0/.4)}.answer-report [hidden]{display:none}.answer-report h2{margin:0 0 12px;font-size:16px;font-weight:600}.answer-report label{display:grid;gap:6px;font-size:14px;font-weight:600}.answer-report textarea{box-sizing:border-box;width:100%;min-height:72px;padding:8px 10px;border:1px solid var(--b2,var(--templ-line,GrayText));border-radius:var(--rc,var(--templ-radius-control,8px));background:var(--s,var(--templ-surface,Field));color:inherit;font:inherit;font-weight:400;resize:vertical}.answer-report :focus-visible{outline:2px solid var(--af,var(--templ-focus,Highlight));outline-offset:2px}.answer-report p{margin:0;font-size:14px}.answer-report p:not(:empty){margin-top:8px}.answer-report .error{color:var(--d,var(--templ-danger,#b52f29))}.answer-report .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.answer-report button{min-height:40px;padding:0 14px;border:1px solid var(--b2,var(--templ-line,GrayText));border-radius:var(--rc,var(--templ-radius-control,8px));background:none;color:inherit;font:inherit;font-weight:600;cursor:pointer}.answer-report .send{border-color:transparent;background:var(--a,var(--templ-accent,Highlight));color:var(--oa,var(--templ-on-accent,HighlightText))}.answer-report [aria-disabled=true]{cursor:progress;opacity:.7}";
/** The service's limit: ANSWER_REPORT_LIMITS.reasonChars. */
const REASON_CHARS = 280;
let opened = 0;

export function openAnswerReportDialog(
  trigger: HTMLElement,
  submit: (reason: string) => Promise<void>,
  privatePreview = false,
): void {
  if (!trigger.isConnected) return;
  const doc = trigger.ownerDocument;
  const root = trigger.getRootNode() as Document | ShadowRoot;
  // Styles go in the shadow root or the document head, the dialog in the
  // shadow root or the document body.
  const scope: ParentNode = root === doc ? doc.head : root;
  const parent: ParentNode = root === doc ? doc.body : root;
  if (parent.querySelector(".answer-report[open]")) return;
  if (!scope.querySelector("style[data-answer-report]")) {
    const style = doc.createElement("style");
    style.dataset.answerReport = "";
    // A page that allows only nonced styles: reuse the nonce its styles carry.
    const nonce =
      scope.querySelector("style")?.nonce ||
      doc.querySelector<HTMLElement>("[nonce]")?.nonce;
    if (nonce) style.nonce = nonce;
    style.textContent = STYLE;
    scope.append(style);
  }
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
  ) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const dialog = make("dialog", undefined, "answer-report");
  const form = make("form");
  const title = make("h2", "Report this answer");
  const label = make("label", "What was wrong? (optional)");
  const field = make("textarea");
  const error = make("p", undefined, "error");
  const done = make("p");
  const actions = make("div", undefined, "actions");
  const cancel = make("button", "Cancel");
  const send = make("button", "Send report", "send");
  title.id = `answer-report-${++opened}`;
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.setAttribute("aria-modal", "true");
  field.maxLength = REASON_CHARS;
  field.rows = 3;
  error.setAttribute("role", "alert");
  done.setAttribute("role", "status");
  cancel.type = "button";
  send.type = "submit";
  label.append(field);
  actions.append(cancel, send);
  form.append(title);
  if (privatePreview) form.append(make("p", "Your report stays in this private preview until it expires."));
  form.append(label, error, done, actions);
  dialog.append(form);

  let closed = false,
    busy = false,
    sent = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (trigger.isConnected) trigger.focus();
  };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    // The chat and the page keep their own Escape.
    event.stopPropagation();
    close();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || sent) return;
    busy = field.readOnly = true;
    // Disabled controls would drop focus out of the dialog.
    send.setAttribute("aria-disabled", "true");
    send.textContent = "Sending…";
    error.textContent = "";
    submit(field.value).then(
      () => {
        sent = true;
        label.hidden = send.hidden = true;
        done.textContent = "Report saved.";
        cancel.textContent = "Done";
        cancel.focus();
      },
      (reason: { message?: unknown; reason?: unknown } | null) => {
        busy = field.readOnly = false;
        send.removeAttribute("aria-disabled");
        send.textContent = "Send report";
        if (reason?.reason === "secret-refused") field.value = "";
        error.textContent =
          typeof reason?.message === "string" && reason.message
            ? reason.message
            : "The report wasn't sent. Try again.";
        field.focus();
      },
    );
  });
  parent.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  field.focus();
}
