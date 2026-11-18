import {
  PRODUCT_PAYMENT_ASSETS,
  isProductPaymentNetwork,
} from "@templ/chat/product-payment-assets";
import {
  profileAddress,
  profileKey,
  type ProfileRef,
} from "@templ/chat/protocol-profile";
import type { Fetcher } from "./tx-diagnosis/rpc";
import { knownEvmToken } from "@templ/chat/diagnosis/known-addresses";

export const PRIORITY_PRICE_CACHE_MS = 5 * 60 * 1_000;
const SOURCE_AGE_MS = 6 * 60 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_CACHE_ENTRIES = 256;
export const PRICE_CHAINS: Readonly<Record<string, string>> = {
  "eip155:1": "ethereum",
  "eip155:8453": "base",
  "eip155:56": "bsc",
  "eip155:10": "optimism",
  "eip155:42161": "arbitrum",
  "eip155:137": "polygon",
  "eip155:100": "xdai",
  "eip155:250": "fantom",
  "eip155:146": "sonic",
  "eip155:747474": "katana",
  solana: "solana",
};

export type PriorityAssetPrice = {
  usd: number;
  asOf: string;
  estimated: boolean;
  decimals: number;
};
type CacheEntry = { expiresAt: number; price: PriorityAssetPrice | null };
export type PriorityPriceObservation =
  | {
      kind: "price-response";
      at: string;
      method: "GET";
      url: string;
      status: number;
      response: unknown;
    }
  | {
      kind: "price-quote";
      at: string;
      assetKey: string;
      quote: PriorityAssetPrice | null;
    }
  | { kind: "incomplete" };
type PriceObserver = (observation: PriorityPriceObservation) => Promise<void>;
async function notify(
  observer: PriceObserver | undefined,
  observation: PriorityPriceObservation,
) {
  try {
    await observer?.(observation);
  } catch {
    /* Observation preserves the ordinary price result. */
  }
}

/** Issuer-reviewed asset identity, independent of a manager's token label. */
export function priorityStableAsset(ref: ProfileRef) {
  if (ref.network !== "solana") {
    const known = knownEvmToken(ref.network, ref.address);
    if (known && ["USDC", "USDT", "DAI"].includes(known.label)) return known;
  }
  const network =
    ref.network === "solana"
      ? "solana"
      : Number(ref.network.slice("eip155:".length));
  if (!isProductPaymentNetwork(network)) return null;
  const address = profileAddress(ref.network, ref.address);
  return (
    Object.values(PRODUCT_PAYMENT_ASSETS[network]).find(
      (asset) => profileAddress(ref.network, asset.address) === address,
    ) ?? null
  );
}

function sourceKey(ref: ProfileRef): string | null {
  const chain = PRICE_CHAINS[ref.network];
  const address = profileAddress(ref.network, ref.address);
  return chain && address ? `${chain}:${address}` : null;
}

async function readPriceBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("price-body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("price-size");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function checkedPrice(raw: unknown, now: number): PriorityAssetPrice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.price !== "number" ||
    !Number.isFinite(row.price) ||
    row.price <= 0 ||
    row.price > 1e12 ||
    typeof row.timestamp !== "number" ||
    !Number.isSafeInteger(row.timestamp) ||
    now - row.timestamp * 1_000 > SOURCE_AGE_MS ||
    row.timestamp * 1_000 > now + 30_000 ||
    typeof row.confidence !== "number" ||
    row.confidence < 0.9 ||
    row.confidence > 1 ||
    typeof row.decimals !== "number" ||
    !Number.isSafeInteger(row.decimals) ||
    row.decimals < 0 ||
    row.decimals > 77
  )
    return null;
  return {
    usd: row.price,
    asOf: new Date(row.timestamp * 1_000).toISOString(),
    estimated: true,
    decimals: row.decimals,
  };
}

/** A bounded cache of public asset prices. Requests carry asset addresses only. */
export class PriorityPriceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<void>>();

  async read(
    refs: readonly ProfileRef[],
    deps: {
      now?: () => number;
      fetcher?: Fetcher;
      observe?: PriceObserver;
    } = {},
  ): Promise<Map<string, PriorityAssetPrice | null>> {
    const now = (deps.now ?? Date.now)();
    const output = new Map<string, PriorityAssetPrice | null>();
    const missing = new Map<string, ProfileRef>();
    for (const ref of refs.slice(0, 16)) {
      const key = profileKey(ref);
      const stable = priorityStableAsset(ref);
      if (stable) {
        output.set(key, {
          usd: 1,
          decimals: stable.decimals,
          asOf: new Date(now).toISOString(),
          estimated: false,
        });
        continue;
      }
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        output.set(key, cached.price);
        continue;
      }
      if (!sourceKey(ref)) output.set(key, null);
      else missing.set(key, ref);
    }
    if (missing.size) {
      const batchKey = [...missing.keys()].sort().join(",");
      let work = this.pending.get(batchKey);
      if (!work) {
        work = this.fetchBatch(
          missing,
          now,
          deps.fetcher,
          deps.observe,
        ).finally(() => {
          this.pending.delete(batchKey);
        });
        this.pending.set(batchKey, work);
      } else if (deps.observe)
        await notify(deps.observe, { kind: "incomplete" });
      await work;
      for (const key of missing.keys())
        output.set(key, this.entries.get(key)?.price ?? null);
    }
    for (const [assetKey, quote] of output)
      await notify(deps.observe, {
        kind: "price-quote",
        at: new Date((deps.now ?? Date.now)()).toISOString(),
        assetKey,
        quote,
      });
    return output;
  }

  private async fetchBatch(
    refs: Map<string, ProfileRef>,
    now: number,
    fetcher?: Fetcher,
    observe?: PriceObserver,
  ) {
    let coins: Record<string, unknown> = {};
    try {
      // https://api-docs.defillama.com/llms-free.txt
      const ids = [...refs.values()].map(sourceKey).join(",");
      const url = `https://coins.llama.fi/prices/current/${ids}?searchWidth=6h`;
      const at = new Date().toISOString();
      const response = await (fetcher ?? fetch)(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const raw = await readPriceBody(response);
        if (
          raw &&
          typeof raw === "object" &&
          "coins" in raw &&
          raw.coins &&
          typeof raw.coins === "object" &&
          !Array.isArray(raw.coins)
        )
          coins = raw.coins as Record<string, unknown>;
        await notify(observe, {
          kind: "price-response",
          at,
          method: "GET",
          url,
          status: response.status,
          response: { coins },
        });
      } else {
        await response.body?.cancel();
        await notify(observe, { kind: "incomplete" });
      }
    } catch {
      coins = {};
      await notify(observe, { kind: "incomplete" });
    }
    for (const [key, ref] of refs) {
      const price = checkedPrice(coins[sourceKey(ref)!], now);
      this.entries.delete(key);
      while (this.entries.size >= MAX_CACHE_ENTRIES)
        this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, {
        expiresAt: now + PRIORITY_PRICE_CACHE_MS,
        price,
      });
    }
  }
}

export const priorityPriceCache = new PriorityPriceCache();
