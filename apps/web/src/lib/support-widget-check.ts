/** "Check my install": the six checks a manager runs on their own site from
 * the Widget tab. Loaded by the ops chunk only for `#templ-check=<token>`.
 * Results hold fixed ids, times and pass or fail; no page text leaves the
 * page. */
import { widgetMessageId } from "./support-widget-message-id";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import type { SupportContextInput } from "@templ/chat/support";
import type { InstallCheckId, InstallCheckRecord } from "@templ/chat/support-install-check";
import type { SupportClient, WidgetSession } from "./support-widget";

export type CheckHost = {
  client: SupportClient;
  form: HTMLFormElement;
  draft: HTMLTextAreaElement;
  /** The chat's thread, once it has one. */
  thread(): string | null;
  /** What the page passed to setContext. */
  offered(): SupportContextInput | undefined;
  refresh(): Promise<unknown>;
  /** The widget's public calls, which the check wraps while it runs. */
  api: { open(): void; close(): void; captureFailure(input: SupportContextInput): Promise<unknown> };
};
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
};
/** App values long enough to be the page's own words (an error message, a
 * product label), not a one-word action or failure kind. */
const appText = (value: unknown): string[] =>
  typeof value === "string"
    ? value.length >= 8 ? [value] : []
    : value && typeof value === "object"
      ? Object.values(value).flatMap(appText)
      : [];
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function check(host: CheckHost) {
  let ended = false;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const id = setTimeout(() => {
        timers.delete(id);
        resolve();
      }, ms);
      timers.set(id, resolve);
    });
  const until = async (done: () => boolean, minutes: number) => {
    const deadline = Date.now() + minutes * 60_000;
    while (!done() && !ended && Date.now() < deadline) await wait(FEATURE_LIMITS.installCheckPollMs);
    return done();
  };
  const cleanups = new Set<() => void>();
  const status = element("p");
  status.setAttribute("role", "status");
  host.form.before(status);
  const say = (text: string) => {
    status.textContent = text;
  };
  const call = <T>(path: string, body?: object) => host.client.adopt()[1]<T>(path, body);
  const readWallet = () =>
    host.client.hasWallet
      ? host.client.adopt()[2]().then((kit) => kit.read()).catch(() => undefined)
      : Promise.resolve(undefined);

  /** A session that meets the workspace's minimum: a new guest where guests
   * may write, else the manager's own wallet sign-in in this chat. Returns
   * the level Templ labeled it with. */
  async function start(wallet: Awaited<ReturnType<typeof readWallet>>) {
    const policy = await host.client.policy?.();
    if (policy?.minimumLevel !== "signed")
      try {
        const guest = await host.client.adopt()[1]<WidgetSession>("/auth/guest", wallet ? { wallet } : {}, true);
        host.client.adopt({ ...guest, address: wallet?.address ?? "", chainId: wallet?.chainId }, true);
        return guest.level;
      } catch (error) {
        if ((error as { reason?: string }).reason !== "access-level-required") throw error;
      }
    if (host.client.session?.level !== "signed") {
      say("This workspace needs a wallet sign-in. Sign in with your wallet in this chat to run the check.");
      if (!(await until(() => host.client.session?.level === "signed", FEATURE_LIMITS.installCheckRunMinutes)))
        throw new Error("sign-in");
    }
    return "signed";
  }

  const show = host.api.open;
  async function install(token: string) {
    show();
    say("Checking your install…");
    const wallet = await readWallet();
    const level = await start(wallet);
    const started = await call<{ check: InstallCheckRecord }>("/install-check", { token });
    history.replaceState(history.state, "", location.pathname + location.search);
    const run = started.check.id;
    const result = async (id: InstallCheckId, pass: boolean) => {
      if (!ended) await call("/install-check", { run, result: { id, at: Date.now(), pass } });
    };

    // 1. The page calls captureFailure with the failure and the action.
    const api = host.api, original = api.captureFailure;
    let received = false;
    const capture = (input: SupportContextInput) => {
      if (input?.app?.failure?.kind && input.app.action) received = true;
      return original(input);
    };
    api.captureFailure = capture;
    const restoreCapture = () => {
      if (api.captureFailure === capture) api.captureFailure = original;
    };
    cleanups.add(restoreCapture);
    say("Now make the action fail on your page, such as a rejected deposit.");
    await until(() => received, FEATURE_LIMITS.installCheckActionMinutes);
    restoreCapture();
    cleanups.delete(restoreCapture);
    if (ended) return;
    await result("context", received);

    // 3. Templ labels the session from the wallet the page passed: Attached
    // (connected) until the user signs in, None without one, and Verified
    // only for a wallet signature from that same wallet.
    const now = await readWallet();
    const session = host.client.session;
    await result(
      "identity",
      level === "signed"
        ? session?.level === "signed" && (!now || same(session.address, now.address))
        : wallet
          ? level === "connected" && same(now?.address, wallet.address)
          : level === "anonymous",
    );

    // 4. A team reply to the preview returns to this chat.
    // A new guest opens an install preview. A signed manager who already
    // has a chat writes in it: their own messages are a staff preview.
    const text = "Install preview. Please reply here to check that the reply returns to this chat.";
    type Sent = { conversation: { id: string }; message?: { id?: string; sharedDetails?: unknown } };
    const sent = await call<Sent>("/conversations/ask", { text, clientId: widgetMessageId(), installCheck: run }).catch(async (error) => {
      const own = level === "signed" && (host.thread() ?? (await host.client.status()).mine);
      if ((error as { reason?: string }).reason !== "install-preview-existing" || !own) throw error;
      return host.client.reply(own, text) as Promise<Sent>;
    });
    const thread = sent.conversation.id, after = Number(sent.message?.id ?? 0);
    await host.refresh();
    say("Reply to the install preview from your inbox. This page is waiting for that reply.");
    let returned = false;
    const poll = async () => {
      const deadline = Date.now() + FEATURE_LIMITS.installCheckRunMinutes * 60_000;
      while (!ended && Date.now() < deadline) {
        const page = await host.client.messages(thread);
        returned = page.messages.some(
          (message) =>
            Number(message.id) > after &&
            message.author !== host.client.session?.principalId &&
            !page.authors?.[message.author]?.badges?.includes("bot") &&
            !!message.clientId,
        );
        if (returned) return;
        await wait(FEATURE_LIMITS.installCheckPollMs);
      }
    };
    await poll();
    if (ended) return;
    await result("reply", returned);

    // 2. Checked failure fields remain local until an explicit send.
    // The server's preview message must contain no shared app details.
    await result(
      "consent",
      sent.message?.sharedDetails === undefined && !appText(host.offered()?.app).some((value) => host.draft.value.includes(value)),
    );

    // 5. Templ refuses a recognized key, and the widget logs none of it.
    const fixture = "ab".repeat(32);
    let leaked = false, refused = false;
    const restores = (["log", "info", "warn", "error", "debug"] as const).map((key) => {
      const original = console[key];
      console[key] = (...args: unknown[]) => {
        if (args.some((value) => {
          try {
            return String(value).includes(fixture) || JSON.stringify(value)?.includes(fixture);
          } catch {
            return false;
          }
        })) leaked = true;
        else original(...args);
      };
      return () => {
        console[key] = original;
      };
    });
    try {
      await host.client.reply(thread, "private key: " + fixture);
    } catch (error) {
      refused = (error as { reason?: string }).reason === "secret-refused";
    } finally {
      restores.forEach((restore) => restore());
    }
    await result("secrets", refused && !leaked);

    // 6. Support fails on purpose while the manager uses the page: the
    // widget's open call throws, as it would if Templ were down.
    const begin = element("button", "Start the outage check");
    begin.type = "button";
    begin.onclick = () => {
      begin.remove();
      void outage(result).catch(failed);
    };
    say("Last step: support acts as if Templ is down. This chat closes. Click your page's own Help button, then use your page as usual.");
    status.append(" ", begin);
  }

  async function outage(result: (id: InstallCheckId, pass: boolean) => Promise<void>) {
    const api = host.api, open = api.open;
    let tries = 0, uncaught = false;
    const noted = () => {
      uncaught = true;
    };
    addEventListener("error", noted);
    addEventListener("unhandledrejection", noted);
    api.open = () => {
      tries++;
      throw new Error("Support is unavailable. Try again.");
    };
    const restore = () => {
      if (api.open !== open) api.open = open;
      removeEventListener("error", noted);
      removeEventListener("unhandledrejection", noted);
    };
    cleanups.add(restore);
    api.close();
    await until(() => tries > 0, FEATURE_LIMITS.installCheckActionMinutes);
    // The page's own error handling runs after the failed call.
    await wait(FEATURE_LIMITS.installCheckOutageSeconds * 1000);
    restore();
    cleanups.delete(restore);
    if (ended) return;
    show();
    if (!tries) {
      await result("outage", false);
      return say("The Help button never opened support during the check. Start it again from the Widget tab.");
    }
    say("Did your page keep working while support was down?");
    for (const [label, works] of [["My page still works", true], ["My page broke", false]] as const) {
      const answer = element("button", label);
      answer.type = "button";
      answer.onclick = () =>
        void result("outage", works && !uncaught).then(
          () => say("Install check saved."),
          () => say("The install check could not be saved. Start it again from the Widget tab."),
        );
      status.append(" ", answer);
    }
  }

  const failed = () => say("The install check could not finish. Start it again from the Widget tab.");
  const token = new URLSearchParams(location.hash.slice(1)).get("templ-check");
  if (token) void install(token).catch(failed);
  return {
    /** Stops the check's waits and restores the calls it wrapped. */
    destroy() {
      ended = true;
      for (const [timer, resolve] of timers) {
        clearTimeout(timer);
        resolve();
      }
      for (const cleanup of cleanups) cleanup();
      status.remove();
    },
  };
}
