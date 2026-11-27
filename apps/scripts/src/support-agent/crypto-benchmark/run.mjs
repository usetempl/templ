import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cases, role, skill } from "./suite.mjs";
import { efforts, models } from "./models.mjs";

const [adapter, target] = process.argv.slice(2);
assert(
  adapter && target,
  "Usage: node run.mjs ADAPTER_MODULE NEW_OR_RESUMABLE_OUTPUT_DIRECTORY",
);
const { measure, fixtureSeed } = await import(
  pathToFileURL(resolve(adapter)).href
);
assert.equal(typeof measure, "function", "The adapter must export measure.");
const dir = resolve(target);
mkdirSync(dir, { recursive: true });
const digest = (text) => createHash("sha256").update(text).digest("hex");
const jobs = [];
for (const item of cases)
  for (const model of models)
    for (const effort of efforts)
      for (const condition of ["bare", "curated"]) {
        const key = [item.id, model, effort, condition].join(".");
        const system =
          condition === "bare" ? role : role + "\n\nDesk reference:\n" + skill;
        jobs.push({
          key,
          item,
          model,
          effort,
          condition,
          system,
          fingerprint: digest(
            JSON.stringify([system, item.question, model, effort]),
          ),
        });
      }
jobs.sort((a, b) => digest("v1/" + a.key).localeCompare(digest("v1/" + b.key)));
const pending = jobs.filter(({ key, fingerprint }) => {
  const path = join(dir, key + ".json");
  if (!existsSync(path)) return true;
  const prior = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(
    prior.fingerprint,
    fingerprint,
    "Input mismatch; choose a fresh output directory.",
  );
  assert.equal(
    prior.fixtureSeed,
    fixtureSeed,
    "Choose a fresh output directory for a different fixture seed or provider run.",
  );
  assert(
    prior.error === "unsupported effort" ||
      (!prior.error && typeof prior.text === "string" && prior.text.trim()),
    "A previous attempt failed. Preserve its receipt before retrying: " + key,
  );
  return false;
});
let done = jobs.length - pending.length;
let stop = false;
async function worker() {
  while (!stop && pending.length) {
    const { key, item, model, effort, condition, system, fingerprint } =
      pending.shift();
    const path = join(dir, key + ".json");
    const startedAt = new Date().toISOString();
    const result = await measure({
      model,
      effort,
      system,
      transcript: item.question,
    });
    // The harness owns these fields. The adapter adds the provider's readback,
    // usage, timing and the reply or failure.
    const owned = {
      caseId: item.id,
      condition,
      fingerprint,
      startedAt,
      fixtureSeed,
      model,
      effort,
    };
    const record = { ...owned, ...result };
    assert(
      Object.entries(owned).every(([k, v]) => record[k] === v) &&
        (record.error != null
          ? typeof record.error === "string" && record.error.trim() !== ""
          : typeof record.text === "string" && record.text.trim() !== ""),
      "Unusable adapter receipt for " + key,
    );
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    console.log(++done, key, result.error ?? result.elapsedMs);
    if (result.error && result.error !== "unsupported effort") stop = true;
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
if (stop) process.exitCode = 1;
