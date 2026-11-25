export const messageSpacing = "padding:8px 12px;line-height:1.45";
export const senderGutter = "position:relative;margin-inline-start:36px;max-width:min(82%,calc(100% - 36px))";

/** The appearance preview and the two visitor chat surfaces use the same accent and ink. */
export const outgoingBubbleStyle = `
.panel .message.own{background:color-mix(in srgb,var(--a) 22%,var(--bg));color:var(--t)}
.panel .message.own :is(time,a){color:inherit}
`;

const enabledControl = ":where(:not(:disabled,.drawer-primary,.drawer-stop,.flex-menu-backdrop))";

export const drawerStyle = `
.conversation-drawers .head{position:static}
.conversation-drawers .chat-menu .tools button:not([hidden]){display:flex;align-items:center;gap:10px}
.conversation-drawers .chat-menu .tools svg{width:18px;height:18px;flex:none}
.panel.shared-chat{container-type:size;--drawer-width:clamp(22rem,35cqw,26rem);--composer-height:60px;animation:none;background:var(--flex-chat-canvas,var(--bg))}
.shared-chat .head{min-height:56px;padding-block:5px 6px}
.shared-chat .body,.shared-chat .form{background:var(--flex-chat-canvas,var(--bg))}
.shared-chat .form{padding:var(--flex-composer-padding,8px 12px max(8px,env(safe-area-inset-bottom)));border-top:0}
.shared-chat .composer textarea{background:var(--s2);box-shadow:inset 0 0 0 1px var(--b2)}
.shared-chat .send{display:grid;place-items:center;width:44px;padding:0}
.shared-chat .send svg{display:block}
.shared-chat .send:hover:not(:disabled){transform:none}
.shared-chat .message[data-restored]{animation:none}
.shared-chat .message:not(.tail){${messageSpacing}}
${outgoingBubbleStyle}
.shared-chat .message.own time{min-height:14px;gap:4px}
.shared-chat .message.own .delivery-status{flex:0 0 12px;width:12px;height:12px;text-align:center}
.shared-chat .message.own .state:not(.failed){position:absolute;clip-path:inset(50%);overflow:hidden;width:1px;height:1px}
.shared-chat .message.own:has(.state.failed) time::after{content:"!";display:inline-block;width:12px;text-align:center}
.shared-chat .message:not(.own,.tail){${senderGutter}}
.shared-chat .message[data-grouped=true]{margin-top:-6px}
.shared-chat .message[data-grouped=true]>small{position:absolute;clip-path:inset(50%);overflow:hidden;width:1px;height:1px}
.shared-chat .handoff-notice{align-self:stretch;max-width:32rem;padding:12px 16px;line-height:1.5}
.shared-chat .handoff-notice strong,.shared-chat .handoff-notice p{display:block;margin:0 0 4px}
.shared-chat .handoff-notice button{min-height:44px;padding:8px 12px}
.shared-chat :is(.chat-avatars,.chat-roster) i{overflow:hidden}
.shared-chat :is(.chat-avatars,.chat-roster) i img{display:block;width:100%;height:100%;object-fit:cover}
.shared-chat .head{--head-ink:light-dark(#333,#eee)}
.shared-chat .head>:is(.icon-button,.visitor-theme),.shared-chat .head>details>summary{color:var(--head-ink)}
.shared-chat .head>button:focus-visible{outline-color:var(--head-ink)}
.shared-chat .chat-options>summary{gap:6px;min-height:44px;padding:0 8px}
.shared-chat :is(.chat-options,.chat-history)>summary,.shared-chat .chat-menu :is(button,summary){-webkit-user-select:none;user-select:none}
.shared-chat :is(.chat-options,.chat-history)>summary:focus-visible{outline:2px solid var(--head-ink);outline-offset:-2px}
.shared-chat .chat-options>summary>svg{display:block;width:20px;height:20px;pointer-events:none}
.panel.shared-chat.conversation-drawers>:is(.head,.body,.form,.error,.chat-feedback){margin-inline:0}
.shared-chat>.head:has(.chat-options[open],.chat-history[open]){position:relative;z-index:1;--drawer-top:calc(100% + 1px)}
.shared-chat :is(.chat-options,.chat-history)[open]>:is(.flex-drawer,.flex-menu-backdrop){position:absolute;inset:var(--drawer-top) 0 auto auto;height:calc(100cqh - var(--drawer-top))}
.shared-chat :is(.chat-options,.chat-history)[open]>.flex-menu-backdrop{width:100%;height:calc(100cqh - var(--drawer-top) - var(--composer-height));z-index:5}
.shared-chat .flex-drawer{display:flex;flex-direction:column;width:100%;padding:8px 12px max(8px,env(safe-area-inset-bottom));overflow:hidden;background:var(--bg);z-index:6}
.shared-chat .chat-options>.chat-menu,.shared-chat .chat-history>.member-conversations{display:none}
.shared-chat .flex-drawer>:is(.chat-menu,.member-conversations){position:static;flex:1 1 0;min-height:0;width:100%;max-width:none;max-height:none;margin:0;padding:4px 0 8px;overflow:auto;overscroll-behavior:contain;border:0;border-radius:0;box-shadow:none;animation:none}
.shared-chat .flex-drawer>.member-conversations{align-content:start}
.shared-chat .flex-brand{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:8px 8px 0;color:var(--m);font-size:12px}
.shared-chat .flex-brand>a{display:inline-flex;align-items:center;min-height:30px}
.shared-chat .flex-brand img{width:55px;height:auto}
.shared-chat .flex-brand span a{color:inherit;text-decoration:underline;text-underline-offset:.15em}
.shared-chat .flex-brand a:focus-visible,.shared-chat .flex-drawer :is(button,summary,input,a):focus-visible{outline:2px solid var(--af);outline-offset:-2px}
.shared-chat .drawer-section{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:8px 6px 20px;text-align:start}
.shared-chat .drawer-people .chat-roster{padding:0}
.shared-chat .drawer-section h3{display:flex;align-items:center;gap:8px;margin:0;font-size:16px;line-height:1.25;font-weight:600}
.shared-chat .drawer-section h3 svg{width:18px;height:18px;flex:none}
.shared-chat .drawer-section-body{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin:0;min-width:0;padding:0}
.shared-chat .drawer-section-body p{margin:0;color:var(--m);font-size:13px;line-height:1.45}
.shared-chat .drawer-section-body p:empty{display:none}
.shared-chat .drawer-section-body button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin:0;padding:6px 12px;border-radius:8px;font-size:14px;font-weight:600}
.shared-options>.options-note,.shared-options .tools :is([aria-label="Verify wallet"],[aria-label="Sign out"],[aria-label="Notify me when answered"]){display:none!important}
.shared-chat .drawer-section [hidden]{display:none!important}
.shared-chat :is(.drawer-section-body .quiet,.member-conversations button)${enabledControl}{color:light-dark(var(--at),var(--t))}
.shared-chat .drawer-section-body .quiet,.shared-chat .wallet-identity{color:var(--at)}
.shared-chat :is(.chat-menu button,.member-conversations button)${enabledControl}:hover,
.shared-chat .member-conversations button[aria-current]{background:var(--s2);color:var(--at)}
.shared-chat .chat-menu button${enabledControl}:active{background:var(--s);color:var(--at)}
.drawer-error{order:1;padding:10px 12px;color:var(--m);font-size:13px}
.shared-chat .body>.loading-case:not([hidden])::before{content:"";display:block;width:5rem;height:4px;margin-block-end:8px;border-radius:2px;background:var(--m)}
.shared-chat .body>.loading-case:not([hidden]){display:grid;justify-items:center;border:0;background:none;color:var(--m)}
.shared-chat .flex-drawer>.chat-menu{display:flex;flex-direction:column;align-items:stretch;gap:0}
.shared-chat .flex-drawer>.chat-menu>*{flex-shrink:0}
@container conversation (width < 768px){
  .panel.shared-chat[data-drawer-open]>:is(.body,.form,.error,.chat-feedback){visibility:hidden;transition:visibility 0s .18s}
}
@container conversation (width >= 768px){
  .shared-chat .flex-drawer{width:var(--drawer-width);border-inline-start:1px solid var(--b)}
  .shared-chat>:is(.body,.form,.error,.chat-feedback){transition:margin-inline-end .18s ease-out}
  .panel.shared-chat[data-drawer-open]>:is(.body,.form,.error,.chat-feedback){margin-inline-end:var(--drawer-width)}
}

@media(prefers-reduced-motion:reduce){.panel.shared-chat>:is(.body,.form,.error,.chat-feedback){transition:none}}
.shared-chat:not(.flex-chat) .message:not(.own,.tail,[data-grouped=true])::before{content:attr(data-avatar);position:absolute;inset-inline-start:-36px;top:0;width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:var(--s2);color:var(--t);font-weight:600}
.shared-chat .chat-roster small{overflow-wrap:anywhere}
`;
