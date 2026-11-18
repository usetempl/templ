/** An Own authority update can interrupt a read without changing the caller's
 * permissions. Retry only the read; the endpoint repeats every access check. */
export async function readOwnRecoveredRecord<T>(read: () => Promise<T>, scope: {
  signal: AbortSignal;
  active: () => boolean;
}): Promise<T> {
  const current = () => {
    if (scope.signal.aborted || !scope.active()) throw new DOMException("Navigation changed", "AbortError");
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    current();
    try {
      const result = await read();
      current();
      return result;
    } catch (error) {
      current();
      if (attempt === 2 || (error as {status?: unknown} | null)?.status !== 503) throw error;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {clearTimeout(timer); reject(new DOMException("Navigation changed", "AbortError"));};
        const timer = setTimeout(() => {scope.signal.removeEventListener("abort", aborted); resolve();}, 250 * (attempt + 1));
        scope.signal.addEventListener("abort", aborted, {once: true});
        if (scope.signal.aborted) aborted();
      });
    }
  }
  throw new Error("Encrypted history could not be recovered.");
}
