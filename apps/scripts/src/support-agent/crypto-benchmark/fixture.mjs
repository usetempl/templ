import assert from "node:assert/strict";
import { efforts, grader } from "./models.mjs";
import { digest, judge } from "./rubric.mjs";
import { cases } from "./suite.mjs";

// Offline synthetic adapter. With it, every step runs without a provider.
// Answers repeat a seeded selection of each case's criteria, sometimes with a
// marked unsafe or wrong line, and some efforts are withheld. Grading turns
// check each criterion and marker by exact text. CRYPTO_BENCH_FIXTURE_SEED
// changes these choices, and the same seed repeats them. These scores check
// the harness and say nothing about any model.
export const UNSAFE = "[synthetic unsafe advice]";
export const ERROR = "[synthetic factual error]";
export const fixtureSeed = process.env.CRYPTO_BENCH_FIXTURE_SEED ?? "0";
assert(
  /^\d{1,10}$/.test(fixtureSeed) && Number(fixtureSeed) <= 0xffffffff,
  "Use an unsigned 32-bit integer for CRYPTO_BENCH_FIXTURE_SEED.",
);
// A whole number below limit, fixed by the seed and labels.
const draw = (limit, ...labels) =>
  parseInt(digest(JSON.stringify([fixtureSeed, ...labels])).slice(0, 12), 16) %
  limit;

function answer(request, transcript) {
  const c = cases.find((item) => item.question === transcript);
  assert(c, "The fixture answers only suite questions.");
  const lines = c.facts.filter((_, i) => draw(4, "fact", request, i) !== 0);
  if (draw(16, "unsafe", request) === 0) lines.push(UNSAFE);
  if (draw(8, "error", request) === 0) lines.push(ERROR);
  return lines.join(" ") || "[synthetic reply without criteria]";
}

function grade({ facts, replies }) {
  const scores = replies.map(({ id, text }) => ({
    id,
    facts: facts.map((fact) => text.includes(fact)),
    plain: draw(3, "plain", id),
    safe: !text.includes(UNSAFE),
    factualError: text.includes(ERROR),
    note: "",
  }));
  const json = JSON.stringify(scores);
  // Some graders wrap their JSON in a code fence. grade.mjs removes it.
  return draw(2, "fence", json) ? "```json\n" + json + "\n```" : json;
}

export async function measure({ model, effort, system, transcript }) {
  const request = JSON.stringify([system, transcript, model, effort]);
  const advertisedEfforts =
    model === grader.model
      ? efforts
      : efforts.filter((e) => draw(8, "offer", model, e) !== 0);
  const receipt = {
    model,
    effort,
    acceptedModel: null,
    acceptedEffort: null,
    advertisedEfforts,
    usage: null,
    turnMs: null,
    elapsedMs: 1_000 + draw(9_000, "time", request),
  };
  if (!advertisedEfforts.includes(effort))
    return { ...receipt, error: "unsupported effort" };
  const text =
    system === judge
      ? grade(JSON.parse(transcript))
      : answer(request, transcript);
  const inputTokens = Math.ceil((system.length + transcript.length) / 4),
    outputTokens = Math.ceil(text.length / 4);
  return {
    ...receipt,
    acceptedModel: model,
    acceptedEffort: effort,
    usage: {
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      cachedInputTokens: draw(inputTokens + 1, "cached", request),
      // A rare cache write leaves that reply without a cost estimate.
      cacheWriteInputTokens: draw(64, "write", request) ? 0 : 1,
      outputTokens,
      reasoningOutputTokens: draw(outputTokens + 1, "reasoning", request),
    },
    text,
  };
}
