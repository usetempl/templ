import type { TailHost } from "./support-widget";
import { bindSupportDrawer } from "./support-widget-drawer";
import { drawerStyle } from "./support-widget-drawer-style";
import { walletRoster } from "./support-wallet-copy";

/** Wallet verification and reply notifications for the configured support chat. */
export function visitorMenu(host: TailHost, actions: HTMLElement, signal: AbortSignal) {
  const { menu, panel, refreshMenu } = bindSupportDrawer(host, actions, signal);
  host.style.textContent += drawerStyle + `
.shared-chat .flex-options>.options-note,.shared-chat .flex-options>.tools{display:none}
.shared-chat .chat-roster>div>span{flex:1;min-width:0}
.shared-chat .wallet-identity{display:inline-flex;align-items:center;max-width:100%;min-height:44px;margin-inline-start:-6px;padding:4px 6px;border-radius:4px;font:inherit;text-align:start;cursor:pointer}
.shared-chat .wallet-identity bdi{min-width:0;white-space:nowrap;text-decoration:underline;text-underline-offset:3px}
.shared-chat .wallet-identity .wallet-name{white-space:normal;overflow-wrap:anywhere}
.shared-chat .wallet-toast{position:absolute;z-index:10;inset-inline:12px;bottom:calc(var(--composer-height,60px) + 10px);width:fit-content;max-width:calc(100% - 24px);margin:0 auto;border-radius:8px;color:var(--bg);background:var(--t);font-size:14px;font-weight:500;line-height:1.4;pointer-events:none}
.shared-chat .wallet-toast:not(:empty){padding:9px 14px}
.shared-chat .wallet-toast bdi{display:block;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all;pointer-events:auto}
`;
  // Preserve the original sign-in handler for workspaces that require it.
  // The wallet section can invoke it. Legacy toolbar actions stay out of the drawer.
  actions.hidden = true;
  menu.classList.add("flex-options");
  const refreshWalletRow = walletRoster(host, panel, signal);
  return { panel, refresh() { refreshMenu(); refreshWalletRow(); } };
}

export function addOwnChatMenu(host: TailHost, actions: HTMLElement) {
  return visitorMenu(host, actions, host.lifetime!).refresh;
}
