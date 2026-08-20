/**
 * Pricing an index unit.
 *
 * One **index unit** is `weightBp / BP` contracts of each leg. So it costs the
 * weighted average of the leg prices and pays the weighted fraction of legs that
 * win — which is exactly why it needs no issuer, no vault and no oracle of its
 * own. Its fair value is a linear function of prices already on the book, and
 * anyone can recompute it from chain state; buying the legs *is* creation, and
 * selling them *is* redemption. There is no basis to trust and no premium to
 * arbitrage away.
 *
 * Two prices, always kept apart:
 *   - `fair` — the mid-based value of the unit. What it is worth.
 *   - `cost` — the ask-based value. What it costs to actually take the touch on
 *     every leg right now. An index buyer pays N spreads, and pretending
 *     otherwise is the fastest way to make a basket look better than it is.
 */

import {
  BP,
  atLeast,
  clampProbability,
  countDistribution,
  legSd,
  payoffDistribution,
  probabilityAbove,
  quantile,
  type PayoffDistribution,
} from "./distribution";
import { basketSd, effectiveLegs, sdAcrossRolls, type CorrelationMatrix } from "./correlation";
import type { Shape, WeightedLeg } from "./types";

export interface ShapePrice {
  readonly label: string;
  readonly shape: Shape;
  /** Fair value from the leg mids. */
  readonly fair: number;
  /** Can a holder build this payoff by buying legs on this venue? */
  readonly replicable: boolean;
  readonly note: string;
}

export interface RollProjection {
  readonly rolls: number;
  /** Correlation assumed between one roll and the next. */
  readonly rhoBetweenRolls: number;
  /** SD of the *average* payoff over all rolls. */
  readonly sd: number;
  readonly effectiveLegs: number;
}

export interface IndexQuote {
  readonly legCount: number;
  /** Mid-based value of one unit, in collateral. */
  readonly fair: number;
  /** Ask-based cost of one unit — what a market buy actually pays. */
  readonly cost: number | null;
  /** Bid-based value — what an immediate exit would fetch. */
  readonly exit: number | null;
  /** `cost - fair`: the spread you pay for taking N books at once. */
  readonly spreadCost: number | null;
  /** Legs whose book is too empty to buy. */
  readonly unbuyableLegs: readonly string[];

  readonly distribution: PayoffDistribution;
  /** SD of one unit's payoff assuming the legs are independent. */
  readonly sdIndependent: number;
  /** SD using measured correlations. The number that is actually true. */
  readonly sdRealized: number | null;
  /** Independent-coin-flip equivalent of the basket, from measured correlation. */
  readonly effectiveLegs: number | null;
  /** SD of a single contract priced at the same fair value — the thing we beat. */
  readonly sdSingleContract: number;
  /** Fraction of a single contract's SD removed, using measured correlation. */
  readonly riskReduction: number | null;

  readonly pTotalLoss: number;
  readonly pTotalWin: number;
  /** P(payoff > cost): the chance the unit is worth more than it cost. */
  readonly pProfit: number | null;
  readonly p05: number;
  readonly median: number;
  readonly p95: number;
  /** fair - cost, per unit. Negative is the spread you conceded. */
  readonly edge: number | null;

  readonly shapes: readonly ShapePrice[];
  readonly rollProjection: RollProjection | null;
}

export interface QuoteOptions {
  /** Measured dependence for the legs, in the same order as `legs`. */
  readonly correlation?: CorrelationMatrix | null;
  /** Rho for pairs the history could not measure. */
  readonly fallbackRho?: number;
  /** Rolls to project, and the sequential dependence to project them with. */
  readonly rolls?: number;
  readonly rhoBetweenRolls?: number;
}

export function quoteIndex(
  legs: readonly WeightedLeg[],
  shape: Shape,
  options: QuoteOptions = {},
): IndexQuote {
  const weights = legs.map((l) => l.weightBp / BP);
  const mids = legs.map((l) => clampProbability(l.mid ?? 0.5));

  const fair = dot(weights, mids);
  const asks = legs.map((l) => l.ask);
  const bids = legs.map((l) => l.bid);
  const unbuyableLegs = legs.filter((l) => l.ask === null).map((l) => l.marketId);

  const cost = unbuyableLegs.length > 0 ? null : dot(weights, asks as number[]);
  const exit = bids.some((b) => b === null) ? null : dot(weights, bids as number[]);
  const spreadCost = cost === null ? null : cost - fair;

  const distribution = payoffDistribution(
    legs.map((l, i) => ({ p: mids[i], weightBp: l.weightBp })),
  );

  const sdIndependent = basketSd(weights, mids, null, 0);
  const rho = options.correlation?.rho ?? null;
  const fallbackRho = options.fallbackRho ?? 0;
  const sdRealized = rho ? basketSd(weights, mids, rho, fallbackRho) : null;
  const nEff = rho ? effectiveLegs(weights, mids, rho, fallbackRho) : null;

  const sdSingleContract = legSd(fair);
  const riskReduction =
    sdRealized === null || sdSingleContract === 0 ? null : 1 - sdRealized / sdSingleContract;

  const rolls = options.rolls ?? 1;
  const rollProjection: RollProjection | null =
    rolls > 1
      ? {
          rolls,
          rhoBetweenRolls: options.rhoBetweenRolls ?? 0,
          sd: sdAcrossRolls(sdRealized ?? sdIndependent, rolls, options.rhoBetweenRolls ?? 0),
          // Effective flips is a variance ratio, so it has to be derived from
          // the projected sd rather than multiplied by the roll count — which
          // would credit the rolls with perfect independence they do not have.
          effectiveLegs:
            sdSingleContract === 0
              ? legs.length * rolls
              : (sdSingleContract /
                  sdAcrossRolls(sdRealized ?? sdIndependent, rolls, options.rhoBetweenRolls ?? 0)) **
                2,
        }
      : null;

  return {
    legCount: legs.length,
    fair,
    cost,
    exit,
    spreadCost,
    unbuyableLegs,
    distribution,
    sdIndependent,
    sdRealized,
    effectiveLegs: nEff,
    sdSingleContract,
    riskReduction,
    pTotalLoss: distribution.pmf[0],
    pTotalWin: distribution.pmf[BP],
    pProfit: cost === null ? null : probabilityAbove(distribution, cost),
    p05: quantile(distribution, 0.05),
    median: quantile(distribution, 0.5),
    p95: quantile(distribution, 0.95),
    edge: cost === null ? null : fair - cost,
    shapes: payoffShapes(mids, shape),
    rollProjection,
  };
}

/**
 * Every payoff shape the same leg set can express, priced from the same mids.
 *
 * Only `AVERAGE` is replicable by buying legs: it is a linear function of the
 * outcomes, and a portfolio of the legs *is* that function. A threshold is not
 * linear, so no holding of the legs pays it and it would need a counterparty or
 * a vault. Both are shown because the comparison is the interesting part — the
 * same eight windows are a mild diversifier or a lottery ticket depending only
 * on which function of them you settle against.
 */
export function payoffShapes(mids: readonly number[], selected: Shape): readonly ShapePrice[] {
  const n = mids.length;
  const counts = countDistribution(mids);
  const out: ShapePrice[] = [
    {
      label: `Average of ${n}`,
      shape: { kind: "AVERAGE" },
      fair: mids.reduce((a, b) => a + b, 0) / Math.max(1, n),
      replicable: true,
      note: "Pays the fraction of legs that win. Replicated exactly by holding the legs.",
    },
  ];

  for (let k = 1; k <= n; k++) {
    const label = k === 1 ? `Any 1 of ${n}` : k === n ? `All ${n}` : `At least ${k} of ${n}`;
    out.push({
      label,
      shape: { kind: "THRESHOLD", k },
      fair: atLeast(counts, k),
      replicable: false,
      note:
        k === n
          ? "A parlay. Not a linear function of the legs, so holding them cannot pay it."
          : "A threshold. Needs a counterparty or a vault — no leg portfolio pays it.",
    });
  }

  // Keep the caller's selection first after AVERAGE so a UI can highlight it.
  if (selected.kind === "THRESHOLD") {
    const i = out.findIndex((s) => s.shape.kind === "THRESHOLD" && s.shape.k === selected.k);
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  return out;
}

/** Equal weights over `n` legs, with the rounding remainder given to the first leg. */
export function equalWeights(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(BP / n);
  const weights = Array.from({ length: n }, () => base);
  weights[0] += BP - base * n;
  return weights;
}

/**
 * Weights inversely proportional to each leg's SD, so every leg contributes the
 * same amount of risk. Under equal weighting a book that mixes a coin flip with
 * a 0.97 near-certainty hands almost all the variance to the coin flip; this
 * levels that out.
 *
 * The consequence is worth stating rather than discovering: equalizing risk
 * contribution means concentrating *notional* in the near-certain legs, so the
 * basket ends up cheaper, calmer, and closer to a bond. That is the trade, not a
 * free lunch.
 */
export function riskParityWeights(probabilities: readonly number[]): number[] {
  const inv = probabilities.map((p) => {
    const sd = legSd(p);
    return sd < 1e-6 ? 0 : 1 / sd;
  });
  const total = inv.reduce((a, b) => a + b, 0);
  if (total === 0) return equalWeights(probabilities.length);
  const raw = inv.map((v) => Math.floor((v / total) * BP));
  const used = raw.reduce((a, b) => a + b, 0);
  raw[raw.indexOf(Math.max(...raw))] += BP - used;
  return raw;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
