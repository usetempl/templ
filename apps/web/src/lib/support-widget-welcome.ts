import type { SupportWidgetOptions, TailHost } from "./support-widget";
import {
  SUPPORT_IDENTITY_LABELS,
  identityOf,
} from "@templ/chat/support-identity";
declare const __TEMPL_WIDGET_CONVERSATION__: string | undefined;
let conversation: typeof import("./support-widget-chat-first") | undefined;
let conversationLoad: Promise<void> | undefined;
let conversationFailed = false;
const loadConversation = () => typeof __TEMPL_WIDGET_CONVERSATION__ === "string"
  ? import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(__TEMPL_WIDGET_CONVERSATION__, import.meta.url).href)
  : import("./support-widget-chat-first");
const WELCOME_STYLE =
  ".welcome h2{margin:0;font-size:23px;font-weight:720;line-height:1.2}.lede{color:var(--m)}.trust{display:grid;gap:10px;margin:0;padding:14px;list-style:none;border:1px solid var(--b);border-radius:16px;background:var(--s)}.trust li{display:flex;gap:10px;font-size:13px;line-height:1.45}.trust span{color:var(--m)}.tick{display:grid;place-items:center;width:20px;height:20px;flex:none;border-radius:7px;background:var(--s2);color:var(--t)}.tick svg{width:13px;height:13px;stroke-width:3}";
/** @public Entry exported by the immutable widget chunk. */
export const welcome = {
  starter(node: HTMLElement, intro: SupportWidgetOptions["intro"]) {
    const title =
      typeof intro?.title === "string" && intro.title.trim()
        ? intro.title.trim().slice(0, 80)
        : null;
    const strong = document.createElement("strong");
    strong.textContent = title ?? "How can we help?";
    node.prepend(
      strong,
      document.createTextNode(
        title
          ? typeof intro?.text === "string"
            ? intro.text.trim().slice(0, 200)
            : ""
          : "Ask a question or describe an issue.",
      ),
    );
  },
  questions(
    host: TailHost,
    node: HTMLElement,
    starter: HTMLElement,
    visible: boolean,
    disabled: boolean,
    select: (text: string) => void,
    warm: () => void,
  ) {
    // A saved empty list hides host questions. An absent override keeps them.
    const source = host.policy?.prompts ?? host.options.prompts;
    const prompts = (Array.isArray(source) ? source : [])
      .filter((text) => typeof text === "string" && text.trim())
      .map((text) => [...text.trim()].slice(0, 80).join(""))
      .slice(0, 4);
    const signature = JSON.stringify(prompts);
    if (node.dataset.prompts !== signature) {
      node.dataset.prompts = signature;
      node.setAttribute("role", "group");
      node.setAttribute("aria-label", "Common questions");
      node.replaceChildren();
      for (const text of prompts) {
        const button = host.el("button", text);
        button.type = "button";
        button.addEventListener("click", () => {
          if (!button.disabled) select(text);
        });
        for (const type of ["pointerenter", "pointerdown", "focus"])
          button.addEventListener(type, warm);
        node.append(button);
      }
    }
    for (const button of node.querySelectorAll("button"))
      button.disabled = disabled;
    node.hidden = !visible || !prompts.length;
    const hours = host.policy?.replyHours;
    let line =
      starter.querySelector<HTMLElement>(".reply-time") ??
      host.welcome.querySelector<HTMLElement>(".reply-time");
    if (Number.isInteger(hours) && hours! >= 1 && hours! <= 168) {
      if (!line) line = host.el("p", undefined, "reply-time");
      const intro = host.welcome.hidden ? starter : host.welcome;
      if (line.parentElement !== intro) intro.append(line);
      line.textContent = `We usually reply within ${hours} ${hours === 1 ? "hour" : "hours"}.`;
    } else line?.remove();
  },
  fullPage(style: HTMLStyleElement) {
    style.textContent +=
      ":host{display:block;height:100%;width:100%}.panel,:host([data-position=left]) .panel{position:relative;inset:auto;width:100%;height:100%;border:0;border-radius:0;box-shadow:none}";
  },
  firstOpen(
    host: TailHost,
    parent: HTMLElement,
    handedOff: boolean,
    thread: string | null,
    busy = false,
  ) {
    if (!host.firstPerson) {
      const button = (host.firstPerson = host.el(
        "button",
        "Talk to a person",
        "quiet",
      ));
      button.type = "button";
      button.addEventListener("click", () => {
        if (host.thread?.() && host.talk) {
          host.talk();
          return;
        }
        void host.run(async () => {
          await host.client.guest?.();
          await host.client.askPerson?.(host.thread?.() ?? thread ?? undefined);
          await host.refresh(true);
        });
      });
      parent.prepend(button);
    }
    host.firstPerson.hidden =
      !host.client.askPerson || host.policy?.askPerson === false;
    host.firstPerson.disabled =
      handedOff ||
      !!host.held?.by ||
      (host.options.chatFirst === true &&
        host.policy?.chatFirst === true &&
        busy);
    host.firstPerson.textContent = handedOff
      ? "Waiting for the team"
      : "Talk to a person";
    if (host.options.chatFirst === true && host.policy?.chatFirst === true && !conversation && !conversationFailed) {
      conversationLoad ??= loadConversation().then(module => {conversation = module;}, () => {conversationFailed = true;});
      void conversationLoad.then(() => host.render()); return;
    }
    if (conversation?.chatFirstControls(host, parent, handedOff || !!host.held?.by, busy)) return;
    for (const [i, button] of [
      ...parent.querySelectorAll<HTMLButtonElement>("button"),
    ].entries()) {
      const label = button.textContent ?? "";
      button.setAttribute("aria-label", label);
      if (button !== host.emailButton) button.title = label;
      const mark = host.icon(i === 1 ? "wallet" : "chat");
      if (i !== 1)
        mark
          .querySelector("path")!
          .setAttribute(
            "d",
            i === 0
              ? "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"
              : "M4 5h16v14H4zM4 5l8 7 8-7",
          );
      button.replaceChildren(mark, host.el("span", label, "sr"));
    }
  },
  /** The welcome block's words above its sign-in button: "How can we
   * help?" with the three trust points, or the Sign in again card. */
  welcome(host: TailHost, renew: boolean) {
    const { el } = host;
    const client = host.client as {
      adopt?(): readonly [
        unknown,
        unknown,
        () => Promise<{ steps(host: TailHost): void }>,
      ];
    };
    const canSignIn = host.client.canSignIn ?? host.client.hasWallet;
    host.signIn.hidden = canSignIn === false;
    if (canSignIn)
      void client
        .adopt?.()[2]()
        .then(
          (kit) => kit.steps(host),
          () => {},
        );
    if (!host.words) {
      host.style.textContent += WELCOME_STYLE;
      const trust = el("ul", undefined, "trust");
      for (const [strong, rest] of [
        [
          "Private.",
          ` Only you, any AI agent the team adds and ${host.options.label ? `${host.options.label}'s` : "the app's"} support team, including people who answer for them, can read this chat.`,
        ],
        ["No transaction.", " Signing in is free and can’t move funds."],
        ["Return with this wallet.", " Sign in again to see replies."],
      ]) {
        const item = el("li");
        const tick = el("span", undefined, "tick");
        tick.append(host.icon("check"));
        const text = el("div");
        text.append(document.createTextNode(strong), el("span", rest));
        item.append(tick, text);
        trust.append(item);
      }
      host.words = [el("h2"), el("p", undefined, "lede"), trust];
      host.welcome.prepend(...host.words);
    }
    const [heading, lede, trust] = host.words;
    heading.textContent = renew ? "Sign in again" : "How can we help?";
    lede.textContent = renew
      ? "Sign-ins last 1 hour. Your draft stays here."
      : "Sign in with your wallet to start a private chat. The team will see your verified wallet.";
    trust.hidden = renew;
    if (!host.fallback) {
      const fallback = (host.fallback = el(
        "button",
        "Can't connect your wallet? Ask without it",
        "quiet",
      ));
      fallback.type = "button";
      fallback.addEventListener(
        "click",
        () =>
          void host.run(async () => {
            await host.client.guest?.(false, false, undefined, true);
            await host.refresh(true);
            host.draft.focus();
          }),
      );
      host.welcome.append(fallback);
    }
    host.fallback.hidden =
      renew ||
      !host.policy ||
      host.policy.walletFallback === false ||
      host.policy.minimumLevel === "anyone";
  },
  identity(node: HTMLElement, session: TailHost["client"]["session"]) {
    node.dataset.level = session?.level ?? "";
    const label = session
      ? SUPPORT_IDENTITY_LABELS[
          identityOf({
            level: session.level ?? "anonymous",
            wallet: session.address,
          })
        ]
      : "Private chat";
    node.replaceChildren();
    if (session?.address) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = session.level === "signed" ? "Verified" : label;
      node.append(
        `${session.address.slice(0, 6)}…${session.address.slice(-4)}`,
        " ",
        tag,
      );
    } else node.textContent = label;
  },
};
