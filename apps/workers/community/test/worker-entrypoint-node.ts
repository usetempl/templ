/** Node tests import the worker's exports without running RPC entrypoints. */
export class WorkerEntrypoint {
  constructor() {
    throw new Error("Run WorkerEntrypoint in the Workerd test harness.");
  }
}
