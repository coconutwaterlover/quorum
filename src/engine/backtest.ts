/**
 * Replaying an index over the venue's own settled history.
 *
 * The claim an index makes is narrow and testable: *same expected value, less
 * variance*. Not more profit — less noise. So the backtest is deliberately not
 * an alpha search. It holds the entry price fixed across both strategies, which
 * forces their expected values to match, and then reports what actually differed
 * — the spread of outcomes, the drawdown, how often a roll lost everything.
 *
 * On price: most settled windows on this venue never traded, so there is no
 * realized entry price to use for them. Rather than quietly inventing one, the
 * assumed price is an explicit input and the result reports how many rolls used
 * a real print versus the assumption.
 */

import { BP } from "./distribution";
import type { Outcome, OutcomeHistory } from "./correlation";

export interface BacktestLeg {
  readonly series: string;
  readonly weightBp: number;
  /** Buying Up wins when the window closed up; Down is the complement. */
  readonly side: "UP" | "DOWN";
}

export interface BacktestConfig {
  readonly legs: readonly BacktestLeg[];
  /** Price paid per contract when no realized print exists. */
  readonly assumedEntryPrice: number;
  /** Cap on rolls to replay, newest last. */
  readonly maxRolls?: number;
  /**
   * Seconds of slack when pairing windows of different cadences. Left unset it
   * is derived from the coarsest leg — see `driverSeries` below.
   */
  readonly tolSec?: number;
}

export interface StrategyResult {
  readonly label: string;
  /** Payoff per unit staked, per roll. */
  readonly payoffs: readonly number[];
  /** Profit per unit staked, cumulative. */
  readonly equity: readonly number[];
  readonly mean: number;
  readonly sd: number;
  readonly total: number;
  readonly maxDrawdown: number;
  /** Share of rolls that finished above the entry cost. */
  readonly hitRate: number;
  readonly worstRoll: number;
  readonly bestRoll: number;
  /** Rolls that paid nothing at all. */
  readonly wipeouts: number;
}

export interface BacktestResult {
  readonly rolls: number;
  /** The series whose windows set the roll clock, and the pairing slack used. */
  readonly driverSeries: string | null;
  readonly tolSec: number;
  readonly firstExpiry: number | null;
  readonly lastExpiry: number | null;
  readonly entryPrice: number;
  /** Rolls where at least one leg used a realized print rather than the assumption. */
  readonly rollsWithRealizedPrice: number;
  readonly index: StrategyResult;
  readonly singleLeg: StrategyResult;
  /** Fraction of the single-leg SD the index removed, measured not modelled. */
  readonly sdReduction: number | null;
  readonly skippedIncompleteWindows: number;
}

/** Optional realized prices, keyed `${series}|${expiry}`, as Up probabilities. */
export type RealizedPrices = ReadonlyMap<string, number>;

export function backtest(
  history: OutcomeHistory,
  config: BacktestConfig,
  realized: RealizedPrices = new Map(),
): BacktestResult {
  const legs = config.legs.filter((l) => (history.get(l.series)?.length ?? 0) > 0);
  if (legs.length === 0) return empty(config.assumedEntryPrice);

  // Drive the timeline off the *coarsest* leg — the one with the fewest settled
  // windows. A complete roll needs every leg, so the coarsest cadence is the
  // binding constraint: driving off the finest instead asks 500 fifteen-minute
  // windows to each find a same-second 24h counterpart, and almost none can,
  // which silently reduces a mixed-cadence basket to a handful of rolls.
  const primary = legs.reduce((best, l) =>
    (history.get(l.series)!.length < history.get(best.series)!.length ? l : best),
  );
  // Pair the finer legs to the window of the driver they end nearest. Half the
  // driver's own cadence is the widest slack that still picks a unique window.
  const tolSec = config.tolSec ?? Math.floor(intervalSecondsOf(primary.series) / 2);
  const timeline = [...history.get(primary.series)!].sort((a, b) => a.expiry - b.expiry);
  const sorted = new Map(
    legs.map((l) => [l.series, [...history.get(l.series)!].sort((a, b) => a.expiry - b.expiry)]),
  );

  const indexPayoffs: number[] = [];
  const singlePayoffs: number[] = [];
  const expiries: number[] = [];
  let entryCostTotal = 0;
  let rollsWithRealized = 0;
  let skipped = 0;

  for (const window of timeline) {
    const matched: { leg: BacktestLeg; outcome: Outcome; price: number }[] = [];
    let complete = true;
    for (const leg of legs) {
      const hit = nearest(sorted.get(leg.series)!, window.expiry, tolSec);
      if (!hit) {
        complete = false;
        break;
      }
      matched.push({ leg, outcome: hit, price: priceFor(leg, hit, realized, config.assumedEntryPrice) });
    }
    if (!complete) {
      skipped++;
      continue;
    }

    let payoff = 0;
    let cost = 0;
    let usedRealized = false;
    for (const { leg, outcome, price } of matched) {
      const w = leg.weightBp / BP;
      payoff += w * won(leg.side, outcome.up);
      cost += w * price;
      if (realized.has(`${leg.series}|${outcome.expiry}`)) usedRealized = true;
    }
    if (usedRealized) rollsWithRealized++;

    // The single-leg comparison spends the same unit on the primary leg alone,
    // at the same price, so the two strategies differ only in dispersion.
    const primaryMatch = matched.find((m) => m.leg.series === primary.series)!;

    indexPayoffs.push(payoff);
    singlePayoffs.push(won(primary.side, primaryMatch.outcome.up) * 1);
    entryCostTotal += cost;
    expiries.push(window.expiry);
  }

  const cap = config.maxRolls ?? indexPayoffs.length;
  const cut = Math.max(0, indexPayoffs.length - cap);
  const idx = indexPayoffs.slice(cut);
  const single = singlePayoffs.slice(cut);
  const stamps = expiries.slice(cut);
  const entryPrice = idx.length === 0 ? config.assumedEntryPrice : entryCostTotal / indexPayoffs.length;

  const indexResult = summarize(`Index of ${legs.length}`, idx, entryPrice);
  const singleResult = summarize(`Single contract (${primary.series})`, single, entryPrice);

  return {
    rolls: idx.length,
    driverSeries: primary.series,
    tolSec,
    firstExpiry: stamps[0] ?? null,
    lastExpiry: stamps[stamps.length - 1] ?? null,
    entryPrice,
    rollsWithRealizedPrice: rollsWithRealized,
    index: indexResult,
    singleLeg: singleResult,
    sdReduction: singleResult.sd === 0 ? null : 1 - indexResult.sd / singleResult.sd,
    skippedIncompleteWindows: skipped,
  };
}

function won(side: "UP" | "DOWN", up: 0 | 1): number {
  return side === "UP" ? up : 1 - up;
}

function priceFor(
  leg: BacktestLeg,
  outcome: Outcome,
  realized: RealizedPrices,
  assumed: number,
): number {
  const up = realized.get(`${leg.series}|${outcome.expiry}`);
  if (up === undefined) return assumed;
  return leg.side === "UP" ? up : 1 - up;
}

function summarize(label: string, payoffs: readonly number[], entryPrice: number): StrategyResult {
  const n = payoffs.length;
  if (n === 0) {
    return {
      label, payoffs: [], equity: [], mean: 0, sd: 0, total: 0,
      maxDrawdown: 0, hitRate: 0, worstRoll: 0, bestRoll: 0, wipeouts: 0,
    };
  }
  const pnl = payoffs.map((p) => p - entryPrice);
  const equity: number[] = [];
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const step of pnl) {
    running += step;
    equity.push(running);
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }
  const mean = payoffs.reduce((a, b) => a + b, 0) / n;
  const variance = payoffs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    label,
    payoffs,
    equity,
    mean,
    sd: Math.sqrt(variance),
    total: running,
    maxDrawdown,
    hitRate: payoffs.filter((p) => p > entryPrice).length / n,
    worstRoll: Math.min(...pnl),
    bestRoll: Math.max(...pnl),
    wipeouts: payoffs.filter((p) => p === 0).length,
  };
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

/** `"BTC|15m"` -> 900. Cadences are minted freely, so this parses. */
function intervalSecondsOf(seriesKey: string): number {
  const match = /\|(\d+)([smhd])$/.exec(seriesKey);
  if (!match) return 0;
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
}

function empty(entryPrice: number): BacktestResult {
  const blank = summarize("none", [], entryPrice);
  return {
    rolls: 0, driverSeries: null, tolSec: 0, firstExpiry: null, lastExpiry: null, entryPrice,
    rollsWithRealizedPrice: 0, index: blank, singleLeg: blank,
    sdReduction: null, skippedIncompleteWindows: 0,
  };
}
