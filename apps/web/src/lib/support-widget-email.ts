/** Optional reply notices use the current member's existing verification flow. */
import type { MemberView } from "./support-widget-member";
import type { TailHost } from "./support-widget";

type Line = [string, unknown[], (node: HTMLElement) => void];
type Status = { enabled: boolean; pending?: boolean };
type State = {
  scope: string;
  thread: string;
  answers: Map<string, Status | undefined>;
  dismissed: Set<string>;
};
const states = new WeakMap<TailHost, State>();
const scope = (host: TailHost) => {
  const session = host.client.session;
  return host.policy?.replyEmail &&
    !host.policy.templLeadCapture &&
    session &&
    session.expiresAt > Date.now()
    ? `${host.options.workspace}:${session.principalId}:${session.level}`
    : undefined;
};
const call = (host: TailHost, path: string, body?: object) =>
  (
    host.client as unknown as {
      adopt(): readonly [
        unknown,
        (path: string, body?: object) => Promise<unknown>,
      ];
    }
  ).adopt()[1](path, body);

/** Rendering can read preferences. Only a member's click can start opt-in. */
export const replyEmail = {
  lines(host: TailHost, view: MemberView): Line[] {
    const current = scope(host);
    host.notify = undefined;
    if (!current) {
      states.delete(host);
      return [];
    }
    let held = states.get(host);
    if (held?.scope !== current) {
      held = {
        scope: current,
        thread: view.thread,
        answers: new Map(),
        dismissed: new Set(),
      };
      states.set(host, held);
    }
    held.thread = view.thread;
    const state = held;
    const active = () => states.get(host) === state && scope(host) === current;
    const signed = host.client.session?.level === "signed";
    const eligible =
      view.info?.state !== "resolved" &&
      !!view.info?.handoff &&
      view.messages.some((message) => host.own(message.author));
    const key = signed ? "preferences" : view.thread;
    const path = signed
      ? "/conversations/preferences"
      : `/conversations/${view.thread}/guest-email`;
    if (
      signed ||
      (eligible && !host.replyNotices && !state.dismissed.has(key))
    ) {
      if (!state.answers.has(key)) {
        state.answers.set(key, undefined);
        call(host, path).then(
          (answer) => {
            if (!active()) return;
            const value = answer as Status | null;
            if (
              value &&
              typeof value.enabled === "boolean" &&
              (signed || typeof value.pending === "boolean")
            ) {
              state.answers.set(key, value);
              host.render();
            } else state.answers.delete(key);
          },
          () => {
            if (active()) state.answers.delete(key);
          },
        );
      }
    }
    const status = state.answers.get(key);
    if (signed) {
      if (host.emailButton) {
        host.emailButton.disabled = !status;
        host.emailButton.title = status?.enabled
          ? "Email notices are on. Click to turn them off."
          : "Get email notices for this case.";
      }
      host.notify = async () => {
        if (!active() || !status) return;
        if (status.enabled) {
          await call(host, path, { enabled: false });
          if (active()) {
            state.answers.delete(key);
            host.render();
          }
          return;
        }
        const tab = window.open("", "_blank");
        if (tab) tab.opener = null;
        try {
          const { url } = (await call(
            host,
            "/conversations/alert-ticket",
            {},
          )) as { url: string };
          if (!active()) {
            tab?.close();
            return;
          }
          if (!/^https:\/\//.test(url)) throw new Error();
          if (tab) tab.location.href = url;
          else window.open(url, "_blank", "noopener");
        } catch (reason) {
          tab?.close();
          throw reason instanceof Error && reason.message
            ? reason
            : new Error("Email isn't available right now.");
        }
        document.addEventListener(
          "visibilitychange",
          () => {
            if (active()) {
              state.answers.delete(key);
              host.render();
            }
          },
          { once: true },
        );
      };
    }
    const thread = view.thread;
    if (
      !eligible ||
      !status ||
      status.enabled ||
      status.pending ||
      host.replyNotices ||
      state.dismissed.has(thread)
    )
      return [];
    return [
      [
        "~reply-email",
        [current, thread],
        (node) => {
          node.className = "system nudge tail";
          node.append(host.el("p", "Get an email when the team replies."));
          for (const [text, open] of [
            ["Notify me", true],
            ["Not now", false],
          ] as const) {
            const button = host.el("button", text);
            button.type = "button";
            button.addEventListener("click", () => {
              if (!active() || state.thread !== thread) return;
              state.dismissed.add(thread);
              if (open) {
                if (signed) void host.run(host.notify!);
                else host.replyNotices = true;
              }
              host.render();
            });
            node.append(button);
          }
        },
      ],
    ];
  },
};
