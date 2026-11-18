import { CommunityApiError } from "./community-client";

const retryDelays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function waitForRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function readProductPaymentStatus<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await read(signal);
    } catch (reason) {
      if (signal.aborted) throw reason;
      console.warn("TEMPL_SUPPORT_FAILURE", {
        route: "payment",
        step: "status",
        cause: "read-failed",
      });
      if (
        attempt >= retryDelays.length ||
        (reason instanceof CommunityApiError &&
          [400, 401, 403, 404, 410].includes(reason.status))
      )
        throw reason;
      const retryAfter =
        reason instanceof CommunityApiError && reason.status === 429
          ? (reason.retryAfterSeconds ?? 0) * 1_000
          : 0;
      await waitForRetry(
        Math.max(retryDelays[attempt], Math.min(300_000, retryAfter)),
        signal,
      );
    }
  }
}
