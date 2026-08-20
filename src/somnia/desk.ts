/**
 * The composed view the app is built from: what is live, what it costs, and what
 * settled history says about it — assembled once and shared by every route.
 *
 * Discovery is cached for a few seconds. Not for load: for consistency. A page
 * that quotes a basket from one snapshot and plans its orders from another can
 * show a cost that never existed, and on a venue where windows roll every 15
 * minutes the two snapshots will not agree.
 */

import {
  autocorrelation,
  cadenceTolerance,
  correlationMatrix,
  poolDependence,
  type CorrelationMatrix,
} from "@/engine/correlation";
import { equalWeights, quoteIndex, riskParityWeights, type IndexQuote } from "@/engine/quote";
import { TEMPLATES } from "@/engine/templates";
import type { Leg, Shape, WeightedLeg } from "@/engine/types";
import { backtest, type BacktestResult } from "@/engine/backtest";
import { discover, type Discovery } from "./discover";
import { loadHistory, usableSeries, type History } from "./history";
import { planBasket, type BasketPlan } from "./execute";
import { tradingMode, venueConfig } from "./exchange";

export interface SeriesStat {
  readonly series: string;
  readonly windows: number;
  readonly upRate: number;
  /** Correlation with the same series one window later. Near zero is the point. */
  readonly lag1: number | null;
}

export interface DeskSnapshot {
  readonly asOf: number;
  readonly venue: {
    readonly network: string;
    readonly venueId: string;
    readonly collateral: string;
    readonly explorer: string;
  };
  readonly trading: { readonly enabled: boolean; readonly reason: string | null; readonly maxStake: number };
  readonly legs: readonly Leg[];
  readonly skipped: readonly { readonly reason: string; readonly count: number }[];
  readonly templates: readonly { readonly id: string; readonly name: string; readonly thesis: string; readonly marketIds: readonly string[] }[];
  readonly correlation: CorrelationMatrix;
  readonly seriesStats: readonly SeriesStat[];
  readonly history: {
    readonly rowsScanned: number;
    readonly windowsWithPrice: number;
    readonly voidedWindows: number;
    readonly oldestExpiry: number | null;
    readonly newestExpiry: number | null;
  };
}

const SNAPSHOT_TTL_MS = 8_000;
let snapshotCache: { at: number; discovery: Discovery; history: History } | null = null;

async function raw(): Promise<{ discovery: Discovery; history: History }> {
  if (snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return { discovery: snapshotCache.discovery, history: snapshotCache.history };
  }
  const [discovery, history] = await Promise.all([discover(), loadHistory()]);
  snapshotCache = { at: Date.now(), discovery, history };
  return { discovery, history };
}

export async function deskSnapshot(): Promise<DeskSnapshot> {
  const { discovery, history } = await raw();
  const cfg = venueConfig();
  const upLegs = discovery.legs.filter((l) => l.side === "UP");

  // The matrix covers every series with a live window, whether or not it is in
  // the basket, so the UI can show what adding a leg would do.
  const liveSeries = [...new Set(upLegs.map((l) => l.series))].sort();
  const measurable = liveSeries.filter((s) => (history.outcomes.get(s)?.length ?? 0) >= 20);

  const seriesStats: SeriesStat[] = usableSeries(history).map((series) => {
    const list = history.outcomes.get(series)!;
    return {
      series,
      windows: list.length,
      upRate: list.filter((o) => o.up === 1).length / list.length,
      lag1: autocorrelation(list, 1).rho,
    };
  });

  return {
    asOf: discovery.asOf,
    venue: {
      network: cfg.network,
      venueId: cfg.venueId,
      collateral: cfg.collateralLabel,
      explorer: cfg.explorer,
    },
    trading: tradingMode(),
    legs: discovery.legs,
    skipped: discovery.skipped,
    templates: TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      thesis: t.thesis,
      marketIds: t.pick(upLegs).map((l) => l.marketId),
    })),
    correlation: correlationMatrix(history.outcomes, measurable, cadenceTolerance),
    seriesStats,
    history: {
      rowsScanned: history.rowsScanned,
      windowsWithPrice: history.windowsWithPrice,
      voidedWindows: history.voidedWindows,
      oldestExpiry: history.oldestExpiry,
      newestExpiry: history.newestExpiry,
    },
  };
}

/** One leg of a caller's selection: which market, which side, and its share. */
export interface Selection {
  readonly marketId: string;
  readonly side: "UP" | "DOWN";
  readonly weightBp?: number;
}

export interface QuoteRequest {
  readonly selection: readonly Selection[];
  readonly weighting?: "equal" | "risk-parity";
  readonly shape?: Shape;
  readonly rolls?: number;
  readonly stake?: number;
  /** Entry price to replay history at, when no realized print exists. */
  readonly assumedEntryPrice?: number;
  readonly maxRolls?: number;
}

export interface QuoteResponse {
  readonly asOf: number;
  readonly legs: readonly WeightedLeg[];
  readonly quote: IndexQuote;
  readonly plan: BasketPlan;
  readonly correlation: CorrelationMatrix;
  /** Pooled sequential correlation across the chosen series — the rolling assumption. */
  readonly rhoBetweenRolls: number;
  /** Settled windows behind that estimate. */
  readonly rhoWindows: number;
  readonly backtest: BacktestResult;
  readonly missing: readonly string[];
}

export async function quoteSelection(request: QuoteRequest): Promise<QuoteResponse> {
  const { discovery, history } = await raw();
  const byId = new Map(discovery.legs.map((l) => [`${l.marketId}|${l.side}`, l]));

  const chosen: Leg[] = [];
  const missing: string[] = [];
  for (const sel of request.selection) {
    const leg = byId.get(`${sel.marketId}|${sel.side}`);
    if (leg) chosen.push(leg);
    else missing.push(sel.marketId);
  }

  const weighting = request.weighting ?? "equal";
  const explicit = request.selection.every((s) => typeof s.weightBp === "number");
  const weights = explicit
    ? request.selection.map((s) => s.weightBp!)
    : weighting === "risk-parity"
      ? riskParityWeights(chosen.map((l) => l.mid ?? 0.5))
      : equalWeights(chosen.length);

  const legs: WeightedLeg[] = chosen.map((leg, i) => ({ ...leg, weightBp: weights[i] ?? 0 }));
  const seriesKeys = legs.map((l) => l.series);
  const matrix = correlationMatrix(history.outcomes, seriesKeys, cadenceTolerance);

  // The rolling assumption is measured too, not a hopeful zero — but pooled by
  // sample size, so a cadence with two dozen settled windows cannot set it.
  const pooled = poolDependence(
    seriesKeys
      .map((key) => history.outcomes.get(key))
      .filter((list): list is NonNullable<typeof list> => !!list && list.length >= 20)
      .map((list) => autocorrelation(list, 1)),
  );
  const rhoBetweenRolls = pooled.rho;

  const quote = quoteIndex(legs, request.shape ?? { kind: "AVERAGE" }, {
    correlation: matrix,
    // A pair history could not measure is assumed *dependent*, so an
    // unmeasurable basket never advertises diversification it cannot show.
    fallbackRho: 0.5,
    rolls: request.rolls ?? 1,
    rhoBetweenRolls,
  });

  const replay = backtest(
    history.outcomes,
    {
      legs: legs.map((l) => ({ series: l.series, weightBp: l.weightBp, side: l.side })),
      assumedEntryPrice: request.assumedEntryPrice ?? 0.5,
      maxRolls: request.maxRolls ?? 250,
    },
    history.realizedPrices,
  );

  return {
    asOf: discovery.asOf,
    legs,
    quote,
    plan: planBasket(legs, discovery.books, request.stake ?? 10),
    correlation: matrix,
    rhoBetweenRolls,
    rhoWindows: pooled.windows,
    backtest: replay,
    missing,
  };
}

/** The book snapshot the plan was built from, for the execution route. */
export async function currentBooks() {
  return (await raw()).discovery.books;
}
