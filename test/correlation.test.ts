import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autocorrelation,
  basketSd,
  cadenceTolerance,
  correlationMatrix,
  dependenceBetween,
  effectiveLegs,
  pairByExpiry,
  poolDependence,
  phi,
  sdAcrossRolls,
  uniformBasketSd,
  type Outcome,
} from "../src/engine/correlation";
import { legSd } from "../src/engine/distribution";
import { equalWeights } from "../src/engine/quote";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

const series = (bits: number[], step = 900, start = 1_000_000): Outcome[] =>
  bits.map((up, i) => ({ expiry: start + i * step, up: up as 0 | 1 }));

test("phi is 1 for agreement, -1 for disagreement", () => {
  close(phi([1, 0, 1, 0], [1, 0, 1, 0]).rho!, 1);
  close(phi([1, 0, 1, 0], [0, 1, 0, 1]).rho!, -1);
});

test("phi is 0 for a balanced independent table", () => {
  close(phi([1, 1, 0, 0], [1, 0, 1, 0]).rho!, 0);
});

test("phi is undefined, not zero, when a margin is degenerate", () => {
  const result = phi([1, 1, 1, 1], [1, 0, 1, 0]);
  assert.equal(result.rho, null);
  assert.equal(result.n, 4);
});

test("pairing by expiry only matches inside the tolerance", () => {
  const a = series([1, 0, 1]);
  const b = series([1, 1, 0], 900, 1_000_060);
  assert.equal(pairByExpiry(a, b, 0).a.length, 0);
  assert.equal(pairByExpiry(a, b, 60).a.length, 3);
});

test("a series correlates perfectly with itself and not with its own shift", () => {
  const history = new Map([["BTC|15m", series([1, 0, 1, 1, 0, 0, 1, 0])]]);
  close(dependenceBetween(history, "BTC|15m", "BTC|15m").rho!, 1);
  const lagged = autocorrelation(history.get("BTC|15m")!, 1);
  assert.ok(Math.abs(lagged.rho!) < 1);
  assert.equal(lagged.n, 7);
});

test("an alternating series is perfectly negatively autocorrelated", () => {
  close(autocorrelation(series([1, 0, 1, 0, 1, 0]), 1).rho!, -1);
  close(autocorrelation(series([1, 0, 1, 0, 1, 0]), 2).rho!, 1);
});

test("the matrix reports unmeasured pairs instead of calling them independent", () => {
  const history = new Map([
    ["BTC|15m", series([1, 1, 1, 1])],
    ["ETH|15m", series([1, 0, 1, 0])],
  ]);
  const matrix = correlationMatrix(history, ["BTC|15m", "ETH|15m"]);
  assert.equal(matrix.rho[0][1], null);
  assert.equal(matrix.unmeasured, 1);
  assert.equal(matrix.meanOffDiagonal, null);
});

test("the matrix is symmetric with ones down the diagonal", () => {
  const history = new Map([
    ["BTC|15m", series([1, 0, 1, 1, 0, 1, 0, 0])],
    ["ETH|15m", series([1, 0, 0, 1, 0, 1, 1, 0])],
  ]);
  const matrix = correlationMatrix(history, ["BTC|15m", "ETH|15m"]);
  assert.equal(matrix.rho[0][0], 1);
  assert.equal(matrix.rho[1][1], 1);
  assert.equal(matrix.rho[0][1], matrix.rho[1][0]);
  assert.equal(matrix.meanOffDiagonal, matrix.rho[0][1]);
});

test("cadence tolerance is exact within a cadence and half the shorter across", () => {
  assert.equal(cadenceTolerance("BTC|15m", "ETH|15m"), 0);
  assert.equal(cadenceTolerance("BTC|15m", "BTC|1h"), 450);
  assert.equal(cadenceTolerance("BTC|4h", "BTC|24h"), 7200);
});

test("perfectly correlated legs diversify nothing", () => {
  const weights = equalWeights(8).map((w) => w / 10_000);
  const ps = weights.map(() => 0.5);
  const allOnes = weights.map(() => weights.map(() => 1));
  close(basketSd(weights, ps, allOnes), legSd(0.5), 1e-9);
  close(effectiveLegs(weights, ps, allOnes), 1, 1e-6);
});

test("independent legs are worth their full count", () => {
  const n = 9;
  const weights = equalWeights(n).map((w) => w / 10_000);
  const ps = weights.map(() => 0.5);
  close(basketSd(weights, ps, null, 0), 0.5 / Math.sqrt(n), 1e-6);
  close(effectiveLegs(weights, ps, null, 0), n, 1e-4);
});

test("basketSd agrees with the uniform closed form", () => {
  const n = 6;
  const rho = 0.4;
  const p = 0.45;
  const weights = equalWeights(n).map((w) => w / 10_000);
  const matrix = weights.map((_, i) => weights.map((_, j) => (i === j ? 1 : rho)));
  close(basketSd(weights, weights.map(() => p), matrix), uniformBasketSd(n, p, rho), 1e-6);
});

test("an unmeasured pair falls back to the caller's rho, not to independence", () => {
  const weights = [0.5, 0.5];
  const ps = [0.5, 0.5];
  const withNulls = [
    [1, null],
    [null, 1],
  ];
  const pessimistic = basketSd(weights, ps, withNulls, 1);
  const optimistic = basketSd(weights, ps, withNulls, 0);
  assert.ok(pessimistic > optimistic);
  close(pessimistic, legSd(0.5), 1e-9);
});

test("rolling an independent basket shrinks its sd by sqrt(rolls)", () => {
  close(sdAcrossRolls(0.4, 16, 0), 0.1, 1e-9);
  close(sdAcrossRolls(0.4, 1, 0), 0.4, 1e-9);
});

test("positive sequential dependence eats into the rolling benefit", () => {
  const independent = sdAcrossRolls(0.4, 16, 0);
  const sticky = sdAcrossRolls(0.4, 16, 0.5);
  const reverting = sdAcrossRolls(0.4, 16, -0.5);
  assert.ok(reverting < independent && independent < sticky);
  // Even at the band's ceiling, rolling still helps — it just helps less.
  assert.ok(sticky < 0.4);
});

test("a mildly negative lag-1 does not produce a risk-free index", () => {
  // A uniform-rho model is invalid below -1/(rolls-1) and would drive the
  // variance through zero here. The lag-1 band stays positive and sane.
  const sd = sdAcrossRolls(0.4, 12, -0.18);
  assert.ok(sd > 0, "a dozen rolls of a coin flip are not risk free");
  assert.ok(sd < 0.4 / Math.sqrt(12), "mild mean reversion should beat independence");
});

test("the lag-1 band is clamped to what a correlation can be", () => {
  assert.equal(sdAcrossRolls(0.4, 8, -5), sdAcrossRolls(0.4, 8, -0.5));
  assert.equal(sdAcrossRolls(0.4, 8, 5), sdAcrossRolls(0.4, 8, 0.5));
});

test("only adjacent rolls are credited with dependence", () => {
  // Var(mean) = sigma^2 (n + 2(n-1)rho) / n^2
  const n = 10;
  const rho = 0.3;
  const expected = Math.sqrt((0.5 ** 2 * (n + 2 * (n - 1) * rho)) / n ** 2);
  close(sdAcrossRolls(0.5, n, rho), expected, 1e-12);
});

test("pooling weights an estimate by the history behind it", () => {
  const pooled = poolDependence([
    { n: 500, rho: 0.05 },
    { n: 20, rho: -0.9 },
  ]);
  // The thin, extreme reading must not dominate the well-supported one.
  assert.ok(pooled.rho > -0.1 && pooled.rho < 0.05, `got ${pooled.rho}`);
  assert.equal(pooled.windows, 520);
});

test("pooling shrinks toward zero and ignores unmeasurable estimates", () => {
  const thin = poolDependence([{ n: 10, rho: 1 }]);
  const thick = poolDependence([{ n: 10_000, rho: 1 }]);
  assert.ok(thin.rho < 0.3, `a ten-window rho of 1 should barely survive, got ${thin.rho}`);
  assert.ok(thick.rho > 0.99);
  assert.deepEqual(poolDependence([{ n: 0, rho: null }]), { rho: 0, windows: 0 });
});
