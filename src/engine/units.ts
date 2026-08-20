/**
 * Collateral scale conversions.
 *
 * Prices and order sizes are deliberately *not* built here. A float price is the
 * single most reliable way to get an order rejected on this venue:
 * `parseUnits((0.05).toFixed(18), 18)` lands three wei off the tick grid and the
 * pool answers `InvalidPrice`, and of the ordinary probabilities only 0.25, 0.5
 * and 0.75 survive that conversion because they are the ones binary floating
 * point represents exactly. A 6-decimal venue hides the whole problem, which is
 * worse than failing — testnet looks clean while every mainnet order fails.
 *
 * So execution never hand-rolls a price: it goes through the SDK's
 * `quoteBinaryStakeOverBook`, which walks the live book and returns a
 * tick-aligned limit and a lot-aligned quantity in raw integer units. What is
 * left for this file is the boundary conversion, and one exact complement.
 */

export interface VenueGrid {
  readonly decimals: number;
  /** One collateral unit in raw integer terms. */
  readonly one: bigint;
}

export function gridFor(decimals: number): VenueGrid {
  return { decimals, one: 10n ** BigInt(decimals) };
}

export function toHuman(raw: bigint, grid: VenueGrid): number {
  return Number(raw) / Number(grid.one);
}

/** Floors, because a stake is a ceiling: rounding up would overspend it. */
export function fromHuman(value: number, grid: VenueGrid): bigint {
  return BigInt(Math.floor(value * Number(grid.one)));
}

/**
 * A Down price is the Up price's complement, exactly. Doing it in integers keeps
 * `1 - p` from drifting off the tick grid the way the float version does.
 */
export function complement(rawPrice: bigint, grid: VenueGrid): bigint {
  return grid.one - rawPrice;
}
