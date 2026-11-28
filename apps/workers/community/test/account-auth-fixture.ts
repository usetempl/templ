import { encodeWidgetSolanaSignature } from "@templ/chat/widget-wallet";
import { vi } from "vitest";
import { keccak256, verifyMessage } from "viem";
import { AuthRecord } from "../src/auth-record";
import { MediaQuota } from "../src/media";
import { CommunityRoom } from "../src/room";
import { createCommunityWorker } from "../src/worker";
import { NONCE_COOKIE, SESSION_COOKIE, type Env } from "../src/common";
import { base58Encode } from "../src/solana";

export const origin = "https://templ.vip";
const factory = "0x1000000000000000000000000000000000000001";

class MemoryStorage {
  data = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();
  get = async <T>(key: string) => this.data.get(key) as T | undefined;
  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === "string") this.data.set(key, value);
    else
      for (const [name, item] of Object.entries(key)) this.data.set(name, item);
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async deleteAll() {
    this.data.clear();
  }
  async setAlarm() {}
  async getAlarm() {
    return null;
  }
  async list<T>(options: {
    prefix: string;
    reverse?: boolean;
    limit?: number;
  }) {
    let rows = [...this.data.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    if (options.reverse) rows = rows.reverse();
    return new Map(rows.slice(0, options.limit)) as Map<string, T>;
  }
  transaction<T>(fn: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn(this));
    this.queue = next.catch(() => {});
    return next;
  }
}
type Klass = typeof AuthRecord | typeof CommunityRoom | typeof MediaQuota;
function namespace(Type: Klass) {
  const objects = new Map<
    string,
    { instance: InstanceType<Klass>; storage: MemoryStorage }
  >();
  return {
    objects,
    idFromName: (name: string) => name,
    get(id: string) {
      if (!objects.has(id)) {
        const storage = new MemoryStorage();
        objects.set(id, {
          instance: new Type({ storage } as never),
          storage,
        });
      }
      return {
        fetch: (request: Request) => objects.get(id)!.instance.fetch(request),
      };
    },
  };
}

/** A throwaway Solana wallet: a WebCrypto Ed25519 key and its base58 address. */
export async function solanaWallet() {
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const address = base58Encode(
    new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
  );
  const sign = async (message: string) =>
    encodeWidgetSolanaSignature(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          key.privateKey,
          new TextEncoder().encode(message),
        ),
      ),
    );
  return { address, sign };
}

export function setup(bitcoinEnabled = false, appOrigin = origin) {
  const records = namespace(AuthRecord);
  const env = {
    APP_ORIGIN: appOrigin,
    BITCOIN_ACCOUNT_SIGN_IN_ENABLED: String(bitcoinEnabled),
    SUPPORT_WIDGET_SOLANA_ENABLED: "false",
    RELEASED_FEATURES: "[]",
    ROBINHOOD_RPC_URL: "https://rpc.example",
    TEMPL_V4_FACTORY: factory,
    TEMPL_V4_FACTORY_CODE_HASH: keccak256("0x6000"),
    AUTH_RECORDS: records,
    ROOMS: namespace(CommunityRoom),
    MEDIA_QUOTAS: namespace(MediaQuota),
    AUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CHAT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CHAT_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    MEDIA_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  } as unknown as Env;
  const worker = createCommunityWorker({
    verifySessionAuthority: vi.fn(async () => true),
    verifiedChain: vi.fn(async () => ({ factory, blockNumber: 123n })),
    verifyWallet: vi.fn(async (_env, message, signature, account) =>
      verifyMessage({ message, signature, address: account }),
    ),
    requireRegistration: vi.fn(async () => {
      throw new Error("No contract room in this test.");
    }),
    roleAccess: vi.fn(async () => {
      throw new Error("No contract room in this test.");
    }),
  } as never);
  const call = (
    path: string,
    options: { body?: unknown; cookies?: string } = {},
  ) =>
    worker.fetch(
      new Request(`https://community.${new URL(appOrigin).host}${path}`, {
        method: options.body ? "POST" : "GET",
        headers: {
          Origin: appOrigin,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "192.0.2.1",
          ...(options.cookies ? { Cookie: options.cookies } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }),
      env,
    );
  const cookieOf = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${name}=`))
      ?.split(";")[0];
  const parse = async <T = Record<string, unknown>>(response: Response) =>
    (await response.json()) as T & { error?: string };
  async function solanaLogin(wallet: Awaited<ReturnType<typeof solanaWallet>>) {
    const nonce = await call("/auth/solana/nonce", {
      body: { address: wallet.address },
    });
    const { message } = await parse<{ message: string }>(nonce);
    const response = await call("/auth/solana/verify", {
      cookies: cookieOf(nonce, NONCE_COOKIE)!,
      body: { message, signature: await wallet.sign(message) },
    });
    return {
      status: response.status,
      body: await parse<{ principalId: string; solanaAddress: string }>(
        response,
      ),
      cookies: cookieOf(response, SESSION_COOKIE) ?? "",
    };
  }
  return { call, parse, cookieOf, solanaLogin, records, env };
}
