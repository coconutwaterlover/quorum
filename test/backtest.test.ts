import assert from "node:assert/strict";
import { test } from "node:test";
import { backtest, type BacktestLeg } from "../src/engine/backtest";
import type { Outcome } from "../src/engine/correlation";
import { equalWeights } from "../src/engine/quote";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

/** Deterministic pseudo-random bits, so a variance claim is reproducible. */
function bits(n: number, seed: number): (0 | 1)[] {
  let state = seed;
  return Array.from({ length: n }, () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return ((state >> 16) & 1) as 0 | 1;
  });
}

function history(seriesBits: Record<string, (0 | 1)[]>, step = 900): Map<string, Outcome[]> {
  const out = new Map<string, Outcome[]>();
  for (const [key, values] of Object.entries(seriesBits)) {
    out.set(key, values.map((up, i) => ({ expiry: 1_000_000 + i * step, up })));
  }
  return out;
}

function legs(keys: string[]): BacktestLeg[] {
  const weights = equalWeights(keys.length);
  return keys.map((series, i) => ({ series, weightBp: weights[i], side: "UP" as const }));
}

test("an index of independent series is measurably calmer than one of them", () => {
  const keys = ["A|15m", "B|15m", "C|15m", "D|15m", "E|15m", "F|15m", "G|15m", "H|15m"];
  const data = history(Object.fromEntries(keys.map((k, i) => [k, bits(400, 7 + i * 977)])));
  const result = backtest(data, { legs: legs(keys), assumedEntryPrice: 0.5 });

  assert.equal(result.rolls, 400);
  assert.ok(result.index.sd < result.singleLeg.sd, `${result.index.sd} !< ${result.singleLeg.sd}`);
  assert.ok(result.sdReduction! > 0.5, `expected over half the sd removed, got ${result.sdReduction}`);
  // Same entry price on both sides, so the means are the thing that must not diverge.
  assert.ok(Math.abs(result.index.mean - result.singleLeg.mean) < 0.06);
});

test("identical series diversify nothing at all", () => {
  const shared = bits(200, 31);
  const data = history({ "A|15m": shared, "B|15m": [...shared], "C|15m": [...shared] });
  const result = backtest(data, { legs: legs(["A|15m", "B|15m", "C|15m"]), assumedEntryPrice: 0.5 });
  close(result.index.sd, result.singleLeg.sd, 1e-9);
  close(result.sdReduction!, 0, 1e-9);
});

test("an index never wipes out unless every leg loses", () => {
  const data = history({ "A|15m": [1, 0, 0, 1], "B|15m": [0, 0, 1, 1] });
  const result = backtest(data, { legs: legs(["A|15m", "B|15m"]), assumedEntryPrice: 0.5 });
  assert.equal(result.index.wipeouts, 1); // only the window where both lost
  assert.equal(result.singleLeg.wipeouts, 2);
});

test("equity is cumulative profit, so a fairly priced coin flip ends near zero", () => {
  const data = history({ "A|15m": [1, 0, 1, 0] });
  const result = backtest(data, { legs: legs(["A|15m"]), assumedEntryPrice: 0.5 });
  assert.deepEqual([...result.index.equity], [0.5, 0, 0.5, 0]);
  close(result.index.total, 0);
  close(result.index.maxDrawdown, 0.5);
});

test("a Down leg is the complement of its window", () => {
  const data = history({ "A|15m": [1, 1, 0] });
  const result = backtest(data, {
    legs: [{ series: "A|15m", weightBp: 10_000, side: "DOWN" }],
    assumedEntryPrice: 0.5,
  });
  assert.deepEqual([...result.index.payoffs], [0, 0, 1]);
});

test("a leg with only two settled windows caps the replay at two rolls", () => {
  const data = history({ "A|15m": [1, 0, 1, 1, 0], "B|15m": [1, 0] });
  const result = backtest(data, { legs: legs(["A|15m", "B|15m"]), assumedEntryPrice: 0.5 });
  // B is the shorter series, so it drives — and every one of its windows finds
  // an A counterpart, so nothing is skipped.
  assert.equal(result.driverSeries, "B|15m");
  assert.equal(result.rolls, 2);
  assert.equal(result.skippedIncompleteWindows, 0);
});

test("a driver window with no counterpart is skipped rather than half-filled", () => {
  const data = history({
    "A|15m": [1, 0, 1],
    // Same length, but offset past the pairing tolerance for a 15m cadence.
    "B|15m": [1, 0, 1].map((up, i) => up) as (0 | 1)[],
  });
  const shifted = new Map(data);
  shifted.set("B|15m", [{ expiry: 9_000_000, up: 1 }, { expiry: 9_000_900, up: 0 }, { expiry: 9_001_800, up: 1 }]);
  const result = backtest(shifted, { legs: legs(["A|15m", "B|15m"]), assumedEntryPrice: 0.5 });
  assert.equal(result.rolls, 0);
  assert.equal(result.skippedIncompleteWindows, 3);
});

test("maxRolls keeps the most recent windows", () => {
  const data = history({ "A|15m": [1, 1, 1, 0, 0] });
  const result = backtest(data, { legs: legs(["A|15m"]), assumedEntryPrice: 0.5, maxRolls: 2 });
  assert.deepEqual([...result.index.payoffs], [0, 0]);
  assert.equal(result.rolls, 2);
});

test("a realized print overrides the assumption, and is reported as such", () => {
  const data = history({ "A|15m": [1, 1] });
  const realized = new Map([["A|15m|1000000", 0.8]]);
  const result = backtest(data, { legs: legs(["A|15m"]), assumedEntryPrice: 0.5 }, realized);
  assert.equal(result.rollsWithRealizedPrice, 1);
  close(result.entryPrice, (0.8 + 0.5) / 2, 1e-9);
});

test("an empty history is an empty result, not a crash", () => {
  const result = backtest(new Map(), { legs: legs(["A|15m"]), assumedEntryPrice: 0.5 });
  assert.equal(result.rolls, 0);
  assert.equal(result.sdReduction, null);
});

test("the coarsest leg sets the roll clock, so a mixed basket still replays", () => {
  // 96 fifteen-minute windows spanning one day, and one daily window inside it.
  const fine = Array.from({ length: 96 }, (_, i) => ({ expiry: 1_000_000 + i * 900, up: (i % 2) as 0 | 1 }));
  const coarse = [{ expiry: 1_000_000 + 95 * 900, up: 1 as const }];
  const data = new Map([
    ["BTC|15m", fine],
    ["BTC|24h", coarse],
  ]);
  const result = backtest(data, {
    legs: [
      { series: "BTC|15m", weightBp: 5000, side: "UP" },
      { series: "BTC|24h", weightBp: 5000, side: "UP" },
    ],
    assumedEntryPrice: 0.5,
  });
  assert.equal(result.driverSeries, "BTC|24h");
  assert.equal(result.tolSec, 43_200);
  assert.equal(result.rolls, 1);
});

test("a same-cadence basket replays every window it has", () => {
  const data = history({ "A|15m": bits(120, 5), "B|15m": bits(120, 91) });
  const result = backtest(data, { legs: legs(["A|15m", "B|15m"]), assumedEntryPrice: 0.5 });
  assert.equal(result.rolls, 120);
  assert.equal(result.tolSec, 450);
  assert.equal(result.skippedIncompleteWindows, 0);
});
