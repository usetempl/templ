/** Small in-memory presentation cache. It never persists credentials or authorizes actions. */
export class BoundedCache<T> {
  private entries = new Map<string, { value: T; at: number }>();
  private pending = new Map<string, Promise<T>>();
  private revision = 0;

  constructor(
    private readonly limit: number,
    private readonly maxAge: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (Date.now() - entry.at >= this.maxAge) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T) {
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  load(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const revision = this.revision;
    const promise = Promise.resolve()
      .then(read)
      .then((value) => {
        if (this.revision === revision && this.pending.get(key) === promise)
          this.set(key, value);
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  delete(key: string) {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  deletePrefix(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith(prefix)) this.pending.delete(key);
  }

  clear() {
    ++this.revision;
    this.entries.clear();
    this.pending.clear();
  }
}

/** Share only concurrent reads; completed authorization results are never retained. */
export function deduplicateReads<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve()
      .then(read)
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  };
}
