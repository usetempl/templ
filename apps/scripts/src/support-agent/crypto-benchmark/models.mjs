// Compared settings. Adapters receive these model and effort names.
export const models = ["gpt-6.2-sol", "gpt-6.1-terra"];
export const efforts = ["low", "medium", "high", "xhigh"];
// Grading turns use this setting with the rubric prompt.
export const grader = { model: "gpt-6.2-astra", effort: "medium" };
// Standard USD per million input, cached-input and output tokens on 2026-11-27.
// They apply up to shortContextTokens input tokens. Reasoning is part of
// output. A model without a rate gets no cost estimate.
export const rates = {
  "gpt-6.2-sol": [2, 0.1, 10],
  "gpt-6.1-terra": [1, 0.05, 5],
};
export const shortContextTokens = 272_000;
