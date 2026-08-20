import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BP,
  atLeast,
  clampProbability,
  countDistribution,
  legSd,
  payoffDistribution,
  probabilityAbove,
  quantile,
} from "../src/engine/distribution";
import { equalWeights, riskParityWeights } from "../src/engine/quote";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

function totalMass(pmf: Float64Array): number {
  let sum = 0;
  for (const v of pmf) sum += v;
  return sum;
}

test("a payoff distribution is a distribution", () => {
  const dist = payoffDistribution([
    { p: 0.3, weightBp: 2500 },
    { p: 0.6, weightBp: 2500 },
    { p: 0.9, weightBp: 5000 },
  ]);
  close(totalMass(dist.pmf), 1, 1e-9);
});

test("the mean payoff is the weighted average of the leg prices", () => {
  const legs = [
    { p: 0.2, weightBp: 1000 },
    { p: 0.5, weightBp: 3000 },
    { p: 0.75, weightBp: 6000 },
  ];
  const expected = legs.reduce((acc, l) => acc + (l.weightBp / BP) * l.p, 0);
  close(payoffDistribution(legs).mean, expected, 1e-9);
});

test("two even legs pay nothing, half or everything at 1:2:1", () => {
  const dist = payoffDistribution([
    { p: 0.5, weightBp: 5000 },
    { p: 0.5, weightBp: 5000 },
  ]);
  close(dist.pmf[0], 0.25);
  close(dist.pmf[BP / 2], 0.5);
  close(dist.pmf[BP], 0.25);
});

test("independent equal legs shrink the sd by sqrt(n)", () => {
  for (const n of [1, 4, 9, 16]) {
    const weights = equalWeights(n);
    const dist = payoffDistribution(weights.map((weightBp) => ({ p: 0.5, weightBp })));
    close(dist.sd, 0.5 / Math.sqrt(n), 1e-6);
  }
});

test("a single leg's distribution is the leg itself", () => {
  const dist = payoffDistribution([{ p: 0.37, weightBp: BP }]);
  close(dist.pmf[0], 0.63, 1e-9);
  close(dist.pmf[BP], 0.37, 1e-9);
  close(dist.sd, legSd(0.37), 1e-9);
});

test("a zero-weight leg changes nothing", () => {
  const withZero = payoffDistribution([
    { p: 0.4, weightBp: BP },
    { p: 0.9, weightBp: 0 },
  ]);
  const without = payoffDistribution([{ p: 0.4, weightBp: BP }]);
  close(withZero.mean, without.mean);
  close(withZero.sd, without.sd);
});

test("the count distribution matches the binomial when the legs share a price", () => {
  const n = 6;
  const p = 0.35;
  const counts = countDistribution(Array.from({ length: n }, () => p));
  const choose = (a: number, b: number) => {
    let acc = 1;
    for (let i = 0; i < b; i++) acc = (acc * (a - i)) / (i + 1);
    return acc;
  };
  for (let k = 0; k <= n; k++) {
    close(counts[k], choose(n, k) * p ** k * (1 - p) ** (n - k), 1e-12);
  }
  close(totalMass(counts), 1, 1e-12);
});

test("a threshold at 1 is the complement of losing everything, and at n is the parlay", () => {
  const ps = [0.4, 0.55, 0.7];
  const counts = countDistribution(ps);
  close(atLeast(counts, 1), 1 - ps.reduce((acc, p) => acc * (1 - p), 1), 1e-12);
  close(atLeast(counts, ps.length), ps.reduce((acc, p) => acc * p, 1), 1e-12);
  close(atLeast(counts, 0), 1, 1e-12);
});

test("probabilityAbove is strict, so a payoff exactly at the cost does not count", () => {
  const dist = payoffDistribution([
    { p: 0.5, weightBp: 5000 },
    { p: 0.5, weightBp: 5000 },
  ]);
  close(probabilityAbove(dist, 0.5), 0.25);
  close(probabilityAbove(dist, 0.49), 0.75);
});

test("quantiles bracket the median", () => {
  const dist = payoffDistribution(equalWeights(8).map((weightBp) => ({ p: 0.5, weightBp })));
  assert.ok(quantile(dist, 0.05) < quantile(dist, 0.5));
  assert.ok(quantile(dist, 0.5) <= quantile(dist, 0.95));
  close(quantile(dist, 1), 1);
});

test("a certainty is pulled inside the open interval", () => {
  assert.ok(clampProbability(0) > 0);
  assert.ok(clampProbability(1) < 1);
  close(clampProbability(Number.NaN), 0.5);
});

test("weights always sum to one whole unit", () => {
  for (const n of [1, 3, 7, 11, 13]) {
    assert.equal(equalWeights(n).reduce((a, b) => a + b, 0), BP);
  }
  assert.equal(riskParityWeights([0.5, 0.9, 0.99, 0.2]).reduce((a, b) => a + b, 0), BP);
});

test("risk parity downweights the uncertain leg, which is the one carrying the variance", () => {
  const [even, nearCertain] = riskParityWeights([0.5, 0.97]);
  assert.ok(nearCertain > even, `${nearCertain} should exceed ${even}`);
});

test("risk parity equalizes each leg's risk contribution", () => {
  const ps = [0.5, 0.8, 0.97];
  const weights = riskParityWeights(ps);
  const contributions = ps.map((p, i) => (weights[i] / BP) * legSd(p));
  for (const c of contributions) close(c, contributions[0], 1e-3);
});
