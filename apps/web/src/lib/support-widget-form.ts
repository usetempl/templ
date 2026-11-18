/** Forms stay in the chat. Only the visitor's Send click shares answers. */
import type { TailHost } from "./support-widget";

export type SupportForm = {
  title: string;
  text?: string;
  message?: string;
  fields: {
    id: string;
    label: string;
    type?: "text" | "email" | "website";
    required?: boolean;
    value?: string;
  }[];
};

export function websiteAddress(input: string) {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`,
    );
  } catch {
    throw new Error("Enter your app’s website.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname.includes(".") ||
    /\s/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 500
  )
    throw new Error("Use a website link without passwords or private codes.");
  return url.href;
}

/** Display strings cannot become markup, scripts or a request destination. */
export function checkedSupportForm(input: SupportForm): SupportForm {
  const text = (value: unknown, max: number, optional = false) => {
    if (value === undefined && optional) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Error("This form could not open.");
    return value;
  };
  if (
    !input ||
    !Array.isArray(input.fields) ||
    !input.fields.length ||
    input.fields.length > 6
  )
    throw new Error("This form could not open.");
  const ids = new Set<string>();
  return {
    title: text(input.title, 80)!,
    text: text(input.text, 160, true),
    message: text(input.message, 200, true),
    fields: input.fields.map((field) => {
      if (
        !field ||
        !/^[a-z][a-z\d-]{0,31}$/.test(field.id) ||
        ids.has(field.id) ||
        (field.type !== undefined &&
          !["text", "email", "website"].includes(field.type)) ||
        (field.required !== undefined && typeof field.required !== "boolean") ||
        (field.value !== undefined &&
          (typeof field.value !== "string" || field.value.length > 500))
      )
        throw new Error("This form could not open.");
      ids.add(field.id);
      return {
        id: field.id,
        label: text(field.label, 40)!,
        type: field.type ?? "text",
        required: field.required === true,
        value: field.value,
      };
    }),
  };
}

export function supportFormMessage(form: SupportForm, values: string[]) {
  const lines = [form.message ?? form.title];
  form.fields.forEach((field, index) => {
    let value = values[index]?.trim() ?? "";
    if (!value && field.required)
      throw new Error(`Enter ${field.label.toLowerCase()}.`);
    if (!value) return;
    if (value.length > (field.type === "website" ? 500 : 300))
      throw new Error(`Shorten ${field.label.toLowerCase()}.`);
    if (field.type === "website") value = websiteAddress(value);
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new Error("Enter an email address.");
    lines.push(`${field.label}: ${value}`);
  });
  const message = lines.join("\n");
  if (message.length > 2000)
    throw new Error("Shorten your answers and try again.");
  return message;
}

export function forms(
  host: TailHost,
  body: HTMLElement,
  send: (text: string, current: () => boolean) => Promise<void>,
) {
  const { el } = host;
  host.style.textContent +=
    ".chat-form{display:grid;gap:12px;padding:14px;margin-top:12px;border:1px solid var(--b2);border-radius:var(--rc);background:var(--s)}.chat-form h2{font-size:17px;margin:0}.chat-form label{display:grid;gap:5px}.chat-form input{width:100%;min-height:44px;padding:8px;background:var(--bg);border:1px solid var(--b2);border-radius:var(--rc);color:var(--t)}.chat-form p{font-size:14px;color:var(--m)}.chat-form .form-error{color:var(--d)}.panel:has(.chat-form)>.form,.body:has(.chat-form) :is(.starter,.suggestions,.tail,.email-nudge){display:none}";
  let current: HTMLFormElement | undefined;
  const close = () => {
    current?.remove();
    current = undefined;
  };
  host.client.onSessionChange(close);
  return {
    close,
    open(input: SupportForm) {
      const config = checkedSupportForm(input);
      close();
      const form = el("form", undefined, "chat-form");
      current = form;
      form.setAttribute("aria-label", config.title);
      form.append(el("h2", config.title));
      if (config.text) form.append(el("p", config.text));
      const fields = config.fields.map((field) => {
        const label = el(
          "label",
          field.label + (field.required ? "" : " (optional)"),
        );
        const input = el("input");
        input.type = field.type === "email" ? "email" : "text";
        if (field.type === "website") input.placeholder = "yourapp.com";
        input.inputMode =
          field.type === "website"
            ? "url"
            : field.type === "email"
              ? "email"
              : "text";
        input.setAttribute(
          "autocomplete",
          field.type === "website"
            ? "url"
            : field.type === "email"
              ? "email"
              : "off",
        );
        input.required = !!field.required;
        input.maxLength = field.type === "website" ? 500 : 300;
        input.value = field.value ?? "";
        label.append(input);
        form.append(label);
        return input;
      });
      const error = el("p", undefined, "form-error");
      error.setAttribute("role", "alert");
      const submit = el("button", "Send request", "primary");
      submit.type = "submit";
      const cancel = el("button", "Back to chat", "quiet");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        close();
        host.draft.focus();
      });
      form.append(error, submit, cancel);
      let sending = false;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (sending || !form.reportValidity()) return;
        error.textContent = "";
        let validating = true;
        try {
          const message = supportFormMessage(
            config,
            fields.map((field) => field.value),
          );
          validating = false;
          sending = submit.disabled = true;
          cancel.disabled = true;
          submit.textContent = "Sending…";
          submit.setAttribute("aria-busy", "true");
          await send(message, () => current === form);
        } catch (reason) {
          // Field guidance comes from this file. Send failures use public copy.
          error.textContent = validating
            ? reason instanceof Error
              ? reason.message
              : "Check your details."
            : host.errorText(reason);
        } finally {
          sending = submit.disabled = false;
          cancel.disabled = false;
          submit.textContent = "Send request";
          submit.removeAttribute("aria-busy");
        }
      });
      body.append(form);
      form.scrollIntoView?.({ block: "nearest" });
      fields[0].focus();
    },
  };
}
