import assert from "node:assert/strict";
import { test } from "node:test";
import { BP } from "../src/engine/distribution";
import { equalWeights, payoffShapes, quoteIndex } from "../src/engine/quote";
import type { Leg, WeightedLeg } from "../src/engine/types";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

function leg(overrides: Partial<Leg> & { bid: number | null; ask: number | null }): Leg {
  const mid =
    overrides.bid !== null && overrides.ask !== null
      ? (overrides.bid + overrides.ask) / 2
      : (overrides.bid ?? overrides.ask);
  return {
    marketId: overrides.marketId ?? "0x01",
    series: overrides.series ?? "BTC|15m",
    asset: "BTC",
    interval: "15m",
    side: "UP",
    symbol: "BTC#YES",
    yesSymbol: "BTC#YES",
    poolAddress: "0xpool",
    marketAddress: "0xmarket",
    expiry: 1_000_000,
    tradingStart: 999_100,
    strike: null,
    question: "BTC closes at or above its opening price",
    venueId: "0xvenue",
    oracleQuestionId: null,
    decimals: 6,
    askSize: 200,
    mid,
    ...overrides,
  };
}

function basket(prices: { bid: number | null; ask: number | null }[]): WeightedLeg[] {
  const weights = equalWeights(prices.length);
  return prices.map((p, i) => ({
    ...leg({ ...p, marketId: `0x0${i}`, series: `S${i}|15m` }),
    weightBp: weights[i],
  }));
}

test("fair value is the mid, cost is the ask, and the gap is the spread paid", () => {
  const quote = quoteIndex(
    basket([
      { bid: 0.4, ask: 0.5 },
      { bid: 0.6, ask: 0.7 },
    ]),
    { kind: "AVERAGE" },
  );
  close(quote.fair, 0.55);
  close(quote.cost!, 0.6);
  close(quote.exit!, 0.5);
  close(quote.spreadCost!, 0.05, 1e-9);
  close(quote.edge!, -0.05, 1e-9);
});

test("one leg with no ask makes the whole basket unbuyable, and says which", () => {
  const quote = quoteIndex(
    basket([
      { bid: 0.4, ask: 0.5 },
      { bid: 0.98, ask: null },
    ]),
    { kind: "AVERAGE" },
  );
  assert.equal(quote.cost, null);
  assert.equal(quote.pProfit, null);
  assert.equal(quote.edge, null);
  assert.deepEqual(quote.unbuyableLegs, ["0x01"]);
  // The fair value still computes: a one-sided book still says what it is worth.
  assert.ok(quote.fair > 0);
});

test("the index beats a single contract of the same value on risk", () => {
  const quote = quoteIndex(
    basket(Array.from({ length: 8 }, () => ({ bid: 0.49, ask: 0.51 }))),
    { kind: "AVERAGE" },
  );
  close(quote.fair, 0.5);
  close(quote.sdSingleContract, 0.5, 1e-9);
  close(quote.sdIndependent, 0.5 / Math.sqrt(8), 1e-6);
  assert.ok(quote.sdIndependent < quote.sdSingleContract);
});

test("risk reduction and effective legs need measured correlation, not an assumption", () => {
  const legs = basket(Array.from({ length: 4 }, () => ({ bid: 0.49, ask: 0.51 })));
  const bare = quoteIndex(legs, { kind: "AVERAGE" });
  assert.equal(bare.sdRealized, null);
  assert.equal(bare.riskReduction, null);
  assert.equal(bare.effectiveLegs, null);

  const rho = legs.map((_, i) => legs.map((_, j) => (i === j ? 1 : 0.5)));
  const measured = quoteIndex(legs, { kind: "AVERAGE" }, {
    correlation: { keys: legs.map((l) => l.series), rho, n: [], meanOffDiagonal: 0.5, unmeasured: 0 },
  });
  assert.ok(measured.sdRealized! > measured.sdIndependent);
  assert.ok(measured.riskReduction! > 0 && measured.riskReduction! < 1);
  assert.ok(measured.effectiveLegs! > 1 && measured.effectiveLegs! < 4);
});

test("total loss is the product of the misses and total win the product of the hits", () => {
  const quote = quoteIndex(
    basket([
      { bid: 0.3, ask: 0.3 },
      { bid: 0.6, ask: 0.6 },
    ]),
    { kind: "AVERAGE" },
  );
  close(quote.pTotalLoss, 0.7 * 0.4, 1e-9);
  close(quote.pTotalWin, 0.3 * 0.6, 1e-9);
});

test("a roll projection only appears when there is more than one roll", () => {
  const legs = basket(Array.from({ length: 4 }, () => ({ bid: 0.49, ask: 0.51 })));
  assert.equal(quoteIndex(legs, { kind: "AVERAGE" }, { rolls: 1 }).rollProjection, null);
  const rolled = quoteIndex(legs, { kind: "AVERAGE" }, { rolls: 9, rhoBetweenRolls: 0 });
  close(rolled.rollProjection!.sd, rolled.sdIndependent / 3, 1e-6);
});

test("only the average shape is replicable, and every threshold is priced", () => {
  const shapes = payoffShapes([0.5, 0.5, 0.5], { kind: "AVERAGE" });
  assert.equal(shapes.length, 4);
  assert.equal(shapes.filter((s) => s.replicable).length, 1);
  const average = shapes.find((s) => s.shape.kind === "AVERAGE")!;
  close(average.fair, 0.5);
  const all = shapes.find((s) => s.shape.kind === "THRESHOLD" && s.shape.k === 3)!;
  close(all.fair, 0.125, 1e-12);
  const any = shapes.find((s) => s.shape.kind === "THRESHOLD" && s.shape.k === 1)!;
  close(any.fair, 0.875, 1e-12);
});

test("a parlay is always cheaper than the average it is built from", () => {
  const mids = [0.55, 0.6, 0.45, 0.7];
  const shapes = payoffShapes(mids, { kind: "AVERAGE" });
  const average = shapes.find((s) => s.shape.kind === "AVERAGE")!.fair;
  const all = shapes.find((s) => s.shape.kind === "THRESHOLD" && s.shape.k === mids.length)!.fair;
  assert.ok(all < average, `${all} should be under ${average}`);
});

test("the selected threshold is surfaced first after the average", () => {
  const shapes = payoffShapes([0.5, 0.5, 0.5, 0.5], { kind: "THRESHOLD", k: 3 });
  assert.deepEqual(shapes[0].shape, { kind: "THRESHOLD", k: 3 });
});

test("weights drive the payoff, not the leg count", () => {
  const [a, b] = basket([
    { bid: 0, ask: 0 },
    { bid: 1, ask: 1 },
  ]);
  const skewed = quoteIndex(
    [
      { ...a, mid: 0.2, weightBp: 9000 },
      { ...b, mid: 0.8, weightBp: BP - 9000 },
    ],
    { kind: "AVERAGE" },
  );
  close(skewed.fair, 0.9 * 0.2 + 0.1 * 0.8, 1e-9);
});
