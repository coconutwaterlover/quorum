/**
 * Outcome distributions for a basket of binary event contracts.
 *
 * A single event contract is one Bernoulli draw: it pays 1 unit of collateral or
 * 0, and nothing in between. A basket of N of them has a *distribution* of
 * payoffs, and that distribution is the whole point of an index — so it is
 * computed exactly here rather than approximated.
 *
 * Two distributions matter, and they are not the same object:
 *
 *   - the **payoff** distribution over the weighted sum of the legs, which is
 *     what an index unit actually pays. Weights make it a convolution over a
 *     value grid, not a binomial.
 *   - the **count** distribution over how many legs won, which is what a
 *     "at least K of N" contract settles against. Weights are irrelevant to it.
 *
 * Everything here is pure and dependency-free: no chain, no clock, no I/O.
 */

/** Basis points, so a weighted payoff lands on an exact integer grid. */
export const BP = 10_000;

/** Discrete distribution over payoffs in basis points of 1 collateral unit. */
export interface PayoffDistribution {
  /** `pmf[v]` is P(payoff = v/BP). Length BP + 1. */
  readonly pmf: Float64Array;
  readonly mean: number;
  readonly sd: number;
}

export interface DistLeg {
  /** Probability this leg pays 1, i.e. its price as a probability in (0, 1). */
  readonly p: number;
  /** Share of one index unit, in basis points. The set should sum to BP. */
  readonly weightBp: number;
}

/**
 * Exact payoff distribution of a weighted basket, by convolution over the
 * basis-point grid. Legs are assumed independent; `correlation.ts` is where
 * dependence is handled, because dependence changes the moments without
 * changing this shape in any way we can measure from outcomes alone.
 */
export function payoffDistribution(legs: readonly DistLeg[]): PayoffDistribution {
  let pmf = new Float64Array(BP + 1);
  pmf[0] = 1;
  let top = 0; // highest reachable payoff so far, so we never scan dead tail

  for (const leg of legs) {
    const w = Math.round(leg.weightBp);
    if (w <= 0) continue;
    const next = new Float64Array(BP + 1);
    const hit = clampProbability(leg.p);
    const miss = 1 - hit;
    const newTop = Math.min(BP, top + w);
    for (let v = 0; v <= top; v++) {
      const mass = pmf[v];
      if (mass === 0) continue;
      next[v] += mass * miss;
      next[Math.min(BP, v + w)] += mass * hit;
    }
    pmf = next;
    top = newTop;
  }

  return { pmf, ...moments(pmf) };
}

/**
 * Poisson-binomial: P(exactly k of the legs win), for k = 0..n. This is the
 * distribution a threshold ("at least K of N") settles against.
 */
export function countDistribution(probabilities: readonly number[]): Float64Array {
  const n = probabilities.length;
  const dp = new Float64Array(n + 1);
  dp[0] = 1;
  let filled = 0;
  for (const raw of probabilities) {
    const p = clampProbability(raw);
    // Walk down so dp[k - 1] is still the previous round's value.
    for (let k = filled + 1; k >= 1; k--) dp[k] = dp[k] * (1 - p) + dp[k - 1] * p;
    dp[0] *= 1 - p;
    filled++;
  }
  return dp;
}

/** P(at least `k` of the legs win). */
export function atLeast(counts: Float64Array, k: number): number {
  let sum = 0;
  for (let i = Math.max(0, k); i < counts.length; i++) sum += counts[i];
  return sum;
}

/** P(payoff strictly greater than `threshold`), threshold in collateral units. */
export function probabilityAbove(dist: PayoffDistribution, threshold: number): number {
  const cut = Math.floor(threshold * BP);
  let sum = 0;
  for (let v = cut + 1; v <= BP; v++) sum += dist.pmf[v];
  return sum;
}

/** Smallest payoff (in collateral units) with cumulative mass >= `q`. */
export function quantile(dist: PayoffDistribution, q: number): number {
  let acc = 0;
  for (let v = 0; v <= BP; v++) {
    acc += dist.pmf[v];
    if (acc >= q) return v / BP;
  }
  return 1;
}

function moments(pmf: Float64Array): { mean: number; sd: number } {
  let mean = 0;
  for (let v = 0; v <= BP; v++) mean += (v / BP) * pmf[v];
  let variance = 0;
  for (let v = 0; v <= BP; v++) {
    const d = v / BP - mean;
    variance += d * d * pmf[v];
  }
  return { mean, sd: Math.sqrt(Math.max(0, variance)) };
}

/**
 * Book prices can print at or past the bounds (a 0.999 ask, a stale 1.0 mid).
 * A probability of exactly 0 or 1 is a certainty the venue is not offering, and
 * it makes the log-likelihood style maths downstream degenerate, so pull it in.
 */
export function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.999_9, Math.max(0.000_1, p));
}

/** Standard deviation of a single binary contract priced at `p`. */
export function legSd(p: number): number {
  const q = clampProbability(p);
  return Math.sqrt(q * (1 - q));
}
