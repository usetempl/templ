import {appApprovalForm} from "../../../web/src/lib/app-approval-request";
import {supportFormMessage, type SupportForm} from "../../../web/src/lib/support-widget-form";
import styles from "./page.module.css";

/** Fixed blank forms, created on the secure origin. Parent-page values,
 * wallets and workspace identifiers are never imported. */
export function ownIntake(intent?: string) {
  const config: SupportForm | undefined = intent === "quote" ? {
    title: "Custom pricing", text: "Share your app and expected case or AI usage. Our team will reply here.", message: "I’d like a custom pricing quote.", fields: [
      {id: "website", label: "App website", type: "website", required: true},
      {id: "cases", label: "Cases per month"}, {id: "ai", label: "AI usage or needs"},
    ],
  } : intent === "app-approval" || intent === "app-services" ? appApprovalForm({services: intent === "app-services"}) : undefined;
  if (!config) return undefined;
  const form = document.createElement("form"), heading = document.createElement("h2"), description = document.createElement("p"), status = document.createElement("p");
  form.className = styles.intake; heading.textContent = config.title; description.textContent = config.text ?? "";
  status.setAttribute("role", "status");
  form.append(heading, description);
  const fields = config.fields.map(field => {
    const label = document.createElement("label"), input = document.createElement("input");
    label.textContent = field.label;
    input.type = field.type === "email" ? "email" : "text";
    input.maxLength = field.type === "website" ? 500 : 300;
    input.required = field.required ?? false;
    label.append(input); form.append(label);
    return input;
  });
  const review = document.createElement("button"), cancel = document.createElement("button");
  review.type = "submit"; review.textContent = "Review message"; review.disabled = true;
  cancel.type = "button"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => form.remove());
  form.append(review, cancel, status);
  let prepare: ((text: string) => Promise<boolean>) | undefined;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!prepare || !form.reportValidity()) return;
    try {
      const message = supportFormMessage(config, fields.map(input => input.value));
      review.disabled = true;
      void prepare(message).then(accepted => {
        if (accepted) form.remove();
        else status.textContent = "Finish your current draft before preparing this request.";
      }).catch(() => {status.textContent = "The draft could not be prepared. Try again.";}).finally(() => {review.disabled = false;});
    } catch (error) {status.textContent = error instanceof Error ? error.message : "Review your answers.";}
  });
  return {element: form, ready: (callback: (text: string) => Promise<boolean>) => {prepare = callback; review.disabled = false;}};
}
