/** In-memory room storage for the case feature tests: get, put, delete and
 * list with the Durable Object options these modules use, plus a
 * transaction that rolls back on a throw. */
type Options = {
  prefix?: string;
  start?: string;
  startAfter?: string;
  end?: string;
  reverse?: boolean;
  limit?: number;
};
export class Memory {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get(key: string | string[]) {
    if (Array.isArray(key))
      return new Map(
        key
          .filter((item) => this.data.has(item))
          .map((item) => [item, structuredClone(this.data.get(item))]),
      );
    return structuredClone(this.data.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === "string") this.data.set(key, structuredClone(value));
    else
      for (const [name, entry] of Object.entries(key))
        this.data.set(name, structuredClone(entry));
  }
  async delete(key: string | string[]) {
    if (Array.isArray(key))
      return key.filter((item) => this.data.delete(item)).length;
    return this.data.delete(key);
  }
  async list(options: Options = {}) {
    let keys = [...this.data.keys()]
      .filter(
        (key) =>
          (!options.prefix || key.startsWith(options.prefix)) &&
          (!options.start || key >= options.start) &&
          (!options.startAfter || key > options.startAfter) &&
          (!options.end || key < options.end),
      )
      .sort();
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return new Map(
      keys.map((key) => [key, structuredClone(this.data.get(key))]),
    );
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async transaction<T>(fn: (storage: Memory) => Promise<T>) {
    const before = new Map(this.data);
    try {
      return await fn(this);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  keys(prefix: string) {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
export const txn = (storage: Memory) =>
  storage as unknown as DurableObjectTransaction;
