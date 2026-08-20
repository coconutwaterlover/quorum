/**
 * Settled history — the only honest source for how much an index actually
 * diversifies.
 *
 * `loadMarkets()` is no help here: the registry sweep behind it skips finalized
 * binaries, so filtering it for inactive rows returns an empty set. The binary
 * tier keeps them under the terminal status `Finalized`, and that is what this
 * reads.
 *
 * Realized prices are collected where they exist but most settled windows never
 * traded, so they are returned separately rather than folded into the outcomes.
 * A backtest that quietly substituted 0.5 for a missing print would be modelling
 * its own assumption and calling it history.
 */

import type { Outcome } from "@/engine/correlation";
import { readExchange, venueConfig } from "./exchange";

export interface History {
  /** Series key -> settled windows, oldest first. */
  readonly outcomes: ReadonlyMap<string, Outcome[]>;
  /** `${series}|${expiry}` -> last traded Up price, where one exists. */
  readonly realizedPrices: ReadonlyMap<string, number>;
  readonly rowsScanned: number;
  readonly voidedWindows: number;
  readonly windowsWithPrice: number;
  readonly oldestExpiry: number | null;
  readonly newestExpiry: number | null;
}

export interface HistoryOptions {
  /** Rows to pull per series. */
  readonly limitPerSeries?: number;
  readonly assets?: readonly string[];
  readonly intervalSeconds?: readonly number[];
}

/**
 * `listBinaryMarkets` takes a limit but no offset, so there is no way to page
 * *through* a status — asking for the next 500 returns the same 500. History is
 * therefore collected by narrowing: one query per (asset, cadence) facet, each
 * with its own limit. That also buys far more depth per series than a single
 * flat query, which spends its whole budget on whichever cadence rolls fastest.
 *
 * Rows are deduplicated by market id on the way in regardless. A repeated row
 * would land as a second settled window at the same expiry, and after sorting it
 * would sit next to its own copy — which reads as near-perfect autocorrelation
 * between consecutive windows, the exact number the index thesis turns on.
 */
const DEFAULT_ASSETS = ["BTC", "ETH"] as const;
const DEFAULT_CADENCES = [900, 3600, 14_400, 86_400] as const;

let cache: { at: number; value: History } | null = null;
const CACHE_MS = 60_000;

export async function loadHistory(options: HistoryOptions = {}): Promise<History> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const exchange = readExchange();
  const cfg = venueConfig();
  const limit = options.limitPerSeries ?? 500;
  const assets = options.assets ?? DEFAULT_ASSETS;
  const cadences = options.intervalSeconds ?? DEFAULT_CADENCES;

  const facets = assets.flatMap((asset) => cadences.map((intervalSec) => ({ asset, intervalSec })));
  const pages = await Promise.all(
    facets.map((facet) => {
      const query: Record<string, unknown> = { status: "Finalized", limit, ...facet };
      if (cfg.venueId) query.venueId = cfg.venueId;
      return exchange.client.listBinaryMarkets(query as never);
    }),
  );

  const seen = new Set<string>();
  const rows = pages.flat().filter((row) => {
    const id = String(row.marketId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const outcomes = new Map<string, Outcome[]>();
  const realizedPrices = new Map<string, number>();
  let voided = 0;
  let withPrice = 0;

  for (const row of rows) {
    if (row.voided) {
      // A voided window paid both sides 0.5. It is not an Up or a Down, so it
      // cannot enter a correlation or a backtest as either.
      voided++;
      continue;
    }
    if (row.winningOutcome === null || row.winningOutcome === undefined) continue;

    const series = `${row.asset}|${row.interval}`;
    const expiry = Number(row.expiry);
    if (!Number.isFinite(expiry)) continue;

    if (!outcomes.has(series)) outcomes.set(series, []);
    outcomes.get(series)!.push({ expiry, up: Number(row.winningOutcome) === 0 ? 1 : 0 });

    const price = normalizePrice(row.lastPrice, Number(row.quoteDecimals ?? 6));
    if (price !== null) {
      realizedPrices.set(`${series}|${expiry}`, price);
      withPrice++;
    }
  }

  for (const list of outcomes.values()) list.sort((a, b) => a.expiry - b.expiry);

  const allExpiries = [...outcomes.values()].flat().map((o) => o.expiry);
  const value: History = {
    outcomes,
    realizedPrices,
    rowsScanned: rows.length,
    voidedWindows: voided,
    windowsWithPrice: withPrice,
    oldestExpiry: allExpiries.length ? Math.min(...allExpiries) : null,
    newestExpiry: allExpiries.length ? Math.max(...allExpiries) : null,
  };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * The indexer hands prices back as decimal strings and the scale has moved
 * between deployments, so a fixed divisor is a latent off-by-1e12. Try the
 * market's own decimals first and only accept a value that lands inside (0, 1)
 * — a probability that does not is not a probability.
 */
function normalizePrice(raw: unknown, decimals: number): number | null {
  if (raw === null || raw === undefined) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  for (const scale of [10 ** decimals, 1e18, 1e6]) {
    const p = numeric / scale;
    if (p > 0 && p < 1) return p;
  }
  return null;
}

/** Series with enough settled windows for a correlation to mean anything. */
export function usableSeries(history: History, minWindows = 20): string[] {
  return [...history.outcomes.entries()]
    .filter(([, list]) => list.length >= minWindows)
    .map(([key]) => key)
    .sort();
}
