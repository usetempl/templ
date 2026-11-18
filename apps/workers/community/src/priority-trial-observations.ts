import {
  profileAddress,
  profileKey,
  type ProfileRef,
} from "@templ/chat/protocol-profile";
import { isSolanaAddress } from "@templ/chat/solana";
import { PRICE_CHAINS } from "./support-priority-prices";

type ObjectRow = Record<string, unknown>;
export type PriorityObservationScope = {
  contracts: readonly ProfileRef[];
  priceAssets: readonly ProfileRef[];
  walletByNetwork: Readonly<Record<string, string>>;
};
export type PriorityRpcDispatch = {
  kind: "rpc-dispatch";
  requestId: string;
  network: string;
  providerSha256: string;
  at: string;
  transport: "single" | "batch";
  batch: { jsonrpc: "2.0"; id: number; method: string; params: unknown[] }[];
};
export type PriorityObservation =
  | PriorityRpcDispatch
  | {
      kind: "rpc-response";
      requestId: string;
      at: string;
      responses: ObjectRow[];
    }
  | {
      kind: "price-response";
      at: string;
      method: "GET";
      url: string;
      status: 200;
      response: { coins: ObjectRow };
    }
  | {
      kind: "price-quote";
      at: string;
      assetKey: string;
      quote: {
        usd: number;
        asOf: string;
        estimated: boolean;
        decimals: number;
      } | null;
    }
  | {
      kind: "room-refusal";
      at: string;
      status: 429;
      request: {
        op: "reserve-attempt" | "attempt";
        metric: "primary-cu" | "confirmation-attempts";
        kind: "room";
        lane: "normal";
        method: string;
      };
      response: { error: string };
    };
const fail = () => {
  throw new Error("priority-observation-refused");
};
const object = (value: unknown): ObjectRow => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as ObjectRow;
};
const keys = (value: ObjectRow, names: string) =>
  Object.keys(value).sort().join() === names;
const time = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const hex = (value: unknown, size?: number) =>
  typeof value === "string" &&
  (size ? new RegExp(`^0x[a-f0-9]{${size}}$`) : /^0x[a-f0-9]{1,64}$/).test(
    value,
  );
const refIn = (
  refs: readonly ProfileRef[],
  network: string,
  address: unknown,
) =>
  typeof address === "string" &&
  refs.some((ref) => ref.network === network && ref.address === address);
const readOnly = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_call",
  "getTokenAccountsByOwner",
]);
/** Keep only the selected public chain request fields. */
export function projectPriorityDispatch(
  input: unknown,
  scope: PriorityObservationScope,
): PriorityRpcDispatch {
  const row = object(input);
  if (
    !keys(row, "at,batch,kind,network,providerSha256,requestId,transport") ||
    row.kind !== "rpc-dispatch" ||
    typeof row.requestId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(row.requestId) ||
    typeof row.network !== "string" ||
    !Object.hasOwn(scope.walletByNetwork, row.network) ||
    typeof row.providerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.providerSha256) ||
    !time(row.at) ||
    !["single", "batch"].includes(String(row.transport)) ||
    !Array.isArray(row.batch) ||
    row.batch.length < 1 ||
    row.batch.length > 16 ||
    (row.transport === "single" && row.batch.length !== 1)
  )
    return fail();
  const network = row.network;
  const batch = row.batch.map((raw, index) => {
    const call = object(raw);
    if (
      !keys(call, "id,jsonrpc,method,params") ||
      call.jsonrpc !== "2.0" ||
      call.id !== index + 1 ||
      typeof call.method !== "string" ||
      !readOnly.has(call.method) ||
      !Array.isArray(call.params)
    )
      return fail();
    const params = call.params;
    if (network === "solana") {
      if (
        call.method !== "getTokenAccountsByOwner" ||
        params.length !== 3 ||
        params[0] !== scope.walletByNetwork.solana
      )
        return fail();
      const mint = object(params[1]),
        options = object(params[2]);
      if (
        !keys(mint, "mint") ||
        !refIn(scope.contracts, network, mint.mint) ||
        !keys(options, "commitment,encoding") ||
        options.commitment !== "finalized" ||
        options.encoding !== "jsonParsed"
      )
        return fail();
    } else if (call.method === "eth_chainId") {
      if (params.length) return fail();
    } else if (call.method === "eth_getBlockByNumber") {
      if (
        params.length !== 2 ||
        (params[0] !== "latest" &&
          !(
            typeof params[0] === "string" &&
            /^0x(?:0|[1-9a-f][a-f0-9]{0,63})$/.test(params[0])
          )) ||
        params[1] !== false
      )
        return fail();
    } else if (call.method === "eth_call") {
      if (params.length !== 2) return fail();
      const target = object(params[0]),
        block = object(params[1]);
      if (
        !keys(target, "data,to") ||
        !refIn(scope.contracts, network, target.to) ||
        !keys(block, "blockHash,requireCanonical") ||
        !hex(block.blockHash, 64) ||
        block.requireCanonical !== true ||
        typeof target.data !== "string"
      )
        return fail();
      const balance = `0x70a08231${scope.walletByNetwork[network].slice(2).padStart(64, "0")}`;
      if (
        target.data !== balance &&
        target.data !== "0x38d52e0f" &&
        !/^0x07a2d13a[a-f0-9]{64}$/.test(target.data)
      )
        return fail();
    } else return fail();
    return structuredClone(call) as PriorityRpcDispatch["batch"][number];
  });
  return {
    kind: "rpc-dispatch",
    requestId: row.requestId,
    network,
    providerSha256: row.providerSha256,
    at: row.at as string,
    transport: row.transport as "single" | "batch",
    batch,
  };
}
/** Provider metadata and error text never enter a trace. */
export function projectPriorityResponses(
  input: unknown,
  dispatch: PriorityRpcDispatch,
): PriorityObservation {
  const row = object(input);
  if (
    !keys(row, "at,kind,requestId,responses") ||
    row.kind !== "rpc-response" ||
    row.requestId !== dispatch.requestId ||
    !time(row.at) ||
    !Array.isArray(row.responses) ||
    row.responses.length !== dispatch.batch.length
  )
    return fail();
  const values = row.responses;
  const responses = dispatch.batch.map((call) => {
    const raw = values.find((value) => object(value).id === call.id);
    const reply = object(raw);
    if (
      reply.jsonrpc !== "2.0" ||
      !Object.hasOwn(reply, "result") ||
      Object.hasOwn(reply, "error") ||
      values.filter((value) => object(value).id === call.id).length !== 1
    )
      return fail();
    let result: unknown = reply.result;
    if (call.method === "eth_chainId") {
      if (!hex(result)) return fail();
    } else if (call.method === "eth_call") {
      if (!hex(result, 64)) return fail();
    } else if (call.method === "eth_getBlockByNumber") {
      const block = object(result);
      if (!hex(block.hash, 64) || !hex(block.number) || !hex(block.timestamp))
        return fail();
      result = {
        hash: block.hash,
        number: block.number,
        timestamp: block.timestamp,
      };
    } else {
      const accounts = object(result).value;
      if (!Array.isArray(accounts) || accounts.length > 50) return fail();
      const owner = call.params[0],
        mint = object(call.params[1]).mint;
      result = {
        value: accounts.map((value) => {
          const info = object(
            object(object(object(object(value).account).data).parsed).info,
          );
          const token = object(info.tokenAmount);
          if (
            info.owner !== owner ||
            !isSolanaAddress(String(info.owner)) ||
            info.mint !== mint ||
            typeof token.amount !== "string" ||
            !/^[0-9]{1,30}$/.test(token.amount) ||
            !Number.isSafeInteger(token.decimals) ||
            Number(token.decimals) < 0 ||
            Number(token.decimals) > 77
          )
            return fail();
          return {
            account: {
              data: {
                parsed: {
                  info: {
                    owner: info.owner,
                    mint: info.mint,
                    tokenAmount: {
                      amount: token.amount,
                      decimals: token.decimals,
                    },
                  },
                },
              },
            },
          };
        }),
      };
    }
    return { jsonrpc: "2.0", id: call.id, result };
  });
  return {
    kind: "rpc-response",
    requestId: dispatch.requestId,
    at: row.at as string,
    responses,
  };
}
export function projectPriorityPrice(
  input: unknown,
  scope: PriorityObservationScope,
): PriorityObservation {
  const row = object(input);
  if (row.kind === "price-quote") {
    if (
      !keys(row, "assetKey,at,kind,quote") ||
      !time(row.at) ||
      !scope.priceAssets.some((ref) => profileKey(ref) === row.assetKey)
    )
      return fail();
    if (row.quote === null)
      return {
        kind: "price-quote",
        at: row.at as string,
        assetKey: String(row.assetKey),
        quote: null,
      };
    const quote = object(row.quote);
    if (
      !keys(quote, "asOf,decimals,estimated,usd") ||
      !time(quote.asOf) ||
      typeof quote.estimated !== "boolean" ||
      typeof quote.usd !== "number" ||
      !Number.isFinite(quote.usd) ||
      quote.usd <= 0 ||
      quote.usd > 1e12 ||
      !Number.isSafeInteger(quote.decimals) ||
      Number(quote.decimals) < 0 ||
      Number(quote.decimals) > 77
    )
      return fail();
    return structuredClone(row) as PriorityObservation;
  }
  if (
    !keys(row, "at,kind,method,response,status,url") ||
    row.kind !== "price-response" ||
    row.method !== "GET" ||
    row.status !== 200 ||
    !time(row.at) ||
    typeof row.url !== "string"
  )
    return fail();
  const coins = object(object(row.response).coins);
  const selected = Object.keys(coins);
  if (
    selected.length < 1 ||
    selected.length > 16 ||
    !selected.every((key) =>
      scope.priceAssets.some(
        (ref) =>
          `${PRICE_CHAINS[ref.network]}:${profileAddress(ref.network, ref.address)}` ===
          key,
      ),
    ) ||
    row.url !==
      `https://coins.llama.fi/prices/current/${selected.join(",")}?searchWidth=6h`
  )
    return fail();
  const clean: ObjectRow = {};
  for (const key of selected) {
    const price = object(coins[key]);
    if (
      typeof price.price !== "number" ||
      !Number.isFinite(price.price) ||
      price.price <= 0 ||
      price.price > 1e12 ||
      !Number.isSafeInteger(price.timestamp) ||
      Number(price.timestamp) <= 0 ||
      typeof price.confidence !== "number" ||
      price.confidence < 0.9 ||
      price.confidence > 1 ||
      !Number.isSafeInteger(price.decimals) ||
      Number(price.decimals) < 0 ||
      Number(price.decimals) > 77
    )
      return fail();
    clean[key] = {
      price: price.price,
      timestamp: price.timestamp,
      confidence: price.confidence,
      decimals: price.decimals,
    };
  }
  return {
    kind: "price-response",
    method: "GET",
    status: 200,
    at: row.at as string,
    url: row.url,
    response: { coins: clean },
  };
}
export function projectPriorityRefusal(input: unknown): PriorityObservation {
  const row = object(input),
    request = object(row.request),
    response = object(row.response);
  if (
    !keys(row, "at,kind,request,response,status") ||
    row.kind !== "room-refusal" ||
    row.status !== 429 ||
    !time(row.at) ||
    !keys(request, "kind,lane,method,metric,op") ||
    request.kind !== "room" ||
    request.lane !== "normal" ||
    !["primary-cu", "confirmation-attempts"].includes(String(request.metric)) ||
    !["reserve-attempt", "attempt"].includes(String(request.op)) ||
    !readOnly.has(String(request.method)) ||
    !keys(response, "error") ||
    response.error !== "Chat verification is busy. Please try again later."
  )
    return fail();
  return structuredClone(row) as PriorityObservation;
}
