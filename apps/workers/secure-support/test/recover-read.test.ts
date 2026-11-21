import {afterEach, expect, it, vi} from "vitest";
import {readOwnRecoveredRecord} from "../client/recover-read";
afterEach(() => vi.useRealTimers());
const unavailable = () => Object.assign(new Error("Unavailable"), {status: 503});
it("returns a successful authorized read without retry", async () => {
  const read = vi.fn(async () => ({encrypted: "same envelope"}));
  await expect(readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true})).resolves.toEqual({encrypted: "same envelope"});
  expect(read).toHaveBeenCalledTimes(1);
});
it("repeats only the supplied read after503 and returns only the fresh successful result", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({encrypted: "fresh envelope"});
  const result = readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true});
  await vi.advanceTimersByTimeAsync(250); expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toEqual({encrypted: "fresh envelope"}); expect(read).toHaveBeenCalledTimes(3);
});
it.each([400,401,403,404,409,429,500,502,504])("does not retry a %i refusal", async status => {
  const error = Object.assign(new Error("Refused"), {status}), read = vi.fn(async () => {throw error;});
  await expect(readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true})).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});
it("exhausts503 including wrapped revocation without returning old data", async () => {
  vi.useFakeTimers();
  const error = unavailable(), read = vi.fn(async () => {throw error;});
  const result = readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true});
  const refused = expect(result).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(750); await refused; expect(read).toHaveBeenCalledTimes(3);
});
it("stops on a403 following an interrupted read", async () => {
  vi.useFakeTimers();
  const error = Object.assign(new Error("Revoked"), {status: 403});
  const read = vi.fn().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(error);
  const refused = expect(readOwnRecoveredRecord(read, {signal: new AbortController().signal, active: () => true})).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(250); await refused; expect(read).toHaveBeenCalledTimes(2);
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
