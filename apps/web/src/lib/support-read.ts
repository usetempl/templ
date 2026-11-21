import { CommunityApiError } from "./community-client";

export const SUPPORT_READ_TIMEOUT_MS = 20_000;
const TIMEOUT = "This request took too long. Try again.";

/** Bounds a support GET without retrying it. Writes keep their own path. */
export async function readSupport<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      cancel = () => {
        reject(signal.reason);
        request.abort(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        reject(new Error(TIMEOUT));
        request.abort();
      }, SUPPORT_READ_TIMEOUT_MS);
    });
    return await Promise.race([read(request.signal), deadline]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}


/** Retry one transient list read. All cases can finish a slow page while the
 * same workspace and view are open. Leaving that view cancels the read. */
export async function readCaseList<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  retrying: () => void,
  waitForPage = false,
): Promise<T> {
  const attempt = () => {
    signal.throwIfAborted();
    return waitForPage ? read(signal) : readSupport(read, signal);
  };
  try {
    return await attempt();
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof TypeError ||
      (error instanceof Error && error.message === TIMEOUT) ||
      (error instanceof CommunityApiError &&
        [502, 503, 504].includes(error.status) && !error.retryAfterSeconds)))
      throw error;
    retrying();
    return attempt();
  }
}
