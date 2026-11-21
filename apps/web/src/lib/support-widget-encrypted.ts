import { customerSupportUrl } from "./customer-support-url";
import type { SupportClient, TailHost } from "./support-widget";
type SecureCase = {
  clientOrigin: string;
  caseSeq?: number;
  custody?: "customer" | "templ-own-support";
};
const originals = new WeakMap<HTMLElement, Node[]>();

/** Navigation carries only case identifiers. The optional local draft
 * preview is never included in the link or sent to the secure page. */
export function secure(
  form: HTMLElement,
  workspace: string,
  policy?: SecureCase,
  conversation?: string,
  back?: () => void,
  draft?: () => string,
) {
  const before = originals.get(form);
  if (!policy) {
    if (before) {
      form.replaceChildren(...before);
      originals.delete(form);
    }
    return;
  }
  if (!before) originals.set(form, [...form.childNodes]);
  const href = customerSupportUrl(
    policy.clientOrigin,
    workspace,
    conversation,
    policy.caseSeq,
    policy.custody,
  );
  const panel = document.createElement("section"),
    title = document.createElement("strong"),
    text = document.createElement("p"),
    action = document.createElement("a");
  title.textContent = "Encrypted support";
  text.textContent =
    policy.custody === "templ-own-support"
      ? "Templ's support team and security and recovery service can read this chat. Templ AI can read messages shared with it. Open the secure page to write and read messages."
      : "This team keeps the chat keys. Write and read messages on its secure support page. Templ cannot read or recover them.";
  panel.style.cssText =
    "padding:8px;line-height:1.5;min-width:0;overflow-wrap:anywhere";
  panel.setAttribute("aria-label", "Encrypted support");
  panel.append(title, text);
  if (href) {
    action.href = href;
    action.target = "_blank";
    action.rel = "noopener noreferrer";
    action.textContent = "Open secure chat";
    panel.append(action);
  } else
    text.textContent =
      "The secure support address could not be verified. Contact the team through its website.";
  if (back) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    button.textContent = "Back to current case";
    button.addEventListener("click", back);
    panel.append(button);
  }
  if (draft && !conversation) {
    const details = document.createElement("details"),
      label = document.createElement("summary"),
      preview = document.createElement("pre");
    label.textContent = "Draft on this device";
    preview.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
    details.addEventListener("toggle", () => {
      preview.textContent = details.open ? draft() : "";
    });
    details.append(label, preview);
    panel.append(details);
  }
  form.replaceChildren(panel);
}

/** Current-case reads and new-case intent have separate routes. Session
 * changes and case selection invalidate older reads before they can render. */
export function route(
  client: SupportClient,
  form: HTMLElement,
  workspace: string,
) {
  const draft = form.querySelector<HTMLTextAreaElement>("textarea");
  const identity = () => {
    const session = client.adopt()[0];
    return session && `${session.principalId}:${session.level}`;
  };
  let owner = identity(),
    revision = 0,
    opening = false,
    selecting = false;
  let newPolicy: SecureCase | undefined;
  let currentCase: { id: string; policy?: SecureCase } | undefined;
  const show = (policy?: SecureCase, conversation?: string) => {
    const version = revision;
    secure(
      form,
      workspace,
      policy,
      conversation,
      opening && currentCase
        ? () => {
            if (version !== revision) return;
            opening = false;
            revision++;
            show(currentCase?.policy, currentCase?.id);
          }
        : undefined,
      draft ? () => draft.value : undefined,
    );
  };
  const status = client.status.bind(client);
  client.status = async (newCase) => {
    if (newCase) {
      opening = true;
      selecting = false;
      revision++;
    }
    const version = revision;
    const answer = await status();
    if (
      version === revision &&
      !selecting &&
      (newCase || (!opening && !answer.mine))
    ) {
      if (newCase) newPolicy = answer.encryption;
      show(answer.encryption);
    }
    return answer;
  };
  const messages = client.messages.bind(client);
  client.messages = async (id, before, seen, select) => {
    if (select) {
      selecting = true;
      revision++;
    }
    const version = revision;
    try {
      const page = await messages(id, before, seen, select);
      if (
        version === revision &&
        (select || (!selecting && (!currentCase || currentCase.id === id)))
      ) {
        if (page.conversation?.id !== id) throw new Error("Case not found.");
        if (select || !currentCase) revision++;
        currentCase = { id, policy: page.conversation.encryption };
        if (select) opening = selecting = false;
        if (!opening) show(currentCase.policy, id);
      }
      return page;
    } catch (error) {
      if (select && version === revision) {
        selecting = false;
        show(
          opening ? newPolicy : currentCase?.policy,
          opening ? undefined : currentCase?.id,
        );
      }
      throw error;
    }
  };
  client.onSessionChange(() => {
    const next = identity();
    if (next === owner) return;
    owner = next;
    revision++;
    opening = selecting = false;
    currentCase = undefined;
    newPolicy = undefined;
    show();
  });
  return (
    host: TailHost,
    ready: () => string | false | null,
    start: (id: string) => void,
  ) =>
    host.run(async () => {
      const current = ready();
      if (!current) return;
      const readOnly = host.draft.readOnly;
      host.draft.readOnly = true;
      const pending = client.status(true),
        version = revision;
      let keepRoute = false;
      try {
        const answer = await pending;
        if (version !== revision || ready() !== current) return;
        if (!answer.encryption)
          start(host.policy?.newConversation ? answer.mine ?? current : current);
        keepRoute = true;
      } finally {
        if (!keepRoute && version === revision) {
          opening = false;
          revision++;
          show(currentCase?.policy, currentCase?.id);
        }
        host.draft.readOnly = readOnly;
      }
    });
}
