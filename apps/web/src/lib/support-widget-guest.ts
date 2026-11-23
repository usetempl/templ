/** A guest's optional reply notices and one-use thread resume link. */
import type {
  SupportWidgetOptions,
  TailHost,
  WidgetSession,
} from "./support-widget";

import { replyEmail } from "./support-widget-email";
export { replyEmail };

type State = { enabled: boolean; pending: boolean };
type Line = [string, unknown[], (node: HTMLElement) => void];
type Client = {
  adopt(
    next?: WidgetSession,
  ): readonly [
    unknown,
    (path: string, body?: object, anonymous?: boolean) => Promise<unknown>,
  ];
};
const client = (host: TailHost) => host.client as unknown as Client;
const statuses = new WeakMap<TailHost, Map<string, State | "error" | null>>();
const watching = new WeakSet<TailHost>();
const resumed = new WeakMap<TailHost, Promise<void>>();

export const guest = {
  resume(host: TailHost) {
    const fragment = host.options.guestLink ?? location.hash;
    const match =
      /^#templ-guest=([0-9a-f-]+)\.(tc-[0-9a-f]{32})\.([0-9a-f]{64})$/.exec(
        fragment,
      );
    if (!match || match[1] !== host.options.workspace || !client(host).adopt)
      return Promise.resolve();
    let flight = resumed.get(host);
    if (!flight) {
      flight = (async () => {
        const [, call] = client(host).adopt();
        const answer = (await call(
          "/auth/guest-link",
          { thread: match[2], token: match[3] },
          true,
        )) as WidgetSession;
        if (
          answer.thread !== match[2] ||
          !answer.credential ||
          answer.level === "signed"
        )
          throw new Error("This link could not open your case.");
        client(host).adopt({ ...answer, address: answer.address ?? "" });
        host.options.guestRestored?.(fragment);
        if (location.hash === fragment)
          history.replaceState(
            history.state,
            "",
            location.pathname + location.search,
          );
      })();
      resumed.set(host, flight);
      void flight.catch(() => {
        if (resumed.get(host) === flight) resumed.delete(host);
      });
    }
    return flight;
  },
  lines(host: TailHost, thread: string): Line[] {
    if (
      !host.policy?.replyEmail ||
      host.client.session?.level === "signed" ||
      !client(host).adopt
    )
      return [];
    const [, call] = client(host).adopt();
    let states = statuses.get(host);
    if (!states) statuses.set(host, (states = new Map()));
    const path = `/conversations/${thread}/guest-email`;
    if (!states.has(thread)) {
      states.set(thread, null);
      call(path).then(
        (answer) => {
          states!.set(thread, answer as State);
          host.render();
        },
        () => {
          states!.set(thread, "error");
          host.render();
        },
      );
    }
    const state = states.get(thread);
    if (state && state !== "error" && state.pending && !watching.has(host)) {
      watching.add(host);
      window.addEventListener(
        "focus",
        () => {
          watching.delete(host);
          states!.delete(thread);
          host.render();
        },
        { once: true },
      );
    }
    return [
      [
        "~guest-email",
        [thread, state && state !== "error" ? [state.enabled, state.pending].join() : state],
        (node) => {
          const { el } = host;
          node.className = "system nudge tail";
          const submit = (text: string, body: () => object) => {
            const button = el("button", text);
            button.type = "button";
            button.addEventListener(
              "click",
              () =>
                void host.run(async () => {
                  button.disabled = true;
                  try {
                    states!.set(thread, (await call(path, body())) as State);
                    host.render();
                  } finally {
                    button.disabled = false;
                  }
                }),
            );
            return button;
          };
          const cancel = el("button", "Cancel");
          cancel.type = "button";
          cancel.addEventListener("click", () => replyEmail.dismiss(host, thread));
          if (!state || state === "error") {
            node.append(el("p", state === "error" ? "Couldn’t load email settings." : "Loading email settings…"));
            if (state === "error") {
              const retry = el("button", "Retry");
              retry.type = "button";
              retry.onclick = () => { states!.delete(thread); host.render(); };
              node.append(retry);
            }
          } else if (state.enabled) {
            node.append(
              el("p", "Email notices: on"),
              submit("Turn off email notices", () => ({ enabled: false })),
            );
          } else if (state.pending) {
            node.append(
              el("p", "Open the link in your email to turn notices on."),
              submit("Turn off email notices", () => ({ enabled: false })),
            );
          } else {
            const form = el("form");
            const label = el("label", "Email address");
            const input = el("input");
            input.type = "email";
            input.autocomplete = "email";
            input.required = true;
            label.append(input);
            const button = el("button", "Send confirmation link");
            button.type = "submit";
            form.append(label, button);
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              if (!form.reportValidity()) return;
              void host.run(async () => {
                button.disabled = true;
                try {
                  states!.set(
                    thread,
                    (await call(path, {
                      email: input.value.trim(),
                      path: host.options.guestPath ?? location.pathname,
                    })) as State,
                  );
                  host.render();
                } finally {
                  button.disabled = false;
                }
              });
            });
            node.append(
              el("p", "Get an email when the team replies."),
              el(
                "p",
                "Only for reply notices. The team won't see this address.",
              ),
              form,
            );
          }
          node.append(cancel);
        },
      ],
    ];
  },
};

/** @public Frame page state shares this lazy chunk with guest notices. */
export function framePage(workspace: string) {
  let held = false;
  let sentFragment: string | undefined;
  try {
    for (const key of ["tab", "keep"])
      sessionStorage.removeItem(`templ:support-${key}:v1:${workspace}`);
    for (const key of ["member", "wait"])
      localStorage.removeItem(`templ:support-${key}:v1:${workspace}`);
    held = Object.keys(localStorage).some(
      (key) =>
        key === `templ:support-guest:v1:${workspace}` ||
        key.startsWith(
          `templ:support-draft:v1:${location.origin}:${workspace}:`,
        ),
    );
  } catch {
    /* Storage is optional. */
  }
  return {
    held,
    restored(fragment: unknown) {
      if (
        sentFragment &&
        fragment === sentFragment &&
        location.hash === sentFragment
      ) {
        history.replaceState(
          history.state,
          "",
          location.pathname + location.search,
        );
        sentFragment = undefined;
      }
    },
    display(options: SupportWidgetOptions) {
      const appearance = options.appearance ?? {};
      let logo: string | undefined;
      try {
        const url = new URL(appearance.logo ?? "", location.href);
        if (
          appearance.logo?.trim() &&
          url.protocol === "https:" &&
          !(
            url.origin === location.origin && url.pathname === location.pathname
          )
        )
          logo = url.href;
      } catch {
        /* No logo. */
      }
      sentFragment = location.hash.startsWith(`#templ-guest=${workspace}.`)
        ? location.hash
        : undefined;
      return JSON.parse(
        JSON.stringify({
          fullPage: !!options.container,
          guestLink: sentFragment,
          guestPath: location.pathname,
          label: options.label,
          appearance: {
            theme: appearance.theme,
            accent: appearance.accent,
            radius: appearance.radius,
            position: appearance.position,
            logo,
            font: appearance.font,
            colors: appearance.colors,
            headerNotice: appearance.headerNotice,
          },
          chatFirst: options.chatFirst,
          prompts: options.prompts,
          intro: options.intro,
          transactionField: options.transactionField,
          persistDrafts: options.persistDrafts,
          context: options.context,
        }),
      );
    },
  };
}
