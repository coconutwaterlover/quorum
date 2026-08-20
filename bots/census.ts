/**
 * A read-only pass over the venue: what is live, what it costs to buy an index
 * of it, and what settled history says about how much that index diversifies.
 *
 * Run it before anything else — it needs no key, sends nothing, and prints every
 * number the app is built on:
 *
 *     npx tsx bots/census.ts
 */

import { autocorrelation, cadenceTolerance, correlationMatrix, dependenceBetween } from "../src/engine/correlation";
import { equalWeights, quoteIndex } from "../src/engine/quote";
import { TEMPLATES } from "../src/engine/templates";
import { discover } from "../src/somnia/discover";
import { loadHistory, usableSeries } from "../src/somnia/history";
import { planBasket } from "../src/somnia/execute";
import { venueConfig } from "../src/somnia/exchange";
import type { WeightedLeg } from "../src/engine/types";

const pct = (v: number | null) => (v === null ? "  n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 3) => (v === null ? "n/a" : v.toFixed(d));

async function main() {
  const cfg = venueConfig();
  console.log(`\nquorum census — ${cfg.network}, venue ${cfg.venueId.slice(0, 10) || "(all)"}\n`);

  const { legs, books, skipped } = await discover();
  const upLegs = legs.filter((l) => l.side === "UP");
  console.log(`live windows: ${upLegs.length}`);
  for (const { reason, count } of skipped) console.log(`  skipped ${count}: ${reason}`);
  console.log();

  console.log("series        expires in   up bid   up ask    mid   depth");
  for (const leg of [...upLegs].sort((a, b) => a.expiry - b.expiry)) {
    const mins = Math.round((leg.expiry - Math.floor(Date.now() / 1000)) / 60);
    console.log(
      `${leg.series.padEnd(12)} ${String(mins + "m").padStart(9)}   ${num(leg.bid).padStart(6)}   ${num(leg.ask).padStart(6)}  ${num(leg.mid).padStart(5)}   ${num(leg.askSize, 0).padStart(5)}`,
    );
  }

  const history = await loadHistory();
  const series = usableSeries(history);
  console.log(`\nsettled history: ${history.rowsScanned} rows scanned, ${series.length} series with 20+ windows`);
  console.log(`  windows carrying a traded price: ${history.windowsWithPrice} (the rest never traded)`);
  console.log(`  voided windows excluded: ${history.voidedWindows}`);

  console.log("\nrealized dependence, cross-asset over the same window:");
  for (const interval of ["15m", "1h", "4h", "24h", "1m"]) {
    const d = dependenceBetween(history.outcomes, `BTC|${interval}`, `ETH|${interval}`);
    if (d.n >= 20) console.log(`  BTC/ETH ${interval.padEnd(4)} rho ${num(d.rho)}  (n=${d.n})`);
  }
  console.log("\nrealized dependence, same series one window later:");
  for (const key of series) {
    const list = history.outcomes.get(key)!;
    if (list.length < 40) continue;
    const one = autocorrelation(list, 1);
    console.log(`  ${key.padEnd(10)} lag1 rho ${num(one.rho)}  (n=${one.n})`);
  }

  for (const template of TEMPLATES) {
    const picked = template.pick(upLegs);
    if (picked.length < 2) continue;
    const weights = equalWeights(picked.length);
    const weighted: WeightedLeg[] = picked.map((leg, i) => ({ ...leg, weightBp: weights[i] }));
    const matrix = correlationMatrix(history.outcomes, picked.map((l) => l.series), cadenceTolerance);
    const quote = quoteIndex(weighted, { kind: "AVERAGE" }, {
      correlation: matrix,
      fallbackRho: 0.5,
      rolls: 12,
      rhoBetweenRolls: 0.05,
    });

    console.log(`\n── ${template.name} (${picked.length} legs) ──`);
    console.log(`  legs        ${picked.map((l) => l.series).join(", ")}`);
    console.log(`  fair value  ${num(quote.fair)}   cost to take ${num(quote.cost)}   spread paid ${num(quote.spreadCost)}`);
    console.log(`  one contract at the same value would carry sd ${num(quote.sdSingleContract)}`);
    console.log(`  this basket, if legs were independent: sd ${num(quote.sdIndependent)}`);
    console.log(`  this basket, at measured correlation:  sd ${num(quote.sdRealized)}  (${pct(quote.riskReduction)} less risk)`);
    console.log(`  worth ${num(quote.effectiveLegs, 2)} independent coin flips out of ${picked.length} legs`);
    console.log(`  mean rho across the legs: ${num(matrix.meanOffDiagonal)}, unmeasured pairs: ${matrix.unmeasured}`);
    if (quote.rollProjection) {
      console.log(`  rolled ${quote.rollProjection.rolls}x: sd ${num(quote.rollProjection.sd)} — ${num(quote.rollProjection.effectiveLegs, 1)} effective flips`);
    }
    console.log(`  P(nothing pays) ${pct(quote.pTotalLoss)}   P(everything pays) ${pct(quote.pTotalWin)}   P(beats cost) ${pct(quote.pProfit)}`);
    console.log(`  payoff 5th/50th/95th: ${num(quote.p05)} / ${num(quote.median)} / ${num(quote.p95)}`);

    const plan = planBasket(weighted, books, 10);
    console.log(`  a 10 ${cfg.collateralLabel} buy: ${num(plan.unitsPlanned, 2)} units, escrow ${num(plan.totalEscrow)}, cost/unit ${num(plan.costPerUnit)}, unfillable legs ${plan.unfillableLegs}`);
  }

  console.log("\nshapes on the widest basket (priced from the same mids):");
  const widest = TEMPLATES[0].pick(upLegs);
  if (widest.length >= 2) {
    const weights = equalWeights(widest.length);
    const quote = quoteIndex(
      widest.map((leg, i) => ({ ...leg, weightBp: weights[i] })),
      { kind: "AVERAGE" },
    );
    for (const shape of quote.shapes) {
      console.log(`  ${shape.label.padEnd(18)} ${num(shape.fair)}  ${shape.replicable ? "replicable by holding the legs" : "needs a counterparty"}`);
    }
  }
  console.log();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
