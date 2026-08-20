/**
 * What the desk holds, and claiming what settled.
 *
 * Redemption is the step people miss, and it is missed for a structural reason:
 * a settled market leaves the live list entirely, so a bot that scans
 * `loadMarkets()` for inactive rows finds nothing and reports no winnings while
 * real ones sit unclaimed. Winnings are found by scanning *finalized* markets
 * and reading the outcome balances on them.
 *
 * Redeeming a loser does not revert — it succeeds and pays zero — so the winning
 * side is checked before any gas is spent, and a voided market claims both sides
 * explicitly because there is no winner to infer.
 */

import type { Address, Hex } from "viem";
import { gridFor, toHuman } from "@/engine/units";
import { readExchange, signerExchange, venueConfig } from "./exchange";

export interface HeldPosition {
  readonly marketId: string;
  readonly series: string;
  readonly asset: string;
  readonly interval: string;
  readonly expiry: number;
  readonly side: "UP" | "DOWN";
  readonly outcomeIdx: 0 | 1;
  /** Contracts held, human units. */
  readonly contracts: number;
  readonly rawAmount: bigint;
  readonly status: "live" | "resolved" | "voided";
  /** Collateral this position pays if claimed now. */
  readonly claimable: number;
  readonly won: boolean | null;
}

export interface PortfolioView {
  readonly account: string | null;
  readonly live: readonly HeldPosition[];
  readonly claimable: readonly HeldPosition[];
  readonly liveContracts: number;
  readonly claimableCollateral: number;
  readonly collateralBalance: number | null;
}

/**
 * Positions across live and recently settled markets.
 *
 * `windowsBack` bounds the settled scan. The server sorts newest-created and we
 * want newest-expired; those agree inside a series but not across cadences, so
 * the scan over-fetches and sorts by expiry before cutting.
 */
export async function loadPortfolio(
  account: Address,
  options: { readonly windowsBack?: number } = {},
): Promise<PortfolioView> {
  const exchange = readExchange();
  const cfg = venueConfig();
  const windowsBack = options.windowsBack ?? 60;

  const scope = (extra: Record<string, unknown>) => {
    const query: Record<string, unknown> = { limit: 500, ...extra };
    if (cfg.venueId) query.venueId = cfg.venueId;
    return query as never;
  };

  const [trading, finalized] = await Promise.all([
    exchange.client.listBinaryMarkets(scope({ status: "Trading" })),
    exchange.client.listBinaryMarkets(scope({ status: "Finalized" })),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const liveRows = trading.filter((r) => Number(r.expiry) > now);
  const settledRows = [...finalized]
    .sort((a, b) => Number(b.expiry ?? 0) - Number(a.expiry ?? 0))
    .slice(0, windowsBack);

  const live: HeldPosition[] = [];
  const claimable: HeldPosition[] = [];

  for (const row of [...liveRows, ...settledRows]) {
    const marketId = row.marketId as Hex;
    const onchain = await exchange.client.getMarketOnchain(marketId);
    const grid = gridFor(Number(onchain.decimals));

    const balances = await Promise.all(
      ([0, 1] as const).map((idx) =>
        exchange.client.getOutcomeBalance({
          outcomeToken: onchain.outcomeToken as Address,
          account,
          id: BigInt(idx === 0 ? onchain.yesId : onchain.noId),
        }),
      ),
    );

    for (const outcomeIdx of [0, 1] as const) {
      const rawAmount = balances[outcomeIdx];
      if (rawAmount <= 0n) continue;

      const settled = onchain.isResolved || onchain.isVoided;
      const won = onchain.isVoided
        ? null
        : onchain.isResolved
          ? Number(onchain.winningOutcome) === outcomeIdx
          : null;
      // Voided pays every side half; resolved pays only the winner, and
      // dreamDEX sets the settlement fee to zero so the winner is paid 1:1.
      const payoutRate = onchain.isVoided ? 0.5 : won === true ? 1 : 0;

      const position: HeldPosition = {
        marketId,
        series: `${row.asset}|${row.interval}`,
        asset: String(row.asset),
        interval: String(row.interval),
        expiry: Number(onchain.expiry),
        side: outcomeIdx === 0 ? "UP" : "DOWN",
        outcomeIdx,
        contracts: toHuman(rawAmount, grid),
        rawAmount,
        status: onchain.isVoided ? "voided" : onchain.isResolved ? "resolved" : "live",
        claimable: settled ? toHuman(rawAmount, grid) * payoutRate : 0,
        won,
      };

      if (!settled) live.push(position);
      else if (payoutRate > 0) claimable.push(position);
    }
  }

  return {
    account,
    live,
    claimable,
    liveContracts: live.reduce((s, p) => s + p.contracts, 0),
    claimableCollateral: claimable.reduce((s, p) => s + p.claimable, 0),
    collateralBalance: null,
  };
}

/**
 * The JSON-safe shape of a position.
 *
 * `rawAmount` has to stay a bigint on the server — it is what `redeemMany`
 * takes, and rounding it through a float would redeem the wrong number of
 * tokens — but a bigint cannot be serialized, so an account that actually holds
 * something would fail the response rather than the empty account used to smoke
 * test it. It crosses the wire as a decimal string.
 */
export type HeldPositionWire = Omit<HeldPosition, "rawAmount"> & { readonly rawAmount: string };

export interface PortfolioWire extends Omit<PortfolioView, "live" | "claimable"> {
  readonly live: readonly HeldPositionWire[];
  readonly claimable: readonly HeldPositionWire[];
}

export function toWire(view: PortfolioView): PortfolioWire {
  const wire = (position: HeldPosition): HeldPositionWire => ({
    ...position,
    rawAmount: position.rawAmount.toString(),
  });
  return { ...view, live: view.live.map(wire), claimable: view.claimable.map(wire) };
}

export interface SweepResult {
  readonly claimed: number;
  readonly positions: number;
  readonly txHash: string | null;
  readonly error: string | null;
}

/** Redeem everything claimable in one call. Batched, so it is one transaction. */
export async function sweepRedeem(view: PortfolioView): Promise<SweepResult> {
  const exchange = signerExchange();
  if (!exchange) throw new Error("trading is off, so there is no signer to redeem with");
  if (view.claimable.length === 0) {
    return { claimed: 0, positions: 0, txHash: null, error: null };
  }

  try {
    const result = await exchange.trader.redeemMany({
      entries: view.claimable.map((p) => ({
        marketId: p.marketId as Hex,
        outcomeIdx: p.outcomeIdx,
        amount: p.rawAmount,
      })),
    });
    return {
      claimed: view.claimableCollateral,
      positions: view.claimable.length,
      txHash: result.hash ?? null,
      error: result.receipt?.status === "reverted" ? "reverted on-chain" : null,
    };
  } catch (error) {
    return {
      claimed: 0,
      positions: view.claimable.length,
      txHash: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The signing account, when trading is on. */
export function deskAccount(): Address | null {
  const exchange = signerExchange();
  return (exchange?.walletAddress as Address | undefined) ?? null;
}
