import { drawerActionsStyle } from "./support-widget-drawer-actions-style";

/** The drawer owns its width. An address can use the full row on a small screen. */
export const walletStyle = `${drawerActionsStyle}
.shared-chat .flex-drawer{container:wallet-menu / inline-size}
.wallet-list,.wallet-families{display:flex;gap:8px}
.wallet-list{flex-direction:column}
.wallet-families,.wallet-list>div{flex-wrap:wrap}
.wallet-list>div{display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0}
.wallet-proof{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;font-size:12px;font-weight:400;line-height:1.4}
.wallet-proof bdi{min-width:0;white-space:nowrap;overflow-x:auto;scrollbar-width:thin}
.wallet-proof svg{width:14px;height:14px;flex:none;color:light-dark(#28643c,#93ce9d)}
.shared-chat .wallet-list .wallet-remove{display:grid;place-items:center;width:44px;height:44px;padding:0;color:var(--m)}
.wallet-remove svg{width:16px;height:16px}
.wallet-remove span{display:none}
.wallet-confirm .wallet-proof{margin-block:4px}
.chat-roster small:has(.wallet-identity){display:grid;grid-template-columns:minmax(0,1fr);gap:4px}
.shared-chat .wallet-identity{display:flex;align-items:center;width:fit-content;max-width:100%;min-height:24px;padding:0;border-radius:4px;font:inherit;text-align:start;cursor:pointer}
.wallet-identity bdi{text-decoration:underline;text-underline-offset:3px}
.shared-chat .wallet-toast{position:absolute;z-index:10;inset-inline:12px;bottom:calc(var(--composer-height,60px) + 10px);width:fit-content;max-width:calc(100% - 24px);margin:0 auto;border-radius:8px;color:var(--bg);background:var(--t);font-size:14px;font-weight:500;line-height:1.4;pointer-events:none}
.shared-chat .wallet-toast:not(:empty){padding:8px 12px}
.shared-chat .wallet-toast bdi{display:block;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all;pointer-events:auto}
@container wallet-menu (max-width:385px){
  .chat-roster:has(.wallet-identity)>div{display:grid;grid-template-columns:24px minmax(0,1fr);align-content:center;gap:0 8px;padding-block:4px}
  .chat-roster:has(.wallet-identity)>div>i{width:24px;height:24px}
  .chat-roster:has(.wallet-identity)>div>span{display:contents}
  .chat-roster:has(.wallet-identity)>div>span>small{grid-column:1/-1;min-height:24px;align-content:center}
  .shared-chat .wallet-list .wallet-remove{display:inline-flex;gap:4px;width:auto;min-width:44px;margin-inline-start:auto;padding-inline:8px}
  .wallet-remove span{display:inline}
}
@container wallet-menu (max-width:310px){
  .shared-chat .drawer-section{padding-inline:2px}
  .wallet-proof{font-size:11px}
  .wallet-proof bdi{letter-spacing:-.025em}
}
`;
