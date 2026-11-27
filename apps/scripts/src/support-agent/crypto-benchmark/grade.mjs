import assert from "node:assert/strict";
import { blindId, digest, judge, gradingInput } from "./rubric.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cases } from "./suite.mjs";
import { efforts, grader, models } from "./models.mjs";

const [adapter, input, output] = process.argv.slice(2);
assert(
  adapter && input && output,
  "Usage: node grade.mjs ADAPTER_MODULE ANSWER_DIRECTORY GRADE_DIRECTORY",
);
const { measure, fixtureSeed } = await import(
  pathToFileURL(resolve(adapter)).href
);
assert.equal(typeof measure, "function", "The adapter must export measure.");
const answers = resolve(input),
  grades = resolve(output);
mkdirSync(grades, { recursive: true });
const jobs = [];
for (const c of cases) {
  const rows = [];
  for (const model of models)
    for (const effort of efforts)
      for (const condition of ["bare", "curated"]) {
        const filename = [c.id, model, effort, condition].join(".") + ".json";
        const row = JSON.parse(readFileSync(join(answers, filename), "utf8"));
        assert.equal(
          row.fixtureSeed,
          fixtureSeed,
          "The answer and grade adapters must use the same fixture seed or both collect provider turns.",
        );
        if (row.error === "unsupported effort") continue;
        assert(
          !row.error &&
            row.text &&
            row.caseId === c.id &&
            row.acceptedModel === model &&
            row.acceptedEffort === effort,
        );
        rows.push({
          filename,
          text: row.text,
          id: blindId(filename),
        });
      }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < rows.length; i += 4)
    jobs.push({ c, part: 1 + i / 4, rows: rows.slice(i, i + 4) });
}
let stop = false;
async function worker() {
  while (!stop && jobs.length) {
    const { c, part, rows } = jobs.shift();
    const transcript = gradingInput(c, rows);
    const fingerprint = digest(judge + transcript);
    const path = join(grades, c.id + "." + part + ".json");
    if (existsSync(path)) {
      const prior = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(
        prior.receipt.fixtureSeed,
        fixtureSeed,
        "Use a fresh grade directory for another fixture or provider run.",
      );
      assert(prior.fingerprint === fingerprint && prior.scores);
      continue;
    }
    const result = await measure({
      model: grader.model,
      effort: grader.effort,
      system: judge,
      transcript,
    });
    try {
      assert(!result.error, result.error);
      const scores = JSON.parse(
        result.text
          .trim()
          .replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ""),
      );
      assert(Array.isArray(scores) && scores.length === rows.length);
      for (const row of rows) {
        const matches = scores.filter((s) => s.id === row.id);
        assert.equal(matches.length, 1);
        const s = matches[0];
        assert(
          Array.isArray(s.facts) &&
            s.facts.length === 3 &&
            s.facts.every((x) => typeof x === "boolean"),
        );
        assert(
          [0, 1, 2].includes(s.plain) &&
            typeof s.safe === "boolean" &&
            typeof s.factualError === "boolean" &&
            typeof s.note === "string",
        );
      }
      const receipt = { ...result, fixtureSeed };
      delete receipt.text;
      writeFileSync(
        path,
        JSON.stringify(
          { fingerprint, caseId: c.id, part, receipt, scores },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      console.log(c.id, part, "graded");
    } catch {
      stop = true;
      writeFileSync(path + ".failed", JSON.stringify(result, null, 2), {
        flag: "wx",
      });
      console.error(
        "Unusable grade; preserved the attempt for review:",
        c.id,
        part,
      );
    }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
if (stop) process.exitCode = 1;
