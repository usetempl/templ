import { it } from "vitest";

export type Rng = {
  readonly seed: number;
  next(): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  text(alphabet: string | readonly string[], length: number): string;
};

const FIRST_SEED = 20_261_126;
const MAX_RUNS = 10_000;

export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (!items.length) throw new Error("A scenario picked from an empty list.");
    return items[int(0, items.length - 1)];
  };
  return {
    seed,
    next,
    int,
    pick,
    chance: (probability) => next() < probability,
    shuffle: (items) => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(0, index);
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
    text: (alphabet, length) => {
      const symbols = typeof alphabet === "string" ? Array.from(alphabet) : alphabet;
      return Array.from({ length }, () => pick(symbols)).join("");
    },
  };
}

function uint32(name: string, value: string, max = 0xffff_ffff) {
  const parsed = Number(value);
  if (!/^\d{1,10}$/.test(value) || parsed > max)
    throw new Error(`${name} must be a whole number up to ${max}.`);
  return parsed;
}

export function simulationSeeds(runs: number): number[] {
  const replay = process.env.TEMPL_SCENARIO_SEED;
  if (replay) return [uint32("TEMPL_SCENARIO_SEED", replay)];
  const requested = process.env.TEMPL_SCENARIO_RUNS;
  const count = requested
    ? uint32("TEMPL_SCENARIO_RUNS", requested, MAX_RUNS)
    : runs;
  if (!Number.isInteger(count) || count < 1 || count > MAX_RUNS)
    throw new Error("TEMPL_SCENARIO_RUNS must be between 1 and 10000.");
  return Array.from({ length: count }, (_, index) => FIRST_SEED + index);
}

export function simulate(
  name: string,
  scenario: (random: Rng) => unknown,
  options: { runs?: number; timeout?: number } = {},
) {
  for (const seed of simulationSeeds(options.runs ?? 8))
    it(
      `${name} [seed ${seed}]`,
      async () => {
        try {
          await scenario(rng(seed));
        } catch (error) {
          if (error instanceof Error)
            error.message += `\nReplay with TEMPL_SCENARIO_SEED=${seed}.`;
          throw error;
        }
      },
      options.timeout,
    );
}
