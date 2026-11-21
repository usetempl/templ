export const CONVERSATION_STYLE = `
.chat-avatars i img,.chat-roster i img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.chat-people{flex:1;min-width:0}
.chat-people>summary,.chat-options>summary{display:flex;align-items:center;min-height:44px;cursor:pointer;list-style:none}
.chat-people>summary{gap:8px;border-radius:var(--rc)}
.chat-people>summary::-webkit-details-marker,.chat-options>summary::-webkit-details-marker{display:none}
.chat-avatars{display:flex;flex:none;padding-left:4px}
.chat-avatars i{display:grid;place-items:center;width:24px;height:24px;margin-left:-4px;border:1px solid var(--bg);border-radius:50%;background:var(--s);font-style:normal;font-size:9px;font-weight:600}
.chat-options>summary{justify-content:center;padding:0 8px;border-radius:var(--rc);font-size:13px;color:var(--m)}
.chat-options>summary:hover,.chat-options[open]>summary,.chat-people>summary:hover{background:var(--s)}
.chat-menu,.chat-people-menu{position:absolute;right:8px;top:100%;width:264px;max-width:calc(100% - 16px);max-height:calc(100dvh - 90px);overflow:auto;z-index:5;padding:8px;background:var(--bg);border:1px solid var(--b);border-radius:12px;box-shadow:0 8px 24px var(--shc);display:grid;gap:4px}
.chat-menu .tools{display:grid;gap:0}
.chat-menu .tools button,.chat-menu>button,.chat-people-menu>button{display:block;width:100%;min-height:44px;margin:0;padding:10px 12px;text-align:left;border-radius:8px;font-size:14px;font-weight:400}
.chat-menu button:hover:not(:disabled),.chat-people-menu button:hover{background:var(--s)}
.chat-menu>a{display:flex;align-items:center;min-height:44px;padding:0 12px;color:var(--t);font-size:14px}
.chat-menu .tools[hidden],.chat-menu .tools button[hidden],.member-conversations[hidden]{display:none}
.member-conversations{display:grid;gap:4px}
.member-conversations strong,.member-conversations p{padding:4px 12px;margin:0;font-size:13px}
.member-conversations button:not([hidden]){display:block;width:100%;min-height:44px;padding:8px 12px;text-align:left;border-radius:8px}
.member-conversations button[aria-current]{background:var(--s)}
.chat-options [data-unread]::after{content:"";display:inline-block;width:7px;height:7px;margin-left:7px;border-radius:50%;background:var(--af);vertical-align:middle}
.chat-menu .options-note,.chat-people-menu>.sub{font-size:12px;color:var(--m);padding:8px 12px;white-space:normal}
.chat-feedback{padding:6px 12px;font-size:12px;color:var(--m);background:var(--s)}
.chat-roster{display:grid;padding:4px 8px}
.chat-roster div{display:flex;align-items:center;gap:12px;min-height:52px}
.chat-roster i{font-style:normal;display:grid;place-items:center;flex:0 0 36px;height:36px;border-radius:50%;background:var(--s);font-size:12px}
.chat-roster b,.chat-roster small{display:block;font-size:14px;font-weight:500}
.chat-roster small{font-size:12px;color:var(--m);font-weight:400}
.conversation-chat .head{position:relative;background:var(--bg);gap:6px;padding:8px 12px;min-height:56px}
.conversation-chat .titles strong{font-size:15px;font-weight:600}
.conversation-chat .avatar{width:36px;height:36px;border-radius:50%}
.conversation-chat .avatar.logo{border-radius:0;background:transparent}
.conversation-chat .body{background:color-mix(in srgb,var(--s) 65%,var(--bg));padding:10px 12px 16px}
.conversation-chat .body>.safety,.conversation-chat .starter,.conversation-chat .suggestions,.conversation-chat .tail[data-state=hatch]{display:none}
.conversation-chat .messages{gap:10px}
.conversation-chat .message{padding:8px 11px 5px;border-radius:14px 14px 14px 4px;background:var(--bg);box-shadow:0 1px 1px var(--shc);font-size:14px;font-weight:400;line-height:1.45;letter-spacing:normal}
.conversation-chat .message.own{border-radius:14px 14px 4px 14px;background:var(--s2);box-shadow:none}
.conversation-chat .message.own[data-grouped=true]{margin-top:-7px;border-top-right-radius:5px}
.conversation-chat .message time{font-size:10px;line-height:1.2;margin-top:3px}
.conversation-chat .message.own time{display:flex;align-items:center;justify-content:flex-end;gap:4px}
.conversation-chat .own[data-client-id] time::after{content:none}
.delivery-status{font-size:12px;line-height:1}
.delivery-clock{position:relative;align-self:center;width:12px;height:12px;border:1px solid currentColor;border-radius:50%}
.delivery-clock::after{content:"";position:absolute;top:2px;left:4px;width:2px;height:3px;border-left:1px solid;border-bottom:1px solid}
.conversation-chat .state button{min-height:36px;padding:0 4px}
.conversation-chat .composer{padding:0;align-items:flex-end;background:none;border:0;overflow:visible}
.conversation-chat .composer textarea{padding:11px 16px;background:var(--s);border-radius:22px;font-size:16px;line-height:22px}
.conversation-chat .composer textarea:focus-visible{outline:2px solid var(--af);outline-offset:-2px}
.conversation-chat .form{display:grid;padding:5px 10px max(8px,env(safe-area-inset-bottom))}
.conversation-chat .form>p.muted{order:-1}
.conversation-chat .send{border-radius:50%}
.conversation-chat .send[aria-busy=true] svg{animation:none}
.conversation-chat .chat-empty{text-align:center;color:var(--m);font-size:13px;padding:28px 0 12px}
.conversation-chat .chat-empty p{max-width:36ch;margin:6px auto 0}
.chat-day{align-self:center;margin:6px 0;color:var(--m);font-size:12px;font-weight:500;line-height:1.4;text-align:center}
.conversation-drawers{container:conversation / inline-size}
.conversation-drawers .head{position:static}
.conversation-drawers .chat-people{flex:none}
.conversation-drawers .chat-people-menu{top:56px}
.conversation-drawers .return-case{display:none}
.chat-history>summary{display:grid;place-items:center;list-style:none;min-width:38px;min-height:44px;border-radius:var(--rc);cursor:pointer}
.chat-history>summary::-webkit-details-marker{display:none}
.chat-history>summary:hover,.chat-history[open]>summary{background:var(--s)}
.chat-history [data-unread]::after{content:"";width:7px;height:7px;border-radius:50%;background:var(--af)}
.conversation-drawers :is(.chat-options,.chat-history)[open]>summary{position:relative;z-index:7;background:var(--s)}
.conversation-drawers :is(.chat-menu,.chat-history .member-conversations){position:absolute;inset:0;width:auto;max-width:none;max-height:none;align-content:start;padding:56px 12px 12px;border:0;border-radius:0;overflow:auto;overscroll-behavior:contain;background:var(--bg);box-shadow:none;z-index:6;animation:conversation-drawer .18s ease-out both;--drawer-shift:100%}
.conversation-drawers .chat-history .member-conversations{--drawer-shift:-100%}
.conversation-drawers .chat-menu .tools button:not([hidden]){display:flex;align-items:center;gap:10px}
.conversation-drawers .chat-menu .tools svg{width:18px;height:18px;flex:none}
@keyframes conversation-drawer{from{transform:translateX(var(--drawer-shift))}to{transform:translateX(0)}}
@media(prefers-reduced-motion:reduce){.conversation-drawers :is(.chat-menu,.chat-history .member-conversations){animation:none}}
@container conversation (width < 768px){
  .conversation-drawers:has(.chat-options[open],.chat-history[open])>:is(.body,.form,.error,.chat-feedback){visibility:hidden}
}
@container conversation (width >= 768px){
  .conversation-drawers:has(.chat-options[open])>:is(.head,.body,.form){margin-inline-end:24rem}
  .conversation-drawers:has(.chat-history[open])>:is(.head,.body,.form){margin-inline-start:24rem}
  .conversation-drawers .chat-menu{inset:0 0 0 auto;width:24rem;padding-top:12px;border-left:1px solid var(--b)}
  .conversation-drawers .chat-history .member-conversations{inset:0 auto 0 0;width:24rem;padding-top:12px;border-right:1px solid var(--b)}
}
`;
