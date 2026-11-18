/** Templ's own support chat collects a contact email after policy approval. */
import {
  SUPPORT_LEAD_LIMITS,
  type SupportLeadInput,
} from "@templ/chat/support-lead";
import type { SupportSelectedWallet, TailHost } from "./support-widget";
export { forms } from "./support-widget-form";

const mounted = new WeakSet<HTMLElement>();
const failure = (
  cause:
    | "invalid-fields"
    | "wallet-proof"
    | "write-failed"
    | "consent-failed"
    | "busy",
) =>
  console.warn("TEMPL_SUPPORT_FAILURE", {
    route: "landing",
    step: "lead",
    cause,
  });

/** The caller opts in, and the server permits only Templ's own workspace. */
export function lead(host: TailHost, panel: HTMLElement) {
  if (
    !host.options.templLeadCapture ||
    !host.policy?.templLeadCapture ||
    mounted.has(panel)
  )
    return;
  mounted.add(panel);
  const { el } = host;
  const email = host.emailButton;
  if (!email) return;
  const status = el("p", undefined, "lead-status");
  status.setAttribute("role", "status");
  const sheet = el("section", undefined, "lead-sheet");
  sheet.setAttribute("aria-label", "Email follow-up");
  sheet.hidden = true;
  const content = el("div", undefined, "lead-content");
  const heading = el("strong", "Email follow-up");
  const back = el("button", "Back", "quiet");
  back.type = "button";
  const sheetStatus = el("p", undefined, "lead-status");
  sheetStatus.setAttribute("role", "status");
  sheet.append(heading, back, content, sheetStatus);
  panel.append(status, sheet);
  const nudge = el("div", undefined, "email-nudge");
  const follow = el("button", "Get a reply by email", "quiet");
  follow.type = "button";
  follow.addEventListener("click", () => email.click());
  nudge.append(follow);
  nudge.hidden = true;
  panel.querySelector(".body")?.append(nudge);
  let shared = false;
  email.disabled = false;
  email.title = "Leave an email for the team to contact you.";
  host.leadState = (working) => {
    email.disabled = working || sending;
    follow.disabled = working || sending;
    nudge.hidden = !host.messageSent || shared;
  };
  host.style.textContent +=
    ".lead-content form{display:grid;gap:12px}.lead-status{padding:0 12px 6px;font-size:12px;color:var(--m);flex:none}.lead-status:empty{display:none}.lead-sheet{position:absolute;inset:0 0 54px;z-index:3;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto 1fr auto;gap:12px;padding:16px;background:var(--bg);overflow:auto}.lead-content{grid-column:1/-1;min-height:0;overflow:auto}.lead-sheet>.lead-status{grid-column:1/-1}" +
    (host.leadStyles ?? "");
  const focus = email;
  let attempt: { input: string; id: string } | undefined;
  host.client.onSessionChange(() => {
    attempt = undefined;
    shared = false;
    nudge.hidden = true;
  });
  let sending = false,
    sendRevision = 0;
  const close = () => {
    sheet.hidden = true;
    sheetStatus.textContent = "";
    focus.focus();
  };
  back.addEventListener("click", close);
  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  const step = (kind: SupportLeadInput["kind"]) => {
    try {
      host.options.onStep?.(`lead_${kind}`);
    } catch {
      /* Measurement cannot stop support. */
    }
  };
  const send = async (input: SupportLeadInput, button: HTMLButtonElement) => {
    if (sending) {
      failure("busy");
      sheetStatus.textContent = "Please wait. Your details are sending.";
      return;
    }
    const checked = input;
    const revision = ++sendRevision;
    sending = email.disabled = button.disabled = true;
    const release = () => {
      if (revision !== sendRevision) return;
      sending = email.disabled = button.disabled = false;
    };
    const text = "Please reply to me by email.";
    sheetStatus.textContent = "Reviewing email…";
    if (checked.kind !== "email") {
      release();
      return;
    }
    const rows: [string, string][] = [["Email address", checked.email]];
    sheet.hidden = true;
    status.textContent = "Reviewing details…";
    const deliver = (wallet?: SupportSelectedWallet) => {
      if (revision !== sendRevision) return;
      status.textContent = "Sending details…";
      let started = false;
      void host
        .run(async () => {
          started = true;
          try {
            await host.client.guest?.(
              false,
              !!wallet,
              undefined,
              false,
              wallet,
            );
            const key = JSON.stringify(checked);
            if (attempt?.input !== key) {
              const random = crypto.randomUUID(),
                time = Date.now().toString(16).padStart(12, "0");
              attempt = {
                input: key,
                id: `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`,
              };
            }
            await host.client.ask(text, undefined, attempt.id, checked);
            attempt = undefined;
            shared = true;
            nudge.hidden = true;
            step(checked.kind);
            close();
            status.textContent = "Sent. The team can contact you by email.";
            await host.refresh(true).catch(() => {});
          } catch (reason) {
            failure("write-failed");
            sheet.hidden = false;
            sheetStatus.textContent =
              "We could not send your details. Try again.";
            status.textContent = "";
            throw reason;
          } finally {
            release();
          }
        })
        .then(() => {
          if (!started) {
            failure("busy");
            sheet.hidden = false;
            sheetStatus.textContent = "Please wait. Then send your details.";
            status.textContent = "";
            release();
          }
        });
    };
    const cancel = () => {
      if (revision !== sendRevision) return;
      sheet.hidden = false;
      sheetStatus.textContent = "Review your details again.";
      status.textContent = "";
      release();
    };
    try {
      const reviewed = await host.reviewLead?.(
        text,
        {
          rows,
          edit: () => {
            if (revision !== sendRevision) return;
            sheet.hidden = false;
            status.textContent = "";
            release();
          },
          cancel,
        },
        deliver,
      );
      if (revision !== sendRevision) return;
      if (reviewed === "busy") {
        failure("busy");
        cancel();
        sheetStatus.textContent =
          "Review your message. Then send your details.";
      } else if (reviewed !== "shown" && reviewed !== "sent") cancel();
    } catch {
      if (revision !== sendRevision) return;
      failure("consent-failed");
      sheet.hidden = false;
      sheetStatus.textContent = "We could not send your details. Try again.";
      status.textContent = "";
      release();
    }
    if (status.textContent === "Reviewing details…")
      status.textContent = "Review the details. Then send.";
  };
  const submit = (
    form: HTMLFormElement,
    text: string,
    value: () => SupportLeadInput,
  ) => {
    const button = el("button", text, "primary");
    button.type = "submit";
    form.append(
      el("p", "The team will see these details with your case."),
      button,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) {
        failure("invalid-fields");
        return;
      }
      try {
        const input = value();
        void send(input, button);
      } catch (reason) {
        failure("invalid-fields");
        sheetStatus.textContent =
          reason instanceof Error ? reason.message : "Check your details.";
      }
    });
  };
  const input = (
    form: HTMLFormElement,
    text: string,
    type: string,
    max: number,
  ) => {
    const label = el("label", text),
      field = el("input");
    field.type = type;
    field.required = true;
    field.maxLength = max;
    label.append(field);
    form.append(label);
    return field;
  };
  email.addEventListener("click", () => {
    sheetStatus.textContent = "";
    const form = el("form");
    const address = input(
      form,
      "Email address",
      "email",
      SUPPORT_LEAD_LIMITS.email,
    );
    address.autocomplete = "email";
    form.append(
      el(
        "p",
        "The team can contact you at this address. This does not sign you in.",
      ),
    );
    submit(form, "Send email", () => ({
      kind: "email",
      email: address.value.trim(),
    }));
    content.replaceChildren(form);
    sheet.hidden = false;
    address.focus();
  });
}
