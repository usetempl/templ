export const SUPPORT_READ_TIMEOUT_MS = 20_000;

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
        reject(new Error("This request took too long. Try again."));
        request.abort();
      }, SUPPORT_READ_TIMEOUT_MS);
    });
    return await Promise.race([read(request.signal), deadline]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}
