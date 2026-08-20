/**
 * Buying an index unit.
 *
 * There is no index token and no vault: an index unit *is* its legs, so buying
 * one is N market buys sized by weight. That is the property worth showing off —
 * creation and redemption are the same operations any trader already has, which
 * is why the unit can never trade away from its NAV and needs nobody's balance
 * sheet behind it.
 *
 * Each leg is sized with `quoteBinaryStakeOverBook`, which walks the live book
 * and returns a tick-aligned protective limit plus a lot-aligned quantity whose
 * escrow cannot exceed the stake. So the quoted shares match what the order
 * fills rather than an optimistic top-of-book number, and nothing is left to
 * float arithmetic.
 *
 * Legs are placed one at a time and reported one at a time. A basket is not
 * atomic — nothing on this venue could make it atomic — so a partial fill is a
 * real outcome and is returned as one rather than hidden behind a thrown error.
 */

import {
  ORDER_TYPE,
  quoteBinaryOrderOverBook,
  quoteBinaryStakeOverBook,
  type OrderFill,
} from "@somnia-chain/markets-sdk";
import { BP } from "@/engine/distribution";
import { fromHuman, gridFor, toHuman } from "@/engine/units";
import type { WeightedLeg } from "@/engine/types";
import type { LegBook } from "./discover";
import { signerExchange, tradingMode } from "./exchange";

export interface LegPlan {
  readonly marketId: string;
  readonly series: string;
  readonly side: "UP" | "DOWN";
  readonly weightBp: number;
  /** Collateral allocated to this leg, human units. */
  readonly stake: number;
  /** Contracts the sweep expects to buy. */
  readonly contracts: number;
  /** Protective limit in this side's own terms — the worst price it will pay. */
  readonly limitPrice: number;
  /** Collateral the order escrows — the true max loss on this leg. */
  readonly escrow: number;
  /** Volume-weighted price the sweep expects to fill at, from walking the book. */
  readonly expectedPrice: number | null;
  /** Book levels the sweep consumes. More than one means it is eating depth. */
  readonly levelsConsumed: number;
  readonly pool: string;
  /** Set when this leg cannot be filled at all, with the reason. */
  readonly unfillable: string | null;
}

export interface BasketPlan {
  readonly stake: number;
  readonly legs: readonly LegPlan[];
  /** Contracts per index unit if every leg fills as planned. */
  readonly unitsPlanned: number;
  /** Collateral escrowed: the max loss, priced at every leg's protective limit. */
  readonly totalEscrow: number;
  /** What the sweep expects to actually pay, from walking each book. */
  readonly expectedCost: number;
  readonly unfillableLegs: number;
  /** Expected cost per index unit, after real depth. */
  readonly costPerUnit: number | null;
  /** Worst-case cost per unit, if every leg fills at its protective limit. */
  readonly worstCostPerUnit: number | null;
}

export interface LegFill {
  readonly marketId: string;
  readonly series: string;
  readonly side: "UP" | "DOWN";
  readonly ok: boolean;
  readonly txHash: string | null;
  readonly orderId: string | null;
  readonly contractsFilled: number;
  readonly collateralSpent: number;
  readonly error: string | null;
}

export interface BasketReceipt {
  readonly plan: BasketPlan;
  readonly fills: readonly LegFill[];
  readonly contractsFilled: number;
  readonly collateralSpent: number;
  /** Legs that filled nothing, so the basket is lopsided and the buyer should know. */
  readonly legsMissed: number;
}

/**
 * Size a basket without sending anything. Always safe to call, and the only
 * path the UI uses when trading is off — a plan is a complete, auditable answer
 * to "what would this do".
 */
export function planBasket(
  legs: readonly WeightedLeg[],
  books: ReadonlyMap<string, LegBook>,
  stake: number,
): BasketPlan {
  // Allocating `weight x stake` to each leg would be wrong, and wrong in a way
  // that quietly changes what the product is. A unit is defined as `weight`
  // *contracts* of each leg, which is what makes its payoff the weighted
  // fraction of legs that win — but equal money buys many more contracts of a
  // leg priced at 0.13 than one priced at 0.98, so equal stakes produce a
  // payoff dominated by whichever legs happened to be cheap.
  //
  // Budgeting each leg in proportion to `weight x price` instead makes the
  // contract counts proportional to the weights, which is the definition.
  const notional = legs.map((leg) => (leg.weightBp / BP) * (leg.ask ?? leg.mid ?? 0.5));
  const notionalTotal = notional.reduce((a, b) => a + b, 0);

  const plans: LegPlan[] = [];

  for (const [index, leg] of legs.entries()) {
    const book = books.get(leg.marketId);
    const share = notionalTotal > 0 ? (notional[index] / notionalTotal) * stake : 0;
    const base = {
      marketId: leg.marketId,
      series: leg.series,
      side: leg.side,
      weightBp: leg.weightBp,
      stake: share,
      pool: book?.pool ?? "",
    };

    if (!book) {
      plans.push({
        ...base, contracts: 0, limitPrice: 0, escrow: 0,
        expectedPrice: null, levelsConsumed: 0, unfillable: "no book snapshot",
      });
      continue;
    }

    const grid = gridFor(book.decimals);
    const quote = quoteBinaryStakeOverBook(
      book.book,
      leg.side === "UP" ? "BUY_YES" : "BUY_NO",
      fromHuman(share, grid),
      grid.one,
      { tickSize: book.tickSize, lotSize: book.lotSize, minQuantity: book.minQuantity },
    );

    if (!quote) {
      plans.push({
        ...base,
        contracts: 0,
        limitPrice: 0,
        escrow: 0,
        expectedPrice: null,
        levelsConsumed: 0,
        unfillable: "budget buys less than one lot, or the book is empty",
      });
      continue;
    }

    // `escrow` is quantity x the *protective* limit, so it is the max loss and
    // not a price forecast. What the sweep expects to pay comes from walking
    // the same book for that quantity.
    const sweep = quoteBinaryOrderOverBook(
      book.book,
      leg.side === "UP" ? "BUY_YES" : "BUY_NO",
      quote.quantity,
      grid.one,
    );

    plans.push({
      ...base,
      contracts: toHuman(quote.quantity, grid),
      limitPrice: toHuman(quote.limitPrice, grid),
      escrow: toHuman(quote.escrow, grid),
      expectedPrice: sweep.avgPrice > 0n ? toHuman(sweep.avgPrice, grid) : null,
      levelsConsumed: sweep.levelsConsumed,
      unfillable: null,
    });
  }

  const fillable = plans.filter((p) => p.unfillable === null);
  // One index unit needs weightBp/BP contracts of every leg, so the unit count
  // the basket really achieves is set by its worst-supplied leg.
  const unitsPlanned =
    fillable.length === 0
      ? 0
      : Math.min(...fillable.map((p) => p.contracts / (p.weightBp / BP)));
  const totalEscrow = plans.reduce((sum, p) => sum + p.escrow, 0);
  const expectedCost = plans.reduce((sum, p) => sum + (p.expectedPrice ?? 0) * p.contracts, 0);

  return {
    stake,
    legs: plans,
    unitsPlanned,
    totalEscrow,
    expectedCost,
    unfillableLegs: plans.length - fillable.length,
    costPerUnit: unitsPlanned > 0 ? expectedCost / unitsPlanned : null,
    worstCostPerUnit: unitsPlanned > 0 ? totalEscrow / unitsPlanned : null,
  };
}

/** Execute a plan. Throws only when trading is switched off; leg errors are reported. */
export async function buyBasket(
  plan: BasketPlan,
  books: ReadonlyMap<string, LegBook>,
  options: { readonly expirySeconds?: number } = {},
): Promise<BasketReceipt> {
  const mode = tradingMode();
  const exchange = signerExchange();
  if (!exchange) throw new Error(`trading is off: ${mode.reason}`);
  if (plan.stake > mode.maxStake) {
    throw new Error(`stake ${plan.stake} exceeds QUORUM_MAX_STAKE of ${mode.maxStake}`);
  }

  const fills: LegFill[] = [];

  for (const legPlan of plan.legs) {
    const book = books.get(legPlan.marketId);
    if (!book || legPlan.unfillable) {
      fills.push(blank(legPlan, legPlan.unfillable ?? "no book snapshot"));
      continue;
    }

    const grid = gridFor(book.decimals);
    const quote = quoteBinaryStakeOverBook(
      book.book,
      legPlan.side === "UP" ? "BUY_YES" : "BUY_NO",
      fromHuman(legPlan.stake, grid),
      grid.one,
      { tickSize: book.tickSize, lotSize: book.lotSize, minQuantity: book.minQuantity },
    );
    if (!quote) {
      fills.push(blank(legPlan, "book moved: nothing fillable at send time"));
      continue;
    }

    try {
      // IOC, so an unfilled remainder never rests on the book behind the
      // buyer's back with escrow locked against it. The expiry is a
      // dead-man's switch as well as a requirement.
      const result = await exchange.trader.placeOrder({
        pool: book.pool,
        side: quote.side,
        price: quote.yesPrice,
        quantity: quote.quantity,
        orderType: ORDER_TYPE.MARKET,
        outcomeToken: book.outcomeToken,
        yesId: book.yesId,
        noId: book.noId,
        expireTimestampNs:
          BigInt(Math.floor(Date.now() / 1000) + (options.expirySeconds ?? 60)) * 1_000_000_000n,
      });

      const filled = sumFills(result.fills, legPlan.side, grid.one);
      fills.push({
        marketId: legPlan.marketId,
        series: legPlan.series,
        side: legPlan.side,
        ok: result.receipt?.status !== "reverted" && filled.contracts > 0,
        txHash: result.hash ?? null,
        orderId: result.orderId?.toString() ?? null,
        contractsFilled: filled.contracts,
        collateralSpent: filled.collateral,
        error: result.receipt?.status === "reverted" ? "reverted on-chain" : null,
      });
    } catch (error) {
      // From 0.23.0 a reverted write throws a decoded revert error, so this is
      // where an underfunded signer or a just-locked window shows up.
      fills.push(blank(legPlan, error instanceof Error ? error.message : String(error)));
    }
  }

  return {
    plan,
    fills,
    contractsFilled: fills.reduce((s, f) => s + f.contractsFilled, 0),
    collateralSpent: fills.reduce((s, f) => s + f.collateralSpent, 0),
    legsMissed: fills.filter((f) => f.contractsFilled === 0).length,
  };
}

/**
 * `fillPrice` is always the YES price, whichever side was traded — so a Down
 * buyer's cost per contract is its complement. Reading it as the traded side's
 * own price silently reports the wrong spend on every Down leg.
 */
function sumFills(
  fills: readonly OrderFill[],
  side: "UP" | "DOWN",
  one: bigint,
): { contracts: number; collateral: number } {
  let contracts = 0;
  let collateral = 0;
  for (const fill of fills) {
    const quantity = Number(fill.quantityFilled) / Number(one);
    const yesPrice = Number(fill.fillPrice) / Number(one);
    contracts += quantity;
    collateral += quantity * (side === "UP" ? yesPrice : 1 - yesPrice);
  }
  return { contracts, collateral };
}

function blank(plan: LegPlan, error: string): LegFill {
  return {
    marketId: plan.marketId,
    series: plan.series,
    side: plan.side,
    ok: false,
    txHash: null,
    orderId: null,
    contractsFilled: 0,
    collateralSpent: 0,
    error,
  };
}
