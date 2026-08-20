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
 * Payoff distribution of a weighted basket.
 *
 * With `rho` omitted the legs are treated as independent and the distribution
 * is an exact convolution over the basis-point grid. But independence is not a
 * neutral default on this venue — settled history puts same-window dependence
 * near 0.6 — and it is exactly the assumption that misprices the tails: at
 * measured correlation, four even-money legs all win ~23% of the time, not the
 * 6.25% the product rule gives. Passing the measured mean correlation prices
 * the whole shape under a one-factor Gaussian copula instead: legs are
 * independent conditional on a shared market factor, and the distribution is
 * the mixture over that factor.
 *
 * Correlation moves the tails, never the mean — the mean is linear in the
 * legs — and the tests hold the implementation to that.
 */
export function payoffDistribution(legs: readonly DistLeg[], rho: number | null = null): PayoffDistribution {
  const pmf = mixture(rho, legs, convolve);
  return { pmf, ...moments(pmf) };
}

function convolve(legs: readonly DistLeg[]): Float64Array {
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

  return pmf;
}

/**
 * P(exactly k of the legs win), for k = 0..n — the distribution a threshold
 * ("at least K of N") settles against. Independent legs (`rho` omitted) give
 * the Poisson-binomial; a measured correlation gives its one-factor mixture,
 * where "all N win" is worth several times the naive product.
 */
export function countDistribution(probabilities: readonly number[], rho: number | null = null): Float64Array {
  return mixture(
    rho,
    probabilities.map((p) => ({ p, weightBp: 0 })),
    (legs) => poissonBinomial(legs.map((l) => l.p)),
  );
}

function poissonBinomial(probabilities: readonly number[]): Float64Array {
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

/**
 * Mixture over the one-factor Gaussian copula: leg i wins when
 * sqrt(rho)·Z + sqrt(1−rho)·e_i < Φ⁻¹(p_i), so conditional on the shared factor
 * Z the legs are independent with p_i(z) = Φ((Φ⁻¹(p_i) − sqrt(rho)·z)/sqrt(1−rho)),
 * and any distribution built from independent legs extends by integrating over Z.
 *
 * The factor cannot express negative *average* dependence, so rho at or below
 * zero (and null) falls back to plain independence — for this venue that is the
 * conservative direction, since measured dependence is firmly positive.
 */
function mixture(
  rho: number | null,
  legs: readonly DistLeg[],
  build: (legs: readonly DistLeg[]) => Float64Array,
): Float64Array {
  if (rho === null || rho < 0.005) return build(legs);
  const r = Math.min(0.999, rho);
  const sqrtR = Math.sqrt(r);
  const sqrtRest = Math.sqrt(1 - r);
  const thresholds = legs.map((l) => normInv(clampProbability(l.p)));

  // Trapezoid over z in [-6, 6]; weights renormalized so truncation cannot
  // leak probability mass.
  const STEP = 0.15;
  let out: Float64Array | null = null;
  let totalWeight = 0;
  for (let z = -6; z <= 6 + 1e-9; z += STEP) {
    const weight = normPdf(z) * STEP;
    const conditional = legs.map((leg, i) => ({
      weightBp: leg.weightBp,
      p: clampProbability(normCdf((thresholds[i] - sqrtR * z) / sqrtRest)),
    }));
    const part = build(conditional);
    if (!out) out = new Float64Array(part.length);
    for (let v = 0; v < part.length; v++) out[v] += weight * part[v];
    totalWeight += weight;
  }
  for (let v = 0; v < out!.length; v++) out![v] /= totalWeight;
  return out!;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / SQRT_2PI;
}

/** Abramowitz–Stegun 26.2.17 — |error| < 7.5e-8, plenty for clamped inputs. */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - normPdf(Math.abs(x)) * poly;
  return x >= 0 ? p : 1 - p;
}

function normInv(p: number): number {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
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
