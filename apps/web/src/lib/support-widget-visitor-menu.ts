import type { TailHost } from "./support-widget";
import { bindSupportDrawer } from "./support-widget-drawer";
import { drawerNotices } from "./support-widget-drawer-notices";
import { drawerStyle } from "./support-widget-drawer-style";

export function visitorMenu(host: TailHost, actions: HTMLElement, signal: AbortSignal) {
  const { menu, panel, drawer, refreshMenu } = bindSupportDrawer(host, actions, signal, drawerNotices);
  host.style.textContent += drawerStyle + `
.shared-chat .flex-options>.options-note,.shared-chat .flex-options>.tools{display:none}
`;
  // Preserve the original sign-in handler for workspaces that require it.
  // The wallet section can invoke it. Legacy toolbar actions stay out of the drawer.
  actions.hidden = true;
  menu.classList.add("flex-options");
  const provider = host.options.wallet?.evm;
  if (provider) host.walletName = address => import("./support-wallet-name")
    .then(module => module.verifiedWalletName(address, provider));
  return { menu, panel, drawer, refresh: refreshMenu };
}

export function addOwnChatMenu(host: TailHost, actions: HTMLElement) {
  return visitorMenu(host, actions, host.lifetime!).refresh;
}

export function addCryptoChatMenu(host: TailHost, actions: HTMLElement) {
  const { menu, drawer, refresh } = visitorMenu(host, actions, host.lifetime!);
  const help = host.el("a", "Emergency help for a scam or hack", "drawer-section");
  help.href = "https://securityalliance.org/sos";
  help.target = "_blank";
  help.rel = "noopener noreferrer";
  menu.append(help);
  const create = host.el("a", "Get this chat for your site", "drawer-create");
  create.href = "/create";
  create.target = "_blank";
  create.rel = "noopener noreferrer";
  create.setAttribute("aria-label", "Get this chat for your site (opens in a new tab)");
  const arrow = host.el("span", "↗");
  arrow.setAttribute("aria-hidden", "true");
  create.append(arrow);
  drawer.querySelector(".flex-brand")?.append(create);
  host.style.textContent += `
.shared-chat .sources{flex-direction:column;align-items:flex-start}
.shared-chat .flex-brand:has(>.drawer-create){flex-wrap:wrap;row-gap:4px}
.shared-chat .flex-brand>.drawer-create{gap:.3em;margin-inline-start:auto;white-space:nowrap;text-decoration:underline;text-underline-offset:.15em}
.shared-chat .flex-brand>.drawer-create:hover{color:var(--t)}
`;
  return refresh;
}
