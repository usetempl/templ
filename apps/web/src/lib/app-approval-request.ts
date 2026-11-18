import type { SupportForm } from "./support-widget-form";

/** Approval requests confer no workspace authority. */
export function appApprovalForm(input: {
  appUrl?: string;
  workspace?: string;
  services?: boolean;
}): SupportForm {
  if (
    input.workspace &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.workspace,
    )
  )
    throw new Error("Open your workspace and try again.");
  return {
    title: "Request full access",
    text: input.services
      ? "Tell us about your app and any onboarding or custom work. Our team replies here."
      : "Send your app link. Our team will confirm access and pricing in this chat.",
    message: [
      "Please review my app for Templ access.",
      ...(input.workspace ? [`Workspace: ${input.workspace}`] : []),
    ].join("\n"),
    fields: [
      {
        id: "website",
        label: "App website",
        type: "website",
        required: true,
        value: input.appUrl,
      },
      {
        id: "email",
        label: "Contact email",
        type: "email",
      },
      ...(input.services
        ? [{ id: "help", label: "Help you need", type: "text" as const }]
        : []),
    ],
  };
}
