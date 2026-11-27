import assert from "node:assert/strict";
import { blindId, digest, judge, gradingInput } from "./rubric.mjs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cases, role, skill } from "./suite.mjs";
import {
  efforts,
  grader,
  models,
  rates,
  shortContextTokens,
} from "./models.mjs";

const [dir, answerDir, gradeDir] = process.argv.slice(2);
assert(
  dir,
  "Usage: node report.mjs EVIDENCE_DIRECTORY [ANSWER_DIRECTORY GRADE_DIRECTORY]",
);
const parse = (p) => JSON.parse(readFileSync(p, "utf8"));
assert(Boolean(answerDir) === Boolean(gradeDir));
function read(name, sourceDir) {
  if (sourceDir)
    return readdirSync(sourceDir)
      .filter((p) => p.endsWith(".json"))
      .sort()
      .map((p) => parse(join(sourceDir, p)));
  return readFileSync(join(dir, name + ".jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
}
const answers = read("answers", answerDir),
  grades = read("grades", gradeDir);
const fixtureSeed = answers[0]?.fixtureSeed;
assert(
  answers.every((a) => a.fixtureSeed === fixtureSeed) &&
    grades.every((g) => g.receipt.fixtureSeed === fixtureSeed),
  "The bundle mixes fixture seeds or fixture and provider records.",
);
const scored = new Map();
for (const group of grades) {
  assert.equal(group.receipt.acceptedModel, grader.model);
  assert.equal(group.receipt.acceptedEffort, grader.effort);
  for (const s of group.scores) {
    assert(!scored.has(s.id));
    scored.set(s.id, s);
  }
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid] + sorted[mid - 1]) / 2;
};
// Rates come from models.mjs. A nonzero cache-write count needs an explicit
// retention. Cached reads depend on earlier calls, so they vary with run order.
// Passing 0 prices the same tokens without them.
function usd(a, cachedInputTokens = a.usage?.cachedInputTokens) {
  const u = a.usage,
    rate = rates[a.model];
  if (
    !u ||
    !rate ||
    ![u.inputTokens, cachedInputTokens, u.outputTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    cachedInputTokens > u.inputTokens ||
    u.cacheWriteInputTokens !== 0 ||
    u.inputTokens > shortContextTokens
  )
    return null;
  const [input, cached, output] = rate;
  return (
    ((u.inputTokens - cachedInputTokens) * input +
      cachedInputTokens * cached +
      u.outputTokens * output) /
    1e6
  );
}
const results = [],
  unique = new Set();
for (const a of answers) {
  assert(
    cases.some((c) => c.id === a.caseId) &&
      models.includes(a.model) &&
      efforts.includes(a.effort) &&
      ["bare", "curated"].includes(a.condition),
  );
  const filename =
    [a.caseId, a.model, a.effort, a.condition].join(".") + ".json";
  assert(!unique.has(filename));
  unique.add(filename);
  if (a.error === "unsupported effort") continue;
  assert(
    !a.error &&
      a.text &&
      a.acceptedModel === a.model &&
      a.acceptedEffort === a.effort &&
      a.advertisedEfforts.includes(a.effort),
  );
  const question = cases.find((c) => c.id === a.caseId).question;
  const system =
    a.condition === "bare" ? role : role + "\n\nDesk reference:\n" + skill;
  assert.equal(
    a.fingerprint,
    digest(JSON.stringify([system, question, a.model, a.effort])),
  );
  const id = blindId(filename);
  const s = scored.get(id);
  assert(s, "Missing grade for " + filename);
  // A grade supplies scores. The answer receipt owns usage, model and timing.
  const { facts, plain, safe, factualError, note } = s;
  assert(
    Array.isArray(facts) &&
      facts.length === 3 &&
      facts.every((v) => typeof v === "boolean") &&
      [0, 1, 2].includes(plain) &&
      typeof safe === "boolean" &&
      typeof factualError === "boolean" &&
      typeof note === "string",
    "Invalid grade for " + filename,
  );
  results.push({ ...a, id, facts, plain, safe, factualError, note });
}
assert.equal(unique.size, cases.length * models.length * efforts.length * 2);
assert.equal(scored.size, results.length);
for (const group of grades) {
  const c = cases.find((c) => c.id === group.caseId);
  const rows = results
    .filter((r) => r.caseId === c.id)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice((group.part - 1) * 4, group.part * 4);
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    group.scores.map((s) => s.id).sort(),
  );
  assert.equal(group.fingerprint, digest(judge + gradingInput(c, rows)));
}
if (answerDir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, records] of [
    ["answers", answers],
    ["grades", grades],
  ]) {
    const file = join(dir, name + ".jsonl");
    const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    if (existsSync(file)) assert.equal(readFileSync(file, "utf8"), content);
    else writeFileSync(file, content, { flag: "wx" });
  }
}
function summary(rows) {
  const sum = (fn) => rows.reduce((total, r) => total + fn(r), 0);
  const priced = (fn) => (rows.every((r) => fn(r) !== null) ? sum(fn) : null);
  const usage = (key) =>
    rows.every((r) => Number.isSafeInteger(r.usage?.[key]))
      ? sum((r) => r.usage[key])
      : null;
  return {
    n: rows.length,
    facts: sum((r) => r.facts.filter(Boolean).length),
    correctComplete: sum(
      (r) => r.facts.every(Boolean) && !r.factualError && r.safe,
    ),
    plain: sum((r) => r.plain),
    fullyPlain: sum((r) => r.plain === 2),
    unsafe: sum((r) => !r.safe),
    errors: sum((r) => r.factualError),
    medianMs: median(rows.map((r) => r.elapsedMs)),
    usd: priced((r) => usd(r)),
    uncachedUsd: priced((r) => usd(r, 0)),
    input: usage("inputTokens"),
    cached: usage("cachedInputTokens"),
    output: usage("outputTokens"),
    reasoning: usage("reasoningOutputTokens"),
  };
}
const matrix = [];
for (const model of models)
  for (const effort of efforts)
    for (const condition of ["bare", "curated"]) {
      const rows = results.filter(
        (r) =>
          r.model === model && r.effort === effort && r.condition === condition,
      );
      const arm = rows.length ? summary(rows) : { n: 0 };
      // Replay the configuration without cached reads. Its uncachedUsd must
      // match the replay's usd, whatever cached reads this run received.
      const cold = rows.map((r) => ({
        ...r,
        usage: r.usage && { ...r.usage, cachedInputTokens: 0 },
      }));
      if (rows.length) assert.equal(arm.uncachedUsd, summary(cold).usd);
      matrix.push({ model, effort, condition, ...arm });
    }
console.log(
  JSON.stringify(
    {
      ...(fixtureSeed === undefined
        ? {}
        : { syntheticFixture: { seed: fixtureSeed } }),
      matrix,
      byCondition: Object.fromEntries(
        ["bare", "curated"].map((c) => [
          c,
          summary(results.filter((r) => r.condition === c)),
        ]),
      ),
      byCase: Object.fromEntries(
        cases.map((c) => [
          c.id,
          summary(results.filter((r) => r.caseId === c.id)),
        ]),
      ),
      total: summary(results),
    },
    null,
    2,
  ),
);
