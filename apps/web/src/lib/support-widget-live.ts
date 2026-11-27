/** The widget's `live` chunk (GUEST-RESUME-RELOAD, R2A-REMEMBERED-SIGNIN,
 * R2A-MEMBER-REALTIME, TURNSTILE-GUEST). The published file loads it for a
 * returning guest or a page with a wallet, and otherwise when the chat
 * opens; never in the landing demo. It keeps:
 *
 * - this tab's session in `sessionStorage`, so a reload inside the hour
 *   asks the service for nothing. A guest's entry is used only with the
 *   guest credential it came from; a signed one only with the remembered
 *   sign-in for the same wallet, and only while the page's wallet shows it;
 * - one number in `localStorage`: until when a closed widget checks for
 *   replies after a reload (at most a day; no message text);
 * - the remembered sign-in: while the page's wallet shows the same address,
 *   it trades the stored key for a one-hour session, asking the wallet for
 *   nothing but its account;
 * - one socket to the service while the chat is open or the visitor waits.
 *   It carries only a signal that the thread changed; the chat then reads
 *   the thread the way it always does, and nothing in a frame is shown;
 * - the workspace's visitor check for a new guest, from its own chunk.
 *
 * Every storage call may throw (private mode, blocked storage); the chat
 * then works as it does without this chunk. Nothing here grants or widens
 * access: every read and write still goes through the service's checks for
 * the website and workspace. */
import type {
  SupportClient,
  SupportSelectedWallet,
  WidgetSession,
  TailHost,
} from "./support-widget";

/** The rendered widget's side: with no argument, whether the panel is open
 * or the visitor waits on the team; with 1, mark the visitor waiting and
 * read the thread now (a socket signal, or the dot after a reload). */
export type LivePulse = (wake?: 1) => unknown;
type Entry = { c: string; a: string; n: "evm" | "solana"; x: number };
type Cached = {
  t: string;
  p: string;
  e: number;
  l: WidgetSession["level"];
  a: string;
  c?: number;
  s?: string[];
  h?: string;
  g: string;
};
type Page = {
  messages: { author: string; createdAt?: string }[];
  conversation?: { handoff?: unknown; formerMembers?: string[] };
};

const DAY = 86_400_000;
const REMEMBERED = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
const local = () => localStorage;
const tab = () => sessionStorage;
function read(store: () => Storage, key: string) {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}
function write(store: () => Storage, key: string, value?: string) {
  try {
    if (value) store().setItem(key, value);
    else store().removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}
function parsed<T>(text: string | null): T | null {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const failed = (reason: unknown) =>
  reason as { status?: number; reason?: string };
/* The visitor check's frame, in its own chunk, loaded only for a new guest
 * of a workspace that turned the check on. */
declare const __TEMPL_WIDGET_TURNSTILE__: string | undefined;
const loadCheck = (): Promise<typeof import("./support-widget-turnstile")> =>
  typeof __TEMPL_WIDGET_TURNSTILE__ == "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(__TEMPL_WIDGET_TURNSTILE__, import.meta.url).href
      )
    : import("./support-widget-turnstile");
declare const __TEMPL_WIDGET_ENCRYPTED__: string | undefined;
const loadEncrypted = (): Promise<
  typeof import("./support-widget-encrypted")
> =>
  typeof __TEMPL_WIDGET_ENCRYPTED__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_ENCRYPTED__,
          import.meta.url,
        ).href
      )
    : import("./support-widget-encrypted");

const caseActions = new WeakMap<
  TailHost["client"],
  ReturnType<typeof import("./support-widget-encrypted").route>
>();

/** @public Lazy chunk entry: the widget loader calls it through the dynamic
 * import above, which the dead-code check cannot follow. */
export async function live(
  client: SupportClient,
  pulse: LivePulse,
  form?: HTMLElement,
  routing?: typeof import("./support-widget-encrypted"),
  openingPolicy?: Promise<object>,
) {
  const encrypted = form && (routing ?? await loadEncrypted());
  const [, call, kit, base, origin] = client.adopt();
  const ws = base.slice(base.lastIndexOf("/") + 1);
  const api = new URL(base);
  const current = () => client.adopt()[0];
  const keys = {
    guest: `templ:support-guest:v1:${ws}`,
    member: `templ:support-member:v1:${ws}`,
    wait: `templ:support-wait:v1:${ws}`,
    tab: `templ:support-tab:v1:${ws}`,
    keep: `templ:support-keep:v1:${ws}`,
  };
  const wake = () => void pulse(1);
  // Wallet sign-ins from the widget rendered in this tab ask to stay signed
  // in; a headless client never does.
  write(tab, keys.keep, "1");

  /** The remembered sign-in, read fresh each time so tabs share rotations. */
  function member(): Entry | null {
    const entry = parsed<Entry>(read(local, keys.member));
    if (
      entry &&
      REMEMBERED.test(entry.c) &&
      typeof entry.a == "string" &&
      (entry.n == "evm" || entry.n == "solana") &&
      entry.x > Date.now()
    )
      return entry;
    if (entry) write(local, keys.member);
    return null;
  }
  /** The last 8 hex of the guest credential, or of the family id. */
  const guestTag = () => (read(local, keys.guest) ?? "").slice(56);
  const familyTag = (entry: Entry) => entry.c.slice(24, 32);

  /* This tab's session                                                */
  function cache() {
    const session = current();
    const entry = member();
    const tag = !session
      ? ""
      : session.level == "signed"
        ? entry && entry.a == session.address
          ? familyTag(entry)
          : ""
        : guestTag();
    if (!session || !tag || session.expiresAt <= Date.now() + 5000)
      return write(tab, keys.tab);
    write(
      tab,
      keys.tab,
      JSON.stringify({
        t: session.token,
        p: session.principalId,
        e: session.expiresAt,
        l: session.level,
        a: session.address,
        c: session.chainId,
        s: session.servicePrincipals,
        h: session.thread,
        g: tag,
      } satisfies Cached),
    );
  }
  /** The page's wallet as it reports itself now, retried for up to 3 s
   * while the app reconnects. Never a prompt. */
  async function pageWallet(): Promise<SupportSelectedWallet | undefined> {
    if (!client.hasWallet) return;
    for (let tries = 0; tries < 6; tries++) {
      try {
        return await (await kit()).read();
      } catch {
        await pause(500);
      }
    }
  }
  const sameWallet = (entry: Entry, wallet?: SupportSelectedWallet) =>
    !!wallet &&
    (wallet.network ? "solana" : "evm") == entry.n &&
    wallet.address == entry.a;
  const claim = (wallet: SupportSelectedWallet) =>
    wallet.network
      ? { network: "solana", address: wallet.address }
      : { network: "evm", address: wallet.address, chainId: wallet.chainId };
  /** Trades the remembered key for a one-hour session, only for the wallet
   * the page shows now. */
  let resuming: Promise<void> | undefined;
  const resume = () =>
    (resuming ??= (async () => {
      const entry = member();
      if (!entry) return;
      const before = current();
      const wallet = await pageWallet();
      if (!wallet || !sameWallet(entry, wallet) || member()?.c != entry.c)
        return;
      /** The next key, kept before anything uses it. */
      const keep = (next?: { credential?: unknown; expiresAt?: unknown }) => {
        if (
          typeof next?.credential == "string" &&
          REMEMBERED.test(next.credential) &&
          typeof next.expiresAt == "number"
        )
          write(
            local,
            keys.member,
            JSON.stringify({
              ...entry,
              c: next.credential,
              x: next.expiresAt,
            } satisfies Entry),
          );
      };
      try {
        const answer = await call<{
          token: string;
          principalId: string;
          expiresAt: number;
          servicePrincipals?: string[];
          remember?: { credential: string; expiresAt: number };
        }>(
          "/auth/resume",
          { credential: entry.c, wallet: claim(wallet) },
          true,
        );
        // The rotated key is kept before the session is used.
        keep(answer.remember);
        // A session started meanwhile (a new guest, another wallet) stays.
        const now = current();
        if (
          !/^[0-9a-f]{64}$/.test(answer.token) ||
          (now && now.principalId != answer.principalId)
        )
          return;
        client.adopt({
          token: answer.token,
          principalId: answer.principalId,
          expiresAt: answer.expiresAt,
          address: wallet.address,
          chainId: wallet.chainId,
          level: "signed",
          servicePrincipals: answer.servicePrincipals,
        });
      } catch (reason) {
        // An outage after the key moved on still hands over the next key.
        keep((reason as { remember?: object }).remember);
        // Ended or reused: sign in again, unless another session started
        // meanwhile. Another wallet, a limit or an outage keeps the key.
        if (failed(reason).status == 401) {
          write(local, keys.member);
          write(tab, keys.tab);
          if (current() === before) client.adopt(false);
        }
      }
    })().finally(() => {
      resuming = undefined;
    }));

  /** A reload in the same tab: the session it held, when it still belongs
   * to what this browser keeps. */
  async function restore() {
    const saved = parsed<Cached>(read(tab, keys.tab));
    write(tab, keys.tab);
    if (
      !saved ||
      typeof saved.t != "string" ||
      !(saved.e > Date.now() + 5000) ||
      current()
    )
      return;
    const session: WidgetSession = {
      token: saved.t,
      principalId: saved.p,
      expiresAt: saved.e,
      level: saved.l,
      address: saved.a ?? "",
      chainId: saved.c,
      servicePrincipals: saved.s,
      thread: saved.h,
    };
    if (saved.l != "signed") {
      const credential = read(local, keys.guest) ?? "";
      if (
        /^[0-9a-f]{64}$/.test(credential) &&
        saved.g == credential.slice(56)
      ) {
        const thread = read(local, `templ:support-guest-thread:v1:${ws}`);
        client.adopt({
          ...session,
          credential,
          // Another tab, or a new case in this tab, can replace the old hint.
          // The service still checks this credential on every case read.
          thread: /^tc-[0-9a-f]{32}$/.test(thread ?? "") ? thread! : undefined,
        });
      }
      return;
    }
    const entry = member();
    if (!entry || familyTag(entry) != saved.g || entry.a != saved.a) return;
    const wallet = await pageWallet();
    if (wallet && sameWallet(entry, wallet) && !current())
      client.adopt({ ...session, chainId: wallet.chainId });
  }

  /* Renewal of a remembered session                                   */
  let renewal: ReturnType<typeof setTimeout> | undefined;
  function planRenewal() {
    clearTimeout(renewal);
    const session = current();
    const entry = member();
    if (session?.level != "signed" || !entry || entry.a != session.address)
      return;
    renewal = setTimeout(
      () => {
        if (!document.hidden) void resume();
      },
      Math.max(0, session.expiresAt - Date.now() - 60_000),
    );
  }

  /* Waiting on the team                                               */
  let pageSeen = false;
  /** Each page the widget reads says whether the visitor waits: their own
   * message is the newest one and under a day old, or a person was asked. */
  const messages = client.messages.bind(client);
  client.messages = async (id, before, seen) => {
    const page = (await messages(id, before, seen)) as Page &
      Awaited<ReturnType<typeof messages>>;
    const session = current();
    if (!before && session) {
      const last = page.messages.at(-1);
      const own =
        !!last &&
        (last.author == session.principalId ||
          !!page.conversation?.formerMembers?.includes(last.author));
      const waiting =
        !!page.conversation?.handoff ||
        (own && Date.now() - Date.parse(last!.createdAt ?? "") < DAY);
      // Kept only where a reload can bring the session back.
      write(
        local,
        keys.wait,
        waiting &&
          (/^[0-9a-f]{64}$/.test(read(local, keys.guest) ?? "") || member())
          ? String(Date.now() + DAY)
          : undefined,
      );
      pageSeen = true;
      void connect();
    }
    return page;
  };
  /** The dot after a reload, while the panel is closed: the read it makes
   * is not an open of the widget. */
  let quiet = false;
  const quietWake = () => {
    quiet = !pulse();
    wake();
  };
  function wakeIfWaiting() {
    const until = Number(read(local, keys.wait));
    if (!(until > Date.now())) return write(local, keys.wait);
    // Only while the tab is visible.
    if (!document.hidden) quietWake();
    else
      document.addEventListener("visibilitychange", function visible() {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", visible);
        quietWake();
      });
  }
  // A read while the panel is closed is not an open of the widget, and the
  // policy tells whether new guests pass a visitor check.
  let guestCheck: unknown, liveOn: Promise<boolean> | undefined;
  const policy = client.policy.bind(client);
  const background = () =>
    call<{ minimumLevel: "anyone" | "connected" | "signed" }>(
      "/auth/policy?bg=1",
      undefined,
      true,
    );
  function observePolicy(pending: Promise<object>) {
    asked = true;
    const availability = pending.then(answer => {
      const flags = answer as {guestCheck?: unknown; live?: boolean; notice?: unknown};
      guestCheck = flags.guestCheck;
      notice(flags.notice);
      return flags.live === true;
    });
    liveOn = availability;
    void availability.catch(() => {
      if (liveOn === availability) {
        asked = false;
        liveOn = undefined;
      }
    });
  }
  client.policy = () => {
    const counted = pulse() && !quiet;
    quiet = false;
    const pending = counted ? policy() : background();
    observePolicy(pending);
    return pending;
  };
  /* Templ's de-identified copy. While the workspace builds one,
   * the policy names the notice version for the pre-send summary. An approved
   * summary tells the room, which keeps the version on the request
   * that message opened; any other request is never copied. */
  let noticeVersion: unknown,
    approved = false,
    open: boolean | undefined,
    asked = false;
  const notice = (version?: unknown) => {
    if (version !== undefined) noticeVersion = version;
  };
  client.dataNotice = (shown) => {
    if (!Number.isSafeInteger(noticeVersion)) return;
    if (shown) approved = open !== true;
    return {
      version: noticeVersion as number,
      url: new URL(
        "/privacy#improvement",
        api.origin.replace("//community.", "//"),
      ).href,
    };
  };
  // A visible chat can already be reading policy when the live controls arrive.
  if (openingPolicy) observePolicy(openingPolicy);
  const settled = (state: boolean) => {
    open = state;
    notice();
  };
  const told =
    <A extends unknown[], R>(send: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const shown = approved;
      let sent: R;
      try {
        sent = await send(...args);
        cache();
      } catch (reason) {
        // Nothing was opened: the line stays for the next try.
        if (shown) settled(false);
        throw reason;
      }
      settled(true);
      approved = false;
      if (shown)
        void call("/conversations/notice", { version: noticeVersion }).catch(
          () => undefined,
        );
      return sent;
    };
  client.ask = told(client.ask.bind(client));
  client.reply = told(client.reply.bind(client));
  const status = client.status.bind(client);
  client.status = async () => {
    const answer = await status();
    cache();
    if (!answer.mine) settled(false);
    return answer;
  };
  const thread = client.messages;
  client.messages = async (id, before, seen, select) => {
    const page = await thread(id, before, seen, select);
    if (!before) settled(page.conversation?.state != "resolved");
    return page;
  };
  client.onSessionChange(() => {
    open = undefined;
    notice();
  });
  if (form && encrypted)
    caseActions.set(client, encrypted.route(client, form, ws));
  // Loaded because the chat opened: the page's own policy read may have come
  // before this chunk. Unless the page reads it again soon, read it quietly.
  if (pulse())
    setTimeout(() => {
      if (!asked)
        void background().then(
          (answer) => notice((answer as { notice?: unknown }).notice),
          () => undefined,
        );
    }, 300);
  /** Whether Templ has member sockets on, from the policy this page read
   * or one quiet read of it. */
  const socketsOn = () =>
    (liveOn ??= background().then(
      (answer) => (answer as { live?: unknown }).live === true,
      () => false,
    ));
  /** A new guest of a workspace with the visitor check: the check runs
   * first, and its token goes with the start, once, through the client's
   * own guest start (which keeps the credential, in memory too). A guest
   * resuming from its credential and a wallet sign-in never see it. A token
   * the service refuses gets one fresh check and one retry. */
  let starting: Promise<string> | undefined;
  const guest = client.guest.bind(client);
  const checked = () =>
    (starting ??= loadCheck()
      .catch(() => {
        throw new Error("The check couldn't load. Try again.");
      })
      .then((frame) =>
        frame.check({
          api: api.origin,
          workspace: ws,
          hasWallet: !!client.hasWallet,
          mount: form,
          origin,
        }),
      )
      .finally(() => {
        starting = undefined;
      }));
  client.guest = async (
    resumeOnly = false,
    renew = false,
    _check?: string,
    walletUnavailable = false,
    consentedWallet?: SupportSelectedWallet,
  ) => {
    let token: string | undefined, refused: unknown;
    if (
      !resumeOnly &&
      !current() &&
      !client.ended &&
      guestCheck == "turnstile" &&
      !/^[0-9a-f]{64}$/.test(read(local, keys.guest) ?? "")
    )
      token = await checked();
    for (;;)
      try {
        return await guest(
          resumeOnly,
          renew,
          token,
          walletUnavailable,
          consentedWallet,
        );
      } catch (reason) {
        // The workspace turned the check on after this page read its
        // policy, or the service refused the token: one fresh check.
        const why = failed(reason).reason;
        if (
          resumeOnly ||
          refused ||
          (why != "guest-check-required" && why != "guest-check-failed")
        )
          throw reason;
        refused = guestCheck = "turnstile";
        token = await checked();
      }
  };

  /* The member socket                                                  */
  let socket: WebSocket | undefined,
    connecting = false,
    off = false,
    halted = false,
    retries = 0,
    reauths = 0,
    received = 0,
    quietSince = 0,
    hiddenSince = 0,
    rest: ReturnType<typeof setTimeout> | undefined,
    lease: ReturnType<typeof setTimeout> | undefined,
    debounce: ReturnType<typeof setTimeout> | undefined,
    keepAlive: ReturnType<typeof setInterval> | undefined;
  async function ticket() {
    const issued = await call<{ ticket: string; socketUrl: string }>(
      "/conversations/live",
      {},
    );
    // Only the service's own socket, on the host the widget already calls;
    // inside Templ's frame it names the page the client speaks for.
    const socket = `wss://${api.host}/widget/${ws}/live`;
    if (
      issued.socketUrl !== socket &&
      issued.socketUrl !== `${socket}?host=${encodeURIComponent(origin)}`
    )
      throw new Error("Unexpected socket address.");
    return issued;
  }
  const wanted = () =>
    !off &&
    !halted &&
    pageSeen &&
    !document.hidden &&
    !!current() &&
    !!pulse() &&
    typeof WebSocket == "function";
  function stop(backOff = 0) {
    clearTimeout(lease);
    clearTimeout(debounce);
    clearInterval(keepAlive);
    clearTimeout(rest);
    rest = undefined;
    const open = socket;
    socket = undefined;
    if (open) {
      open.onclose = open.onmessage = null;
      try {
        open.close(1000);
      } catch {
        /* Already closing. */
      }
    }
    // Nothing reconnects before the back-off ends: not the interval below,
    // not the tab coming back.
    if (backOff)
      rest = setTimeout(() => {
        rest = undefined;
        void connect();
      }, backOff);
  }
  async function refreshTicket() {
    const open = socket;
    if (!open || document.hidden) return;
    try {
      const issued = await ticket();
      if (socket === open)
        open.send(JSON.stringify({ type: "refresh", ticket: issued.ticket }));
    } catch {
      stop(60_000);
    }
  }
  function onFrame(open: WebSocket, text: string) {
    const frame = parsed<{
      type?: string;
      accessExpiresAt?: string | null;
      event?: { id?: string };
    }>(text);
    if (!frame || socket !== open) return;
    if (frame.type == "ready") {
      retries = reauths = 0;
      // One read covers anything between the last read and the socket.
      wake();
      clearTimeout(lease);
      const until = Date.parse(frame.accessExpiresAt ?? "");
      if (until)
        lease = setTimeout(
          () => void refreshTicket(),
          Math.max(1000, until - Date.now() - 5000),
        );
    } else if (frame.type == "event") {
      // Only a signal: the chat reads its thread through the checked route.
      if (++received % 25 == 0 && frame.event?.id)
        open.send(JSON.stringify({ type: "ack", id: frame.event.id }));
      clearTimeout(debounce);
      debounce = setTimeout(wake, 150);
    } else if (frame.type == "reauth") void refreshTicket();
    else if (frame.type == "resync") wake();
  }
  async function connect() {
    if (socket || connecting || rest || !wanted()) return;
    connecting = true;
    try {
      if (!(await socketsOn())) {
        off = true;
        return;
      }
      const issued = await ticket();
      if (!wanted() || socket) return;
      const open = new WebSocket(issued.socketUrl);
      socket = open;
      open.onopen = () =>
        open.send(JSON.stringify({ type: "hello", ticket: issued.ticket }));
      open.onmessage = (message) => onFrame(open, String(message.data));
      open.onclose = (event) => {
        if (socket !== open) return;
        socket = undefined;
        // 4403: this ticket or site is refused; poll for the rest of the
        // page. 4401: one new ticket, then poll until the session changes.
        // 1008: updates missed, reconnect and read. 1013: the service is
        // full, poll for five minutes. Anything else: 2, 4, 8 s, then five
        // minutes. The chat keeps polling throughout.
        if (event.code == 4403) off = true;
        if (event.code == 4401 && reauths++) halted = true;
        stop(
          event.code == 4403 || halted
            ? 0
            : event.code == 4401
              ? 1000
              : event.code == 1008
                ? 1000
                : event.code == 1013
                  ? 300_000
                  : retries < 3
                    ? 2000 * 2 ** retries++
                    : 300_000,
        );
      };
      keepAlive = setInterval(() => {
        if (socket === open && open.readyState == 1) open.send("ping");
      }, 50_000);
    } catch (reason) {
      // The service has no member sockets: poll for the rest of the page.
      if (failed(reason).reason == "live-off") off = true;
      else stop(retries < 3 ? 2000 * 2 ** retries++ : 300_000);
    } finally {
      connecting = false;
    }
  }
  // Closed and not waiting for 30 s, hidden for 5 minutes, or signed out:
  // close it.
  setInterval(() => {
    const now = Date.now();
    quietSince = pulse() ? 0 : quietSince || now;
    hiddenSince = document.hidden ? hiddenSince || now : 0;
    if (
      socket &&
      ((quietSince && now - quietSince >= 30_000) ||
        (hiddenSince && now - hiddenSince >= 300_000) ||
        !current())
    )
      stop();
    else if (!socket) void connect();
  }, 10_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const session = current();
    // Back with under a minute of a remembered hour left: renew now.
    if (session?.level == "signed" && session.expiresAt - Date.now() < 60_000)
      void resume();
    if (socket) void refreshTicket().then(wake);
    else void connect();
  });

  /* Sessions                                                           */
  let token = current()?.token;
  client.onSessionChange(() => {
    const session = current();
    cache();
    planRenewal();
    if (session?.token == token) return;
    token = session?.token;
    pageSeen = halted = false;
    reauths = 0;
    stop();
    // A remembered hour that ran out, or the page's wallet back on the
    // remembered address: resume without a signature.
    if (!session) void resume();
  });
  // Sign out ends the remembered sign-in on this site before it resolves.
  const signOut = client.signOut.bind(client);
  client.signOut = () => {
    const entry = member();
    write(local, keys.member);
    write(tab, keys.tab);
    if (entry)
      void call("/auth/forget", { credential: entry.c }, true).catch(
        () => undefined,
      );
    return signOut();
  };

  return (async () => {
    await restore();
    if (!current()) await resume();
    cache();
    planRenewal();
    wakeIfWaiting();
  })().catch(() => undefined);
}

/** A new-case click checks protection before replacing the retained draft. */
export function newCase(
  host: TailHost,
  ready: () => string | false | null,
  start: (id: string) => void,
) {
  return caseActions.get(host.client)?.(host, ready, start);
}
