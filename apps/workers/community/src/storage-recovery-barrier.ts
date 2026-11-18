import { HttpError } from "./common";

/** Drain accepted work before a snapshot. New work waits for recovery. */
export class RecoveryWork {
  private pausedBy: string | null = null;
  get paused() {
    return this.pausedBy !== null;
  }
  private readonly active = new Set<Promise<unknown>>();

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.paused)
      throw new HttpError(
        503,
        "This workspace is being restored. Try again in a few minutes.",
      );
    const task = Promise.resolve().then(work);
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
    }
  }

  async pause(op: string) {
    if (this.pausedBy && this.pausedBy !== op)
      throw new HttpError(409, "Finish the current recovery first.");
    this.pausedBy = op;
    await Promise.allSettled([...this.active]);
  }

  resume(op: string) {
    if (this.pausedBy === op) this.pausedBy = null;
  }
}

export type RecoveryHooks = {
  pause(op: string): Promise<void>;
  resume(op: string): void;
};
