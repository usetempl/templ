# Public Crypto Support model benchmark

Compare fresh answers for Templ’s crypto support desk under two conditions. Both receive the same role, question and safety instructions. The curated condition also receives the same set of short reference notes on every turn. The suite covers Bitcoin, Solana, Ethereum and its layer 2 networks, DeFi apps and wallets, with two questions per topic.

This measures the answer model with reference notes supplied directly. A live desk also has retrieval, routing, reviewed replies, quotas and delivery. The benchmark leaves those out.

The [desk’s reviewed FAQ](../../../../../packages/chat/knowledge/crypto-help-desk.json) pairs each answer with its official sources. When changing an answer, check that the source still supports the steps. The [link registry](../../../../../packages/chat/src/crypto-help-links.ts) supplies the names visitors see under Sources.

## Try the offline fixture

Use Node 22 or newer. These eight files run together without installing packages. From the repository root, use the path below. If you copied the files into one folder, open that folder and set `bench=.` instead. The commands create synthetic answers, grades and a report. No model runs. The report identifies the simulation in its `syntheticFixture` field and records the seed. Use a fresh output directory for each experiment.

```sh
bench=apps/scripts/src/support-agent/crypto-benchmark
adapter="$bench/fixture.mjs"
run_dir="$(mktemp -d)"
node "$bench/run.mjs" "$adapter" "$run_dir/answers"
node "$bench/grade.mjs" "$adapter" "$run_dir/answers" "$run_dir/grades"
node "$bench/report.mjs" "$run_dir/evidence" "$run_dir/answers" "$run_dir/grades"
```

Four answer workers process the 160 requests in a fixed shuffled order. Each completed turn writes a new receipt. A restart reuses completed receipts only when their prompt fingerprints match. An unsupported effort is recorded and skipped. Other failures stop new work. Preserve a failed receipt outside the answers directory before retrying its case. Four calls can already be in flight.

## Collect real answers

To collect measurements, supply a provider adapter for both the answer and grading commands. This public package includes the offline fixture. Your provider sets the access requirements and charges for real turns. Keep credentials and private cases out of inputs and evidence.

[models.mjs](models.mjs) names the compared models and efforts, the grader setting and the token rates. An adapter is an ES module that exports `measure({ model, effort, system, transcript })`. Each call sends one fresh text turn with `system` as its instructions and `transcript` as the only user message. The turn has no tools or earlier messages. `measure` resolves to a receipt with these fields:

- `acceptedModel` and `acceptedEffort` give the setting the provider reports for the turn. Take them from the provider’s response, never from the request. Grading and the report reject a mismatch.
- `advertisedEfforts` lists the efforts the provider offers for the model.
- `usage` has `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens` and `reasoningOutputTokens`, or is `null`. Input includes cached reads. Output includes reasoning.
- `elapsedMs` is the call’s wall time. `turnMs` is the provider’s own turn time, or `null`.
- `text` holds the reply. A failed call sets `error`. If its provider also supplies partial text, the harness preserves the failed receipt and excludes that text from grading. Use the error `unsupported effort` when the provider doesn’t offer the requested effort.

The run records the case, condition, prompt fingerprint, start time, model and effort itself. It stops if an adapter changes them or returns neither `text` nor `error`.

The accepted effort is the setting the provider reports. The compute behind it can stay private. For example, a short answer can report zero reasoning tokens at high effort.

[fixture.mjs](fixture.mjs) answers with a seeded selection of each case’s criteria. Some answers add a marked unsafe or wrong line, and some efforts are withheld. Its grader checks each criterion and marker by exact text. `CRYPTO_BENCH_FIXTURE_SEED` changes these choices, and the same seed repeats them. Fixture scores check the harness and say nothing about any model.

## Questions, references and grading

The cases, reference notes and criteria live in [suite.mjs](suite.mjs). Each criterion points to the protocol or wallet operator’s public documentation. The notes and questions are original summaries. The benchmark distributes source links and contains no copied documentation or datasets. The Solana simulation distinction is also documented by the [Solana simulation RPC](https://solana.com/docs/rpc/http/simulatetransaction).

ETHSkills helped identify wallet and network questions. Its [repository at the reviewed revision](https://github.com/austintgriffith/ethskills/tree/47779e720e99c0d5014c0612a08500bdd565108f) identifies its license as MIT. The desk notes rely on the network and wallet operators for the facts that enter grading. DeFiLlama’s [Aave listing](https://defillama.com/protocol/aave) and [Uniswap listing](https://defillama.com/protocol/uniswap) were used to find those projects. Each project’s own help center supplied its grading criteria.

The grader uses separate GPT-6.2 Astra Medium turns. It receives four answers at a time with opaque IDs, the common question and three prewritten factual criteria. It never sees the answerer’s model, effort, notes, usage or timing. It scores each factual criterion separately, rates language from 0 to 2, and flags unsafe advice or factual errors. The grading prompt lives in [rubric.mjs](rubric.mjs) and [grade.mjs](grade.mjs) validates the returns. This is a model judgment. Each grade record keeps its deductions and their reasons for review.

The report counts an answer as complete when it meets all three criteria and has no factual or safety flag. A plain-language score of 2 means a beginner can follow the answer on the first read. Median time uses each receipt’s `elapsedMs`. Cost uses each receipt’s token counts and the November 27 Standard API rates in models.mjs. The rates come from [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and the [Terra model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra). A missing input or output count, an unknown model rate, a missing or nonzero cache-write count, or more than 272,000 input tokens leaves no cost estimate. A missing cache-read count leaves `usd` unknown; the full-input estimate can still be calculated.

`usd` uses the cached rate for each call’s cached reads. Calls with the same prompt can get different cached reads, depending on earlier calls, so `usd` can change with run order. `uncachedUsd` prices every input token at the uncached rate. Use it to compare models, effort levels and conditions. The report replays every receipt without cached reads and stops if any matrix row’s `uncachedUsd` differs from that replay’s `usd`.

## Replay previously collected evidence

Report replay reads local files and makes no model calls. With answer and grade directories, the report also writes `answers.jsonl` and `grades.jsonl` to the evidence directory. It refuses to replace a different bundle. Pass only the evidence directory to recompute the report from that bundle offline.

```sh
node "$bench/report.mjs" "$run_dir/evidence"
```

Before it counts anything, the report checks each prompt fingerprint, blind ID and grading fingerprint. Edited reply text, or a changed role, question, note, criterion or grading prompt, stops it.
