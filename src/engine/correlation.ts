/**
 * Realized dependence between event-contract series, measured from settled
 * outcomes rather than assumed.
 *
 * This is the file that decides whether an index is worth anything. Diversifying
 * across legs only reduces risk to the extent the legs disagree, and on a venue
 * whose whole universe is "BTC or ETH, up or down" that is an empirical question
 * with a real answer. Two numbers come out of it:
 *
 *   - **cross-sectional** dependence: BTC and ETH over the same window move
 *     together a lot, so holding both is much less than two independent bets.
 *   - **sequential** dependence: consecutive windows of the same series are
 *     close to independent, so holding the same basket across successive windows
 *     is nearly the textbook 1/sqrt(n).
 *
 * For binary outcomes the Pearson correlation is the phi coefficient, computed
 * straight off the 2x2 contingency table.
 */

import { clampProbability, legSd } from "./distribution";

/** One settled window of one series. `up` is 1 if the Up side won. */
export interface Outcome {
  readonly expiry: number;
  readonly up: 0 | 1;
}

/** Settled history, keyed by series (e.g. `"BTC|15m"`). */
export type OutcomeHistory = ReadonlyMap<string, readonly Outcome[]>;

export interface Dependence {
  /** Paired observations behind the estimate. */
  readonly n: number;
  /** phi coefficient in [-1, 1], or null when a margin is degenerate. */
  readonly rho: number | null;
}

/**
 * Pair two series by expiry. Same-cadence series share expiry timestamps
 * exactly, so `tolSec = 0` is the honest default; a tolerance is only for
 * deliberately comparing different cadences, where "the same window" is
 * approximate by construction.
 */
export function pairByExpiry(
  a: readonly Outcome[],
  b: readonly Outcome[],
  tolSec = 0,
): { a: number[]; b: number[] } {
  const sortedB = [...b].sort((x, y) => x.expiry - y.expiry);
  const left: number[] = [];
  const right: number[] = [];
  for (const obs of a) {
    const match = nearest(sortedB, obs.expiry, tolSec);
    if (!match) continue;
    left.push(obs.up);
    right.push(match.up);
  }
  return { a: left, b: right };
}

function nearest(sorted: readonly Outcome[], target: number, tolSec: number): Outcome | undefined {
  let lo = 0;
  let hi = sorted.length - 1;
  let best: Outcome | undefined;
  let bestGap = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const gap = Math.abs(sorted[mid].expiry - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = sorted[mid];
    }
    if (sorted[mid].expiry < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return best && bestGap <= tolSec ? best : undefined;
}

/** phi coefficient of two aligned binary vectors. */
export function phi(a: readonly number[], b: readonly number[]): Dependence {
  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] && b[i]) n11++;
    else if (a[i]) n10++;
    else if (b[i]) n01++;
    else n00++;
  }
  const den = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
  // A degenerate margin (one series never lost, say) leaves correlation
  // undefined. Reporting 0 there would read as "measured independent".
  return { n, rho: den === 0 ? null : (n11 * n00 - n10 * n01) / den };
}

export function dependenceBetween(
  history: OutcomeHistory,
  keyA: string,
  keyB: string,
  tolSec = 0,
): Dependence {
  const a = history.get(keyA);
  const b = history.get(keyB);
  if (!a || !b) return { n: 0, rho: null };
  if (keyA === keyB) return { n: a.length, rho: 1 };
  const paired = pairByExpiry(a, b, tolSec);
  return phi(paired.a, paired.b);
}

/**
 * Default pairing rule for two series keys of the form `"BTC|15m"`: exact for a
 * shared cadence, and half the shorter cadence otherwise — so a 1h window is
 * compared against the 15m window that ended nearest its close. The overlap is
 * approximate by construction and the tolerance says so out loud.
 */
export function cadenceTolerance(keyA: string, keyB: string): number {
  const a = intervalSecondsOf(keyA);
  const b = intervalSecondsOf(keyB);
  if (a === b) return 0;
  return Math.floor(Math.min(a, b) / 2);
}

function intervalSecondsOf(seriesKey: string): number {
  const match = /\|(\d+)([smhd])$/.exec(seriesKey);
  if (!match) return 0;
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
}

/** Correlation of a series with itself `lag` windows later. */
export function autocorrelation(series: readonly Outcome[], lag: number): Dependence {
  const sorted = [...series].sort((x, y) => x.expiry - y.expiry).map((o) => o.up as number);
  if (sorted.length <= lag) return { n: 0, rho: null };
  return phi(sorted.slice(0, sorted.length - lag), sorted.slice(lag));
}

export interface CorrelationMatrix {
  readonly keys: readonly string[];
  /** `rho[i][j]`, with nulls filled by `fallback` for downstream maths. */
  readonly rho: readonly (readonly (number | null)[])[];
  readonly n: readonly (readonly number[])[];
  /** Mean off-diagonal rho over the pairs that were actually measurable. */
  readonly meanOffDiagonal: number | null;
  /** Pairs with no measurement, so a caller can say so instead of implying 0. */
  readonly unmeasured: number;
}

/**
 * Seconds of slack allowed when pairing two series' windows. A number applies
 * everywhere; a function lets the caller pair same-cadence series exactly and
 * different-cadence series approximately, which is the only way a 15m window and
 * a 1h window can be compared at all.
 */
export type Tolerance = number | ((keyA: string, keyB: string) => number);

function toleranceFor(tolerance: Tolerance, a: string, b: string): number {
  return typeof tolerance === "number" ? tolerance : tolerance(a, b);
}

export function correlationMatrix(
  history: OutcomeHistory,
  keys: readonly string[],
  tolerance: Tolerance = 0,
): CorrelationMatrix {
  const rho: (number | null)[][] = [];
  const n: number[][] = [];
  let sum = 0;
  let measured = 0;
  let unmeasured = 0;

  for (let i = 0; i < keys.length; i++) {
    rho[i] = [];
    n[i] = [];
    for (let j = 0; j < keys.length; j++) {
      if (i === j) {
        rho[i][j] = 1;
        n[i][j] = history.get(keys[i])?.length ?? 0;
        continue;
      }
      if (j < i) {
        rho[i][j] = rho[j][i];
        n[i][j] = n[j][i];
        continue;
      }
      const d = dependenceBetween(history, keys[i], keys[j], toleranceFor(tolerance, keys[i], keys[j]));
      rho[i][j] = d.rho;
      n[i][j] = d.n;
      if (d.rho === null) unmeasured++;
      else {
        sum += d.rho;
        measured++;
      }
    }
  }

  return {
    keys,
    rho,
    n,
    meanOffDiagonal: measured === 0 ? null : sum / measured,
    unmeasured,
  };
}

/**
 * Standard deviation of a weighted basket under a correlation matrix:
 * sqrt(sum_i sum_j w_i w_j rho_ij sigma_i sigma_j).
 *
 * Unmeasured pairs fall back to `fallbackRho` rather than to zero, because
 * "we could not measure it" must not silently become "it diversifies perfectly".
 */
export function basketSd(
  weights: readonly number[],
  probabilities: readonly number[],
  rho: readonly (readonly (number | null)[])[] | null,
  fallbackRho = 0,
): number {
  const sd = probabilities.map(legSd);
  let variance = 0;
  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) {
      const r = i === j ? 1 : (rho?.[i]?.[j] ?? fallbackRho) ?? fallbackRho;
      variance += weights[i] * weights[j] * r * sd[i] * sd[j];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

/**
 * How many *independent* coin flips this basket is worth.
 *
 * The honest way to state diversification: a basket whose legs are perfectly
 * correlated is worth one flip no matter how many legs it has, and one whose
 * legs are independent is worth all of them. This is the ratio of the variance
 * a single average leg would carry to the variance the basket actually carries.
 */
export function effectiveLegs(
  weights: readonly number[],
  probabilities: readonly number[],
  rho: readonly (readonly (number | null)[])[] | null,
  fallbackRho = 0,
): number {
  const basket = basketSd(weights, probabilities, rho, fallbackRho);
  if (basket === 0) return weights.length;
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const averageLegSd =
    weights.reduce((acc, w, i) => acc + w * legSd(probabilities[i]), 0) / totalWeight;
  return (averageLegSd / basket) ** 2;
}

/**
 * Standard deviation of the *average* payoff over `rolls` successive windows.
 *
 * The only sequential dependence there is evidence for is between *adjacent*
 * windows — a lag-1 measurement says nothing about roll 1 against roll 5, and
 * the measured lag-2 and lag-4 numbers are indistinguishable from zero. So the
 * model is a lag-1 band, not a uniform correlation:
 *
 *     Var(mean) = sigma^2 / n^2 * (n + 2 * (n - 1) * rho_1)
 *
 * Assuming instead that every pair of rolls carries the measured lag-1 rho is
 * both unsupported and unstable: a uniform rho is only a valid correlation
 * matrix down to -1/(n-1), so a mildly negative measurement over a dozen rolls
 * drives the implied variance through zero and reports a risk-free index.
 *
 * A lag-1 band is itself only realizable for |rho_1| <= 0.5, so the input is
 * clamped there rather than allowed to produce the same nonsense more slowly.
 */
export function sdAcrossRolls(sdPerRoll: number, rolls: number, rhoBetweenRolls = 0): number {
  if (rolls <= 1) return sdPerRoll;
  const rho = Math.min(0.5, Math.max(-0.5, rhoBetweenRolls));
  const variance = (sdPerRoll ** 2 * (rolls + 2 * (rolls - 1) * rho)) / rolls ** 2;
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Pool several correlation estimates into one, weighting each by how much
 * history stands behind it.
 *
 * Averaging estimates naively lets a series with twenty settled windows shout
 * down one with five hundred: the standard error of a correlation goes as
 * 1/sqrt(n), so a 23-window reading of -0.57 is mostly noise, and taken at face
 * value it makes a rolling index look almost risk-free. Each estimate is
 * therefore shrunk toward zero by its own reliability, n / (n + prior), and then
 * averaged with n as the weight — so thin series can nudge the answer but never
 * set it.
 */
export function poolDependence(
  estimates: readonly Dependence[],
  prior = 30,
): { rho: number; windows: number } {
  let weighted = 0;
  let weight = 0;
  for (const estimate of estimates) {
    if (estimate.rho === null || estimate.n <= 0) continue;
    const shrunk = estimate.rho * (estimate.n / (estimate.n + prior));
    weighted += shrunk * estimate.n;
    weight += estimate.n;
  }
  return weight === 0 ? { rho: 0, windows: 0 } : { rho: weighted / weight, windows: weight };
}

/** Closed form for the textbook case: n equal legs at price p, uniform rho. */
export function uniformBasketSd(n: number, p: number, rho: number): number {
  const q = clampProbability(p);
  const variance = (q * (1 - q) * (1 + (n - 1) * rho)) / n;
  return Math.sqrt(Math.max(0, variance));
}
