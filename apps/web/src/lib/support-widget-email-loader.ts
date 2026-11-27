/** Email controls load independently; a failed download cannot block a send. */
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import type { MemberView } from "./support-widget-member";
import type { TailHost } from "./support-widget";
type Module = typeof import("./support-widget-guest");
type Line = [string, unknown[], (node: HTMLElement) => void];
declare const __TEMPL_WIDGET_GUEST__: string | undefined;
let retry = 0;
const load = (): Promise<Module> =>
  (typeof __TEMPL_WIDGET_GUEST__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(
          `${__TEMPL_WIDGET_GUEST__}${retry ? `#email-${retry}` : ""}`,
          import.meta.url,
        ).href
      )
    : import("./support-widget-guest")
  ).catch((error) => {
    retry++;
    throw error;
  });

export function replyEmailLoader(loadModule: () => Promise<Module>) {
  const states = new WeakMap<
    TailHost,
    { scope: string; module?: Module; loading?: boolean; failed?: boolean }
  >();
  return (host: TailHost, view: MemberView): Line[] => {
    const session = host.client.session;
    host.notify = undefined;
    if (
      !host.policy?.replyEmail ||
      host.policy.templLeadCapture ||
      !session ||
      session.expiresAt <= Date.now()
    ) {
      states.delete(host);
      return [];
    }
    const scope = `${host.options.workspace}:${session.principalId}:${session.level}`;
    const desk = host.options.workspace === CRYPTO_SUPPORT_WORKSPACE;
    const technical = desk && view.info?.handoff?.technical === true && view.info.state !== "resolved";
    if (desk && !technical && session.level !== "signed") return [];
    let held = states.get(host);
    if (held?.scope !== scope) {
      held = { scope };
      states.set(host, held);
    }
    if (held.module) {
      const lines = held.module.replyEmail.lines(host, view);
      if (!desk) return lines;
      if (!technical || !lines.length) return [];
      return [["~technical-email", [scope, view.thread], (node) => {
        node.className = "system tail";
        const button = host.el("button", "Tell me by email");
        button.type = "button";
        button.addEventListener("click", () => {
          if (states.get(host) === held && host.thread?.() === view.thread &&
              host.walletCase?.()?.handoff?.technical &&
              host.client.session?.principalId === session.principalId && session.expiresAt > Date.now())
            host.emailButton?.click();
        });
        node.append(button);
      }]];
    }
    if (
      session.level !== "signed" &&
      (!view.info?.handoff ||
        !view.messages.some((message) => host.own(message.author)))
    )
      return [];
    const state = held;
    const start = async () => {
      if (state.loading || states.get(host) !== state) return;
      state.loading = true;
      state.failed = false;
      // This loader can start while the widget is reconciling its nodes.
      queueMicrotask(host.render);
      try {
        const loaded = await loadModule();
        if (states.get(host) === state) {
          state.module = loaded;
          host.guest = loaded.guest;
        }
      } catch {
        if (states.get(host) === state) state.failed = true;
      } finally {
        state.loading = false;
        if (states.get(host) === state) host.render();
      }
    };
    if (session.level === "signed" && host.emailButton) {
      host.emailButton.disabled = !state.failed;
      host.notify = start;
    }
    if (!state.loading && !state.failed) void start();
    if (!state.failed) return [];
    return [
      [
        "~email-load",
        [scope],
        (node) => {
          node.className = "system tail";
          const button = host.el("button", "Retry");
          button.type = "button";
          button.addEventListener("click", () => void start());
          node.append("Email notices could not load.", button);
        },
      ],
    ];
  };
}
export const emailLines = replyEmailLoader(load);
