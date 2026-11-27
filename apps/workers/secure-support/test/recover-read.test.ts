import { simulate } from "@templ/chat/simulation.test.helpers";
import {afterEach, expect, it, vi} from "vitest";
import {readOwnRecoveredRecord} from "../client/recover-read";
afterEach(() => vi.useRealTimers());
const unavailable = () => Object.assign(new Error("Unavailable"), {status: 503});
simulate("independent reads wait for their own retry and return only their final result", async (draw) => {
  vi.useFakeTimers({now: 0});
  const later = draw.pick([401, 403, 429, 500]);
  const plans = draw.shuffle([[200], [503, 200], [503, 503, 200], [503, 503, 503], [503, later]]);
  const pending = plans.map((plan, index) => {
    const times: number[] = [];
    const envelopes = plan.map((status, step) => ({encrypted: `envelope-${index}-${step}`, status}));
    const errors = plan.map(status => Object.assign(new Error("Unavailable"), {status}));
    const read = async () => {
      const step = times.length;
      times.push(Date.now());
      if (plan[step] !== 200) throw errors[step];
      return envelopes[step];
    };
    const result = readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true});
    const last = plan.length - 1;
    const checked = plan[last] === 200
      ? expect(result).resolves.toBe(envelopes[last])
      : expect(result).rejects.toBe(errors[last]);
    return {times, plan, checked};
  });
  for (const at of [249, 250, 749, 750]) {
    await vi.advanceTimersByTimeAsync(at - Date.now());
    for (const {times, plan} of pending)
      expect(times).toEqual([0, 250, 750].slice(0, plan.length).filter(t => t <= at));
  }
  await Promise.all(pending.map(p => p.checked));
});
it.each([400,401,403,404,409,429,500,502,504])("does not retry a %i refusal", async status => {
  const error = Object.assign(new Error("Refused"), {status}), read = vi.fn(async () => {throw error;});
  await expect(readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true})).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});
it("does not start on a closed page", async () => {
  const controller = new AbortController(); controller.abort(); const read = vi.fn();
  await expect(readOwnRecoveredRecord(read, {signal: controller.signal, active: () => true})).rejects.toMatchObject({name: "AbortError"});
  expect(read).not.toHaveBeenCalled();
});
it("aborting during backoff prevents another read", async () => {
  vi.useFakeTimers(); const controller = new AbortController(), read = vi.fn(async () => {throw unavailable();});
  const result = readOwnRecoveredRecord(read, {signal: controller.signal, active: () => true});
  const refused = expect(result).rejects.toMatchObject({name: "AbortError"});
  await vi.advanceTimersByTimeAsync(1); controller.abort(); await refused;
  await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(1);
});
it("a scope change discards a late successful read", async () => {
  let active = true; const read = vi.fn(async () => {active = false; return {encrypted: "old scope"};});
  await expect(readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => active})).rejects.toMatchObject({name: "AbortError"});
  expect(read).toHaveBeenCalledTimes(1);
});
it("a scope change after503 prevents another read", async () => {
  let active = true; const read = vi.fn(async () => {active = false; throw unavailable();});
  await expect(readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => active})).rejects.toMatchObject({name: "AbortError"});
  expect(read).toHaveBeenCalledTimes(1);
});
