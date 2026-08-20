/**
 * Preset leg sets.
 *
 * The venue lists exactly one live window per series at a time, so a basket
 * bought right now is a cross-section: BTC and ETH across the cadences that
 * happen to be open. These presets are the handful of cross-sections worth
 * holding, and each one exists to isolate a different source of dependence.
 */

import type { Leg } from "./types";

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly thesis: string;
  readonly pick: (legs: readonly Leg[]) => Leg[];
}

const byExpiry = (a: Leg, b: Leg) => a.expiry - b.expiry;
const tradable = (l: Leg) => l.ask !== null;
const distanceFromEven = (l: Leg) => Math.abs((l.mid ?? 0.5) - 0.5);

export const TEMPLATES: readonly Template[] = [
  {
    id: "fast-four",
    name: "The fast four",
    thesis:
      "Both assets on the two quickest cadences. Four legs is a real cross-section, and these are the series with hundreds of settled windows behind them — so it is the only basket whose history is deep enough to replay properly.",
    pick: (legs) => {
      const quick = quickestIntervals(legs, 2);
      return legs.filter((l) => tradable(l) && quick.includes(l.interval)).sort(byExpiry);
    },
  },
  {
    id: "wide",
    name: "Everything open",
    thesis:
      "Every live window on the venue, equally weighted. The widest cross-section available, and the baseline the others are judged against.",
    pick: (legs) => legs.filter(tradable).sort(byExpiry),
  },
  {
    id: "coin-flips",
    name: "The fairest six",
    thesis:
      "The six windows priced closest to even money. A contract at 0.95 carries almost no variance to diversify away — the uncertain ones are where a basket earns its keep.",
    pick: (legs) => legs.filter(tradable).sort((a, b) => distanceFromEven(a) - distanceFromEven(b)).slice(0, 6),
  },
  {
    id: "cross-asset",
    name: "BTC against ETH",
    thesis:
      "Both assets on the shortest shared cadence. Isolates cross-asset dependence, which settled history puts near 0.7 — real diversification, but far less than the leg count suggests.",
    pick: (legs) => {
      const shared = shortestSharedInterval(legs);
      return shared ? legs.filter((l) => tradable(l) && l.interval === shared).sort(byExpiry) : [];
    },
  },
  {
    id: "cross-cadence",
    name: "One asset, every clock",
    thesis:
      "A single asset across all its open cadences. The windows overlap in time, so this is the least diversified basket that still looks like an index — useful as the counter-example.",
    pick: (legs) => {
      const asset = mostRepresentedAsset(legs);
      return asset ? legs.filter((l) => tradable(l) && l.asset === asset).sort(byExpiry) : [];
    },
  },
  {
    id: "liquid",
    name: "Tightest books",
    thesis:
      "The six narrowest spreads. An index buyer crosses every leg, so the basket pays N spreads — picking on liquidity is picking on cost, not on view.",
    pick: (legs) =>
      legs
        .filter((l) => l.ask !== null && l.bid !== null)
        .sort((a, b) => (a.ask! - a.bid!) - (b.ask! - b.bid!))
        .slice(0, 6),
  },
];

/**
 * The `count` quickest cadences that are open. Quick cadences roll often, so
 * they are also the ones with a long settled history — a 24h series has two
 * dozen windows behind it where a 15m series has hundreds, and a basket is only
 * replayable as far back as its thinnest leg.
 */
function quickestIntervals(legs: readonly Leg[], count: number): string[] {
  return [...new Set(legs.filter(tradable).map((l) => l.interval))]
    .sort((a, b) => intervalSeconds(a) - intervalSeconds(b))
    .slice(0, count);
}

function shortestSharedInterval(legs: readonly Leg[]): string | null {
  const assetsByInterval = new Map<string, Set<string>>();
  for (const l of legs) {
    if (!tradable(l)) continue;
    if (!assetsByInterval.has(l.interval)) assetsByInterval.set(l.interval, new Set());
    assetsByInterval.get(l.interval)!.add(l.asset);
  }
  const shared = [...assetsByInterval.entries()].filter(([, a]) => a.size > 1).map(([i]) => i);
  if (shared.length === 0) return null;
  return shared.sort((a, b) => intervalSeconds(a) - intervalSeconds(b))[0];
}

function mostRepresentedAsset(legs: readonly Leg[]): string | null {
  const counts = new Map<string, number>();
  for (const l of legs) if (tradable(l)) counts.set(l.asset, (counts.get(l.asset) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? null;
}

/** `"15m"` / `"1h"` / `"176s"` — the venue mints odd cadences, so parse, don't switch. */
export function intervalSeconds(interval: string): number {
  const match = /^(\d+)([smhd])$/.exec(interval);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const n = Number(match[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
}
