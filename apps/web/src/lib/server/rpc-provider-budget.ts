export const RPC_PROVIDER_ATTEMPTS_PER_MINUTE = 7_200;
export const RPC_PROVIDER_ATTEMPTS_PER_DAY = 1_000_000;

type BudgetRecord = {
  minute: number;
  minuteUsed: number;
  day: number;
  dayUsed: number;
};
type BudgetTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};
type BudgetStorage = {
  transaction<T>(
    callback: (transaction: BudgetTransaction) => Promise<T>,
  ): Promise<T>;
};
type BudgetState = { storage: BudgetStorage };

/** Durable reservation ledger. Its class and storage binding stay deployed. */
export class RpcProviderBudget {
  constructor(private readonly state: BudgetState) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.origin !== "https://rpc-provider-budget.internal" ||
      url.pathname !== "/reserve" ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return new Response(null, { status: 404 });
    let units: number;
    try {
      const value = (await request.json()) as Record<string, unknown>;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !Number.isSafeInteger(value.units) ||
        Number(value.units) < 1 ||
        Number(value.units) > 1_200
      )
        throw new Error();
      units = Number(value.units);
    } catch {
      return new Response(null, { status: 400 });
    }

    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const day = Math.floor(now / 86_400_000);
    const accepted = await this.state.storage.transaction(
      async (transaction) => {
        const previous = await transaction.get<BudgetRecord>("budget");
        if (
          previous !== undefined &&
          (!Number.isSafeInteger(previous.minute) ||
            previous.minute < 0 ||
            !Number.isSafeInteger(previous.minuteUsed) ||
            previous.minuteUsed < 0 ||
            previous.minuteUsed > RPC_PROVIDER_ATTEMPTS_PER_MINUTE ||
            !Number.isSafeInteger(previous.day) ||
            previous.day < 0 ||
            !Number.isSafeInteger(previous.dayUsed) ||
            previous.dayUsed < 0 ||
            previous.dayUsed > RPC_PROVIDER_ATTEMPTS_PER_DAY)
        )
          return false;
        const record: BudgetRecord = {
          minute,
          minuteUsed: previous?.minute === minute ? previous.minuteUsed : 0,
          day,
          dayUsed: previous?.day === day ? previous.dayUsed : 0,
        };
        if (
          record.minuteUsed + units > RPC_PROVIDER_ATTEMPTS_PER_MINUTE ||
          record.dayUsed + units > RPC_PROVIDER_ATTEMPTS_PER_DAY
        )
          return false;
        record.minuteUsed += units;
        record.dayUsed += units;
        await transaction.put("budget", record);
        return true;
      },
    );
    return new Response(null, {
      status: accepted ? 204 : 429,
      headers: accepted ? undefined : { "Retry-After": "60" },
    });
  }
}
