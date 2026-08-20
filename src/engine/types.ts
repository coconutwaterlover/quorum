/** Shared shapes for the index engine. No chain types leak in here. */

export type Side = "UP" | "DOWN";

/** A tradable leg: one side of one binary market, with its book collapsed to three prices. */
export interface Leg {
  /** `marketId` — the only stable key. Pools are recycled across windows. */
  readonly marketId: string;
  /** Series key, e.g. `"BTC|15m"`. Stable across the windows of a series. */
  readonly series: string;
  readonly asset: string;
  readonly interval: string;
  readonly side: Side;
  /** Outcome symbol for the chosen side, as the SDK names it. */
  readonly symbol: string;
  /** The market's own YES symbol, which is the book we actually read. */
  readonly yesSymbol: string;
  readonly poolAddress: string;
  readonly marketAddress: string;
  readonly expiry: number;
  readonly tradingStart: number;
  readonly strike: string | null;
  readonly question: string;
  readonly venueId: string;
  readonly oracleQuestionId: string | null;
  readonly decimals: number;
  /** Best price to sell this side at, in this side's own terms. */
  readonly bid: number | null;
  /** Best price to buy this side at, in this side's own terms. */
  readonly ask: number | null;
  /** Midpoint, or whichever single side exists, or null on an empty book. */
  readonly mid: number | null;
  /** Depth in contracts available at `ask`. */
  readonly askSize: number | null;
}

/** A leg with its share of one index unit. */
export interface WeightedLeg extends Leg {
  readonly weightBp: number;
}

/**
 * What the index pays.
 *
 * `AVERAGE` is the weighted fraction of legs that win. It is the only shape a
 * holder can *replicate by buying the legs*, which is why it is the only one
 * this app will execute — see `payoffShapes` in `quote.ts` for the rest, priced
 * but not offered.
 */
export type Shape = { readonly kind: "AVERAGE" } | { readonly kind: "THRESHOLD"; readonly k: number };

export interface IndexDef {
  readonly name: string;
  readonly legs: readonly WeightedLeg[];
  readonly shape: Shape;
  /** Rolls to hold the definition for. 1 is a single window. */
  readonly rolls: number;
  /** Collateral committed per roll, in human units. */
  readonly stakePerRoll: number;
}
