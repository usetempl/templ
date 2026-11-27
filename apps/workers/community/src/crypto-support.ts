import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { HttpError } from "./common";

export { CRYPTO_SUPPORT_WORKSPACE };
const minute = 60_000;
const day = 24 * 60 * minute;
const dailyQuestions = 24;

type Bucket = { day: number; visitors: Record<string, number[]> };

async function visitorId(principal: string, period: number) {
  const data = new TextEncoder().encode(period + "/" + principal);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function reserveCryptoQuestion(
  storage: DurableObjectTransaction,
  room: string,
  member: string,
  aliases: readonly string[],
  now: number,
  networkDigest?: string | null,
) {
  if (room !== "room:" + CRYPTO_SUPPORT_WORKSPACE) return;
  const identity = [...new Set([member, ...aliases])];
  const limits = [
    { principals: identity, key: "visitor", burst: 2, daily: dailyQuestions },
  ];
  if (networkDigest && /^[a-f0-9]{64}$/.test(networkDigest))
    limits.push({
      principals: [networkDigest],
      key: "network",
      burst: 12,
      daily: 96,
    });
  const updates = await Promise.all(
    limits.map((limit) => nextWindow(storage, limit, now)),
  );
  for (const { key, bucket } of updates) await storage.put(key, bucket);
}

async function nextWindow(
  storage: DurableObjectTransaction,
  limit: { principals: string[]; key: string; burst: number; daily: number },
  now: number,
) {
  const { principals } = limit;
  const today = Math.floor(now / day);
  const windows = await Promise.all(
    [today - 1, today].map(async (period) => {
      const ids = await Promise.all(
        principals.map((principal) => visitorId(principal, period)),
      );
      const keys = ids.map(
        (id) =>
          "crypto-requests:" +
          limit.key +
          ":" +
          (period % 2) +
          ":" +
          id.slice(0, 3),
      );
      const buckets = await storage.get<Bucket>([...new Set(keys)]);
      const times = ids.flatMap((id, index) => {
        const bucket = buckets.get(keys[index]);
        return bucket?.day === period ? (bucket.visitors[id] ?? []) : [];
      });
      return { times, id: ids[0], key: keys[0], bucket: buckets.get(keys[0]) };
    }),
  );
  const recent = windows
    .flatMap((window) => window.times)
    .filter((at) => at > now - day)
    .sort((a, b) => a - b);
  const nextMinute = (recent.at(-limit.burst) ?? -Infinity) + minute;
  const nextDay = (recent.at(-limit.daily) ?? -Infinity) + day;
  const next = Math.max(nextMinute, nextDay);
  if (next > now)
    throw new HttpError(
      429,
      limit.key === "network"
        ? "This network is sending many questions. Try again later."
        : nextDay > nextMinute
          ? "You’ve reached 24 questions in 24 hours. Try again later."
          : "You can send two questions per minute. Try again shortly.",
      Math.ceil((next - now) / 1000),
      "crypto-question-limit",
    );
  const { id, key, bucket } = windows[1];
  const visitors = bucket?.day === today ? bucket.visitors : {};
  visitors[id] = [...(visitors[id] ?? []), now];
  return { key, bucket: { day: today, visitors } };
}
