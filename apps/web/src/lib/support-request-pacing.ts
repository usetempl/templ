import { CommunityApiError } from "./community-client";
import { communitySessionRevision } from "./community-auth";

/** Opening a thread has one pending draft. Retry only a definite pacing
 * refusal; an uncertain response stays available for a manual, same-ID retry. */
export async function pacedSupportRequest<T>(
  run: (assertCurrent: () => void) => Promise<T>,
  signal: AbortSignal,
  waiting: (value: boolean) => void,
) {
  const revision = communitySessionRevision();
  const waitDeadline = Date.now() + 15 * 60_000;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (revision !== communitySessionRevision())
      throw new DOMException("Sign-in changed.", "AbortError");
  };
  for (;;) {
    assertCurrent();
    waiting(false);
    let active = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        run(() => {
          assertCurrent();
          if (!active) throw new Error("Send attempt expired.");
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          deadline = setTimeout(
            () => reject(new Error("Delivery could not be confirmed.")),
            20_000,
          );
        }),
      ]);
      assertCurrent();
      return result;
    } catch (reason) {
      const seconds =
        reason instanceof CommunityApiError ? reason.retryAfterSeconds : null;
      if (
        signal.aborted ||
        !(reason instanceof CommunityApiError) ||
        reason.status !== 429 ||
        (reason.details as { reason?: string } | undefined)?.reason !==
          "account-message-pace" ||
        seconds === null ||
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > 60 ||
        Date.now() + seconds * 1000 > waitDeadline
      )
        throw reason;
      // Clear the request deadline before waiting for the next allowed send.
      active = false;
      clearTimeout(deadline);
      if (abort) signal.removeEventListener("abort", abort);
      waiting(true);
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, seconds * 1000);
        signal.addEventListener("abort", cancel, { once: true });
      });
    } finally {
      active = false;
      clearTimeout(deadline);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}
