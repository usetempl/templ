import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { checkedManagedAnswer, spendMonth } from "@templ/chat/managed-agent";
import {
  isStandardAiModel,
  standardAiUsageUsdNanos,
} from "@templ/chat/standard-usage";
import { prepaidAiMaximum } from "../product-prepaid-ai";
import { detectStoredSecret } from "../secret-guard";
import { readKnowledgeContext } from "../support-knowledge-kb";
import {
  KnowledgeError,
  readMeta,
  writeMeta,
  type KnowledgeDb,
} from "../support-knowledge-schema";
import { fundedGptCaller, type GptFunding } from "./gpt";
import {
  GROUNDED_SYSTEM,
  GROUNDED_VERIFIER_SYSTEM,
  groundedPassages,
  groundedSafeText,
  groundedSensitive,
  groundedSources,
  groundedVerifierAccepted,
} from "./grounded";
import type { TemplMeter } from "./runner";
import type { ManagedKnowledgeEnv } from "./knowledge-hooks";

// A rollback must still be able to read the original five entries.
const originalKey = "managed.trial-practice.v1";
const additionalKey = "managed.trial-practice.additional.v1";
const originalCapacity = 5;
const limit = PRODUCT_LIMITS.freeAiPracticeQuestions;
const error = (status: number, text: string) =>
  new KnowledgeError(status, "trial-ai-practice", text);
const toCents = (nanos: string) =>
  Number((BigInt(nanos) + 9_999_999n) / 10_000_000n);

function readAttempts(db: KnowledgeDb, key: string, capacity: number): string[] {
  const value = JSON.parse(readMeta(db, key) ?? "[]");
  if (
    !Array.isArray(value) ||
    value.length > capacity ||
    !value.every((id) => typeof id === "string")
  )
    throw error(503, "AI practice could not load.");
  return value;
}

function attempts(db: KnowledgeDb): string[] {
  return [
    ...readAttempts(db, originalKey, originalCapacity),
    ...readAttempts(db, additionalKey, limit - originalCapacity),
  ];
}

function saveAttempts(db: KnowledgeDb, ids: string[]) {
  writeMeta(db, originalKey, JSON.stringify(ids.slice(0, originalCapacity)));
  if (ids.length > originalCapacity || readMeta(db, additionalKey) != null)
    writeMeta(db, additionalKey, JSON.stringify(ids.slice(originalCapacity)));
}

// A practice question can make two calls. Each holds its own maximum against
// Templ's budget. Neither call can write a customer's balance or usage ledger.
// A model the rate card cannot price is refused before inference.
export function templFundedInference(meter: Pick<TemplMeter, "reserve" | "settle">, cap: number): GptFunding {
  const holds = new Map<string, { month: string; cents: number }>();
  return {
    async reserve(input) {
      if (!isStandardAiModel(input.model)) return false;
      const cents = toCents(
        prepaidAiMaximum(input.maxOutputTokens, 1, input.inputTokens, input.model),
      );
      const month = spendMonth(Date.now());
      if (!(await meter.reserve(month, input.attemptId, cents, cap)))
        return false;
      holds.set(input.attemptId, { month, cents });
      return true;
    },
    async settle(input) {
      const hold = holds.get(input.attemptId);
      if (!hold) throw error(503, "AI practice could not confirm usage.");
      const nanos =
        input.usage && standardAiUsageUsdNanos(input.model, input.usage, 1);
      const actual = nanos === null ? hold.cents : toCents(nanos);
      await meter.settle(hold.month, input.attemptId, actual);
      return { available: nanos !== null && actual <= hold.cents };
    },
  };
}

/** `accepted` runs once, after this question's attempt is reserved and before
 * any model call. It never runs for a refusal or a balance read. */
export async function trialPractice(
  db: KnowledgeDb,
  env: ManagedKnowledgeEnv,
  meter: TemplMeter,
  args: Record<string, unknown>,
  accepted: () => void = () => {},
) {
  const cap = Number(env.MANAGED_AGENT_SPEND_CAP_USD_CENTS);
  const gatewayId = env.MANAGED_AGENT_GATEWAY_ID;
  if (
    env.MANAGED_AGENT_ENABLED !== "true" ||
    env.SUPPORT_TRIAL_AI_PRACTICE_ENABLED !== "true"
  )
    throw error(503, "AI practice is unavailable.");
  if (args.question === undefined)
    return { remaining: limit - attempts(db).length };
  if (!env.AI || !gatewayId || !Number.isSafeInteger(cap) || cap <= 0)
    throw error(503, "AI practice is unavailable.");
  const { requestId, question } = args;
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      requestId,
    ) ||
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 800 ||
    (await detectStoredSecret(question))
  )
    throw error(400, "Enter a product question of up to 800 characters.");
  const sources = await groundedPassages(db, null, Date.now(), question);
  sources.hits = (
    await Promise.all(
      sources.hits.map(async (hit) => {
        if (
          hit.visibility !== "member-safe" ||
          hit.era !== "current" ||
          hit.archivedAt ||
          (await detectStoredSecret([hit.excerpt, hit.url].join("\n")))
        )
          return null;
        return hit;
      }),
    )
  ).filter((hit) => hit !== null);
  if (!sources.hits.length)
    throw error(409, "Add a public page before asking a practice question.");
  const remaining = db.transaction(() => {
    const used = attempts(db);
    if (used.includes(requestId))
      throw error(409, "This question was already submitted.");
    if (used.length >= limit)
      throw error(409, "You’ve used your free AI questions.");
    saveAttempts(db, [...used, requestId]);
    return limit - used.length - 1;
  });
  accepted();
  const handoff = { remaining, answer: null };
  if (groundedSensitive(question)) return handoff;
  const model = fundedGptCaller(
    { ai: env.AI, gatewayId },
    templFundedInference(meter, cap),
  );
  const result = await model({
    system: GROUNDED_SYSTEM,
    user: JSON.stringify({
      question,
      passages: sources.hits.map(({ sourceId, excerpt, url }) => ({
        sourceId,
        text: excerpt,
        url,
      })),
    }),
  });
  if (result.kind === "failed") {
    if (result.providerAttempted === false) {
      db.transaction(() =>
        saveAttempts(db, attempts(db).filter((id) => id !== requestId)),
      );
    }
    throw error(503, "AI could not finish this practice question.");
  }
  if (result.kind !== "answer") return handoff;
  let answer;
  try {
    answer = checkedManagedAnswer(result.value, {
      sourceIds: new Set(sources.hits.map((hit) => hit.sourceId)),
    });
  } catch {
    return handoff;
  }
  const hits = groundedSources(answer, sources);
  if (
    !hits ||
    !["reply", "resolve"].includes(answer.action) ||
    answer.confidence !== "high" ||
    !groundedSafeText(answer.text, hits) ||
    (await detectStoredSecret(answer.text))
  )
    return handoff;
  const verification = await model({
    system: GROUNDED_VERIFIER_SYSTEM,
    user: JSON.stringify({
      answer: answer.text,
      passages: hits.map(({ sourceId, excerpt, url }) => ({
        sourceId,
        text: excerpt,
        url,
      })),
    }),
  });
  if (verification.kind === "failed")
    throw error(503, "AI could not check this practice answer.");
  if (
    !groundedVerifierAccepted(verification, hits) ||
    (await readKnowledgeContext(db, { storageGrant: null, now: Date.now() }))
      .version !== sources.version
  )
    return handoff;
  return { remaining, answer: answer.text };
}
