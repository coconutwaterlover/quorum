import assert from "node:assert/strict";
import { test } from "node:test";
import { planBasket } from "../src/somnia/execute";
import { equalWeights } from "../src/engine/quote";
import type { LegBook } from "../src/somnia/discover";
import type { WeightedLeg } from "../src/engine/types";

const ONE = 1_000_000n; // 6-decimal venue
const raw = (p: number) => BigInt(Math.round(p * Number(ONE)));

/** A one-level book on both sides, priced at `ask` in YES terms. */
function bookFor(marketId: string, ask: number, depth = 500): LegBook {
  const yesAsk = raw(ask);
  const yesBid = raw(Math.max(0.001, ask - 0.01));
  const size = raw(depth);
  return {
    marketId,
    pool: `0xpool${marketId}` as `0x${string}`,
    book: {
      yesBids: [{ price: yesBid, quantity: size }],
      yesAsks: [{ price: yesAsk, quantity: size }],
      // The SDK hands NO levels over already inverted into NO terms.
      noBids: [{ price: ONE - yesAsk, quantity: size }],
      noAsks: [{ price: ONE - yesBid, quantity: size }],
    },
    tickSize: 1_000n,
    lotSize: 1_000n,
    minQuantity: 0n,
    decimals: 6,
    outcomeToken: "0xtoken" as `0x${string}`,
    yesId: 1n,
    noId: 2n,
    marketAddress: `0xmarket${marketId}` as `0x${string}`,
  };
}

function basket(prices: readonly number[]) {
  const weights = equalWeights(prices.length);
  const legs: WeightedLeg[] = prices.map((ask, i) => ({
    marketId: `m${i}`,
    series: `S${i}|15m`,
    asset: "BTC",
    interval: "15m",
    side: "UP",
    poolAddress: `0xpoolm${i}`,
    marketAddress: `0xmarketm${i}`,
    expiry: 1_000_000,
    tradingStart: 999_100,
    strike: null,
    question: "",
    venueId: "0xvenue",
    oracleQuestionId: null,
    decimals: 6,
    bid: ask - 0.01,
    ask,
    mid: ask - 0.005,
    askSize: 500,
    weightBp: weights[i],
  }));
  const books = new Map(prices.map((ask, i) => [`m${i}`, bookFor(`m${i}`, ask)]));
  return { legs, books };
}

test("every leg buys the same number of contracts, however differently priced", () => {
  // 0.02 against 0.955 is the case that breaks a naive allocation: the slippage
  // cushion's fixed ten-tick floor is 50% of the first price and 3% of the last.
  const { legs, books } = basket([0.02, 0.13, 0.5, 0.955]);
  const plan = planBasket(legs, books, 10);

  const counts = plan.legs.map((l) => l.contracts);
  const spread = (Math.max(...counts) - Math.min(...counts)) / Math.max(...counts);
  assert.ok(spread < 0.02, `contract counts should match within a lot, got ${counts.join(", ")}`);
});

test("the cheap legs get the small budgets and the dear ones the large", () => {
  const { legs, books } = basket([0.05, 0.9]);
  const plan = planBasket(legs, books, 10);
  assert.ok(plan.legs[0].stake < plan.legs[1].stake);
  // Equal contracts at unequal prices is the whole point: equal *stakes* would
  // have bought 18x more of the cheap leg.
  assert.ok(Math.abs(plan.legs[0].contracts / plan.legs[1].contracts - 1) < 0.02);
});

test("a unit costs about the weighted average of the leg prices", () => {
  const prices = [0.2, 0.4, 0.6, 0.8];
  const { legs, books } = basket(prices);
  const plan = planBasket(legs, books, 10);
  const fair = prices.reduce((a, b) => a + b, 0) / prices.length;
  // Expected cost sits above fair by the spread, and below the cushioned worst.
  assert.ok(plan.costPerUnit! > fair, `${plan.costPerUnit} should exceed fair ${fair}`);
  assert.ok(plan.costPerUnit! < plan.worstCostPerUnit!);
  assert.ok(plan.costPerUnit! < fair * 1.25);
});

test("the stake is a ceiling: escrow never exceeds it", () => {
  for (const stake of [1, 10, 137.5]) {
    const { legs, books } = basket([0.02, 0.5, 0.98]);
    const plan = planBasket(legs, books, stake);
    assert.ok(plan.totalEscrow <= stake + 1e-9, `escrowed ${plan.totalEscrow} of ${stake}`);
  }
});

test("a leg nobody is offering makes the unit unbuyable, not cheaper", () => {
  const { legs, books } = basket([0.4, 0.6]);
  books.delete("m1");
  const plan = planBasket(legs, books, 10);
  assert.equal(plan.unfillableLegs, 1);
  assert.equal(plan.unitsPlanned, 0);
  assert.equal(plan.costPerUnit, null);
});

test("a stake too small to buy a lot of every leg is reported, not rounded away", () => {
  const { legs, books } = basket([0.5, 0.5]);
  const plan = planBasket(legs, books, 0.000_001);
  assert.ok(plan.unfillableLegs > 0);
  assert.equal(plan.unitsPlanned, 0);
});

test("a thin book caps the units rather than overstating them", () => {
  const { legs, books } = basket([0.5, 0.5]);
  books.set("m1", bookFor("m1", 0.5, 2)); // only 2 contracts offered
  const plan = planBasket(legs, books, 100);
  const thin = plan.legs.find((l) => l.series === "S1|15m")!;
  assert.ok(thin.contracts <= 2.001, `bought ${thin.contracts} of 2 offered`);
  assert.ok(plan.unitsPlanned <= 2 / (thin.weightBp / 10_000) + 0.01);
});

test("weights drive the contract counts", () => {
  const { legs, books } = basket([0.3, 0.3]);
  const skewed = [
    { ...legs[0], weightBp: 7500 },
    { ...legs[1], weightBp: 2500 },
  ];
  const plan = planBasket(skewed, books, 10);
  const ratio = plan.legs[0].contracts / plan.legs[1].contracts;
  assert.ok(Math.abs(ratio - 3) < 0.05, `expected 3:1 contracts, got ${ratio}`);
});
