/**
 * Finding the legs an index can actually be built from, right now.
 *
 * The venue lists exactly one live window per series at a time — there is no
 * pre-listed window t+1 to buy today — so a basket bought at this instant is a
 * cross-section of the open windows, and holding one across time means buying
 * the successors as they appear. That single fact shapes the whole product, so
 * discovery is deliberately strict about what counts as live:
 *
 *   1. the indexer keeps rows in `Trading` long after their window closed, so an
 *      expiry in the past is the first filter and it removes hundreds of rows;
 *   2. status is time-derived on-chain and the index lags by seconds, so every
 *      surviving candidate is re-read from the chain before it is offered;
 *   3. a window minutes from expiry can lock between the quote and the order, so
 *      legs without headroom are dropped rather than quoted.
 */

import type { BinaryOrderBook } from "@somnia-chain/markets-sdk";
import type { Leg, Side } from "@/engine/types";
import { readExchange, venueConfig } from "./exchange";

/** Raw book plus the pool grid, kept together so execution never re-reads them apart. */
export interface LegBook {
  readonly marketId: string;
  readonly pool: `0x${string}`;
  readonly book: BinaryOrderBook;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minQuantity: bigint;
  readonly decimals: number;
  readonly outcomeToken: `0x${string}`;
  readonly yesId: bigint;
  readonly noId: bigint;
  readonly marketAddress: `0x${string}`;
}

export interface Discovery {
  readonly asOf: number;
  readonly legs: readonly Leg[];
  readonly books: ReadonlyMap<string, LegBook>;
  /** Rows dropped, with the reason, so the UI can say what it filtered. */
  readonly skipped: { readonly reason: string; readonly count: number }[];
}

export interface DiscoverOptions {
  /** Seconds of headroom a window needs before it is worth quoting. */
  readonly minSecondsLeft?: number;
  readonly bookDepth?: number;
}

export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
  const minSecondsLeft = options.minSecondsLeft ?? 60;
  const depth = options.bookDepth ?? 5;
  const exchange = readExchange();
  const cfg = venueConfig();
  const now = Math.floor(Date.now() / 1000);

  // `listBinaryMarkets({ status: "Trading" })` is the wrong door here: the
  // indexer leaves hundreds of long-closed windows sitting in Trading, and they
  // arrive newest-created first, so a flat query is mostly rubble. The live
  // list filters `expiry > now` server-side and sorts soonest-to-expire.
  const query: Record<string, unknown> = { status: "Trading" };
  if (cfg.venueId) query.venueId = cfg.venueId;
  const rows = await exchange.client.listLiveBinaryMarkets(query as never);

  const skipped = new Map<string, number>();
  const bump = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const fresh = rows.filter((row) => {
    const expiry = Number(row.expiry);
    if (expiry - now < minSecondsLeft) {
      bump(`under ${minSecondsLeft}s of headroom left`);
      return false;
    }
    return true;
  });

  // One round trip per market, not one after another. Serially this is the
  // whole cost of a cold request — 3.8s for eight markets against 0.5s
  // concurrently — and on a serverless deploy every request is a cold one.
  const probed = await Promise.all(
    fresh.map(async (row) => {
      const marketId = row.marketId as `0x${string}`;
      const onchain = await exchange.client.getMarketOnchain(marketId);
      if (onchain.status !== 1) return { row, skip: "on-chain status is not Trading" as const };
      if (Number(onchain.expiry) - now < minSecondsLeft) {
        return { row, skip: "on-chain expiry left no headroom" as const };
      }
      const pool = onchain.pool as `0x${string}`;
      const decimals = Number(onchain.decimals);
      // `decimals` is not optional in practice: the NO side is derived as
      // 1 - yesPrice, and the default of 6 would invert an 18-decimal book
      // against the wrong "one".
      const [book, params] = await Promise.all([
        exchange.client.getBinaryOrderBook(pool, { depth, decimals }),
        exchange.client.getBinaryBookParams(pool),
      ]);
      return { row, onchain, pool, decimals, book, params, skip: null };
    }),
  );

  const legs: Leg[] = [];
  const books = new Map<string, LegBook>();

  for (const probe of probed) {
    if (probe.skip !== null) {
      bump(probe.skip);
      continue;
    }
    const { row, onchain, pool, decimals, book, params } = probe;
    const marketId = row.marketId as `0x${string}`;
    const one = 10 ** decimals;
    const tops = bookTops(book);
    const series = `${row.asset}|${row.interval}`;

    const shared = {
      marketId,
      series,
      asset: String(row.asset),
      interval: String(row.interval),
      poolAddress: pool,
      marketAddress: onchain.marketAddress as `0x${string}`,
      expiry: Number(onchain.expiry),
      tradingStart: Number(row.tradingStart),
      // A relative market carries strike 0: the strike is the window's own
      // opening price, fixed by the oracle rather than written into the row.
      strike: row.strike && row.strike !== "0" ? String(row.strike) : null,
      question: String(row.question ?? ""),
      venueId: String(row.venueId),
      oracleQuestionId: row.oracleQuestionId ? String(row.oracleQuestionId) : null,
      decimals,
    };

    for (const side of ["UP", "DOWN"] as Side[]) {
      const isUp = side === "UP";
      const bid = raw(isUp ? tops.yesBid : tops.noBid, one);
      const ask = raw(isUp ? tops.yesAsk : tops.noAsk, one);
      const askSize = raw(isUp ? tops.yesAskSize : tops.noAskSize, one);
      legs.push({
        ...shared,
        side,
        bid,
        ask,
        mid: midOf(bid, ask),
        askSize,
      });
    }

    books.set(marketId, {
      marketId,
      pool,
      book,
      tickSize: params.tickSize,
      lotSize: params.lotSize,
      minQuantity: params.minQuantity,
      decimals,
      outcomeToken: onchain.outcomeToken as `0x${string}`,
      yesId: BigInt(onchain.yesId),
      noId: BigInt(onchain.noId),
      marketAddress: onchain.marketAddress as `0x${string}`,
    });
  }

  return {
    asOf: now,
    legs,
    books,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Top of each of the four sides. The NO levels arrive already inverted into NO
 * terms by the SDK, so a NO ask is a NO price and needs no further arithmetic.
 */
function bookTops(book: BinaryOrderBook) {
  return {
    yesBid: book.yesBids[0]?.price ?? null,
    yesAsk: book.yesAsks[0]?.price ?? null,
    yesAskSize: book.yesAsks[0]?.quantity ?? null,
    noBid: book.noBids[0]?.price ?? null,
    noAsk: book.noAsks[0]?.price ?? null,
    noAskSize: book.noAsks[0]?.quantity ?? null,
  };
}

function raw(value: bigint | null | undefined, one: number): number | null {
  return value === null || value === undefined ? null : Number(value) / one;
}

function midOf(bid: number | null, ask: number | null): number | null {
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask ?? null;
}
