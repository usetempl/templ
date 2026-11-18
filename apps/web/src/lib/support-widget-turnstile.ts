/** The widget's `turnstile` chunk: the visitor check a
 * workspace can turn on for people who write without a wallet. It frames
 * the service's own check page (`/widget/<workspace>/check`), which runs
 * Cloudflare Turnstile and posts the token to this site only. The frame
 * sits in the widget, above the message box, in the widget's own colors,
 * and stays out of sight until the check needs a click. The token goes with the
 * guest start once and is never stored. Wallet sign-in and a guest resuming
 * from its credential never load this chunk. */

const COPY = {
  ask: "Confirm you're a person to send your first message.",
  failed: "The check didn't pass. Try again.",
  load: "The check couldn't load. Try again.",
  wallet: " Or sign in with your wallet.",
};

/** @public Lazy chunk entry: the widget loader calls it through a dynamic
 * import, which the dead-code check cannot follow. */
export function check(input: {
  api: string;
  workspace: string;
  hasWallet: boolean;
  /** The widget's message form; the check goes above its message box. */
  mount?: HTMLElement;
  /** The website the widget speaks for: the page around Templ's frame in
   * frame mode, where the check sits one level deeper. */
  origin?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const box = document.createElement("div");
    box.setAttribute("data-templ-check", "");
    Object.assign(box.style, {
      margin: "0 0 8px",
      padding: "12px",
      border: "1px solid var(--b2)",
      borderRadius: "14px",
      background: "var(--s)",
      color: "var(--t)",
      fontSize: "13px",
      display: "none",
    });
    const text = document.createElement("p");
    text.textContent = COPY.ask;
    Object.assign(text.style, { margin: "0 0 8px" });
    const frame = document.createElement("iframe");
    frame.title = COPY.ask;
    const site = input.origin ?? window.location.origin;
    frame.src = `${input.api}/widget/${input.workspace}/check?origin=${encodeURIComponent(site)}${site != window.location.origin ? "&frame=1" : ""}`;
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, {
      border: "0",
      width: "300px",
      maxWidth: "100%",
      height: "70px",
      display: "block",
    });
    box.append(text, frame);
    let reloaded = false;
    const finish = (error?: string, token?: string) => {
      clearTimeout(timer);
      window.removeEventListener("message", listen);
      box.remove();
      if (token) resolve(token);
      else reject(new Error(error));
    };
    const cannotLoad = () =>
      finish(COPY.load + (input.hasWallet ? COPY.wallet : ""));
    // Only loading is timed: once the check shows, the person takes as
    // long as they need, and the check's own expiry decides.
    let timer = setTimeout(cannotLoad, 20_000);
    function listen(event: MessageEvent) {
      // Only the service's own frame speaks here.
      if (
        event.origin !== input.api ||
        event.source !== frame.contentWindow ||
        event.data?.type !== "templ-check"
      )
        return;
      const state = event.data.state;
      if (state == "interactive") {
        clearTimeout(timer);
        box.style.display = "block";
      }
      else if (
        state == "passed" &&
        typeof event.data.token == "string" &&
        /^[A-Za-z0-9._-]{1,2048}$/.test(event.data.token)
      )
        finish(undefined, event.data.token);
      else if (state == "expired" && !reloaded) {
        // One fresh challenge before giving up.
        reloaded = true;
        clearTimeout(timer);
        timer = setTimeout(cannotLoad, 20_000);
        frame.src = frame.src;
      } else if (state == "unsupported") cannotLoad();
      else finish(COPY.failed);
    }
    window.addEventListener("message", listen);
    frame.addEventListener("error", cannotLoad);
    const mount = input.mount ?? document.body;
    mount.insertBefore(box, mount.querySelector(".composer"));
  });
}
