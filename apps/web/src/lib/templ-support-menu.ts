import type { TailHost } from "./support-widget";

export function addOwnChatMenu(host: TailHost, actions: HTMLElement) {
  const { el } = host;
  const panel = actions.closest<HTMLElement>(".panel")!;
  const drawer = actions.closest<HTMLElement>(".chat-menu")!;
  panel.classList.add("templ-home-chat");
  const fullPage = el("a", "Open full-page chat", "quiet notice-open");
  fullPage.href = new URL(`/help/${host.options.workspace}`, location.origin).href;
  // A same-origin navigation resumes the guest session already stored for this workspace.
  fullPage.prepend(host.icon("chat"));
  fullPage.hidden = host.policy?.hosted !== true;
  drawer.append(fullPage);
  host.style.textContent += `
.panel.conversation-drawers.templ-home-chat .chat-menu{inset-block-start:var(--templ-menu-top,56px);padding-block-start:8px}
.templ-home-chat .chat-menu [hidden]{display:none}
.templ-home-chat .notice-open{display:flex;align-items:center;gap:10px;padding:8px 12px;text-align:start}
.templ-home-chat .notice-open svg{width:18px;height:18px}
`;
  return () => {
    fullPage.hidden = host.policy?.hosted !== true;
    if (host.emailButton) host.emailButton.hidden = true;
    const height = panel.querySelector<HTMLElement>(".head")?.offsetHeight;
    if (height) panel.style.setProperty("--templ-menu-top", height + "px");
  };
}
