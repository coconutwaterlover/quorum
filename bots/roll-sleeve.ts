/**
 * The index as a bot: hold a basket, roll it as the windows expire, claim what
 * settles.
 *
 * This is the part the web app cannot be. The venue lists exactly one live window
 * per series, so a basket bought once is a single cross-section — and the
 * measurements in `bots/census.ts` say the cross-section is only worth about
 * three independent coin flips out of seven legs, because BTC and ETH close the
 * same way most of the time. What is close to independent is the *next* window:
 * pooled lag-1 correlation across these series sits near zero. So the variance
 * an index can actually remove is bought by rolling, and rolling needs something
 * running.
 *
 *   # look, send nothing (the default)
 *   npx tsx bots/roll-sleeve.ts
 *
 *   # trade it with your own key on Shannon
 *   QUORUM_PRIVATE_KEY=0x… QUORUM_ALLOW_TRADING=1 \
 *   QUORUM_SLEEVE=cross-asset QUORUM_STAKE=5 QUORUM_ROLLS=8 \
 *     npx tsx bots/roll-sleeve.ts
 *
 * Environment:
 *   QUORUM_SLEEVE     template id, or a comma-separated series list ("BTC|15m,ETH|15m")
 *   QUORUM_STAKE      collateral per roll (default 5)
 *   QUORUM_ROLLS      rolls to hold before stopping (default 8)
 *   QUORUM_SIDE       UP or DOWN for every leg (default UP)
 *   QUORUM_WEIGHTING  equal | risk-parity (default equal)
 */

import { autocorrelation, cadenceTolerance, correlationMatrix, poolDependence } from "../src/engine/correlation";
import { equalWeights, quoteIndex, riskParityWeights } from "../src/engine/quote";
import { TEMPLATES } from "../src/engine/templates";
import type { Leg, Side, WeightedLeg } from "../src/engine/types";
import { discover } from "../src/somnia/discover";
import { loadHistory } from "../src/somnia/history";
import { buyBasket, planBasket } from "../src/somnia/execute";
import { deskAccount, loadPortfolio, sweepRedeem } from "../src/somnia/portfolio";
import { tradingMode, venueConfig } from "../src/somnia/exchange";

const STAKE = Number(process.env.QUORUM_STAKE ?? 5);
const ROLLS = Number(process.env.QUORUM_ROLLS ?? 8);
const SLEEVE = process.env.QUORUM_SLEEVE ?? "cross-asset";
const SIDE: Side = process.env.QUORUM_SIDE === "DOWN" ? "DOWN" : "UP";
const WEIGHTING = process.env.QUORUM_WEIGHTING === "risk-parity" ? "risk-parity" : "equal";

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (message: string) => console.log(`${stamp()}  ${message}`);
const n = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? "—" : v.toFixed(d));

/** Resolve the sleeve definition against what is live right now. */
function pickLegs(legs: readonly Leg[]): Leg[] {
  const candidates = legs.filter((l) => l.side === SIDE);
  const template = TEMPLATES.find((t) => t.id === SLEEVE);
  if (template) {
    // Templates choose from the Up view; carry the choice onto the wanted side.
    const wanted = new Set(template.pick(legs.filter((l) => l.side === "UP")).map((l) => l.marketId));
    return candidates.filter((l) => wanted.has(l.marketId));
  }
  const wanted = new Set(SLEEVE.split(",").map((s) => s.trim()).filter(Boolean));
  return candidates.filter((l) => wanted.has(l.series));
}

function weigh(legs: readonly Leg[]): WeightedLeg[] {
  const weights =
    WEIGHTING === "risk-parity"
      ? riskParityWeights(legs.map((l) => l.mid ?? 0.5))
      : equalWeights(legs.length);
  return legs.map((leg, i) => ({ ...leg, weightBp: weights[i] }));
}

async function main() {
  const cfg = venueConfig();
  const mode = tradingMode();
  log(`quorum sleeve — ${cfg.network}, ${SLEEVE}, ${STAKE} ${cfg.collateralLabel} per roll, ${ROLLS} rolls`);
  log(mode.enabled ? `signing as ${deskAccount()}` : `DRY RUN — ${mode.reason}`);

  const history = await loadHistory();

  let rollsDone = 0;
  let staked = 0;
  let unitsHeld = 0;
  /** Expiry of the window bought last time, per series, so a roll is not double-bought. */
  const boughtThrough = new Map<string, number>();

  while (rollsDone < ROLLS) {
    const { legs, books } = await discover();
    const picked = pickLegs(legs);

    if (picked.length < 2) {
      log(`only ${picked.length} leg(s) live for "${SLEEVE}" — waiting`);
      await sleep(30_000);
      continue;
    }

    // A roll is only new when at least one leg has rolled to a fresh window.
    const fresh = picked.filter((l) => (boughtThrough.get(l.series) ?? 0) < l.expiry);
    if (fresh.length === 0) {
      const soonest = Math.min(...picked.map((l) => l.expiry));
      const wait = Math.max(15, soonest - Math.floor(Date.now() / 1000) + 5);
      log(`same windows as last roll — sleeping ${wait}s for the next one`);
      await sleep(wait * 1000);
      continue;
    }

    const weighted = weigh(picked);
    const seriesKeys = weighted.map((l) => l.series);
    const matrix = correlationMatrix(history.outcomes, seriesKeys, cadenceTolerance);
    const pooled = poolDependence(
      seriesKeys
        .map((k) => history.outcomes.get(k))
        .filter((l): l is NonNullable<typeof l> => !!l && l.length >= 20)
        .map((l) => autocorrelation(l, 1)),
    );
    const quote = quoteIndex(weighted, { kind: "AVERAGE" }, {
      correlation: matrix,
      fallbackRho: 0.5,
      rolls: ROLLS,
      rhoBetweenRolls: pooled.rho,
    });
    const plan = planBasket(weighted, books, STAKE);

    log(
      `roll ${rollsDone + 1}/${ROLLS} · ${seriesKeys.join(" ")} · fair ${n(quote.fair)} ` +
        `cost ${n(quote.cost)} · sd ${n(quote.sdRealized)} vs ${n(quote.sdSingleContract)} for one contract ` +
        `· ${n(quote.effectiveLegs, 2)} effective legs`,
    );
    for (const leg of plan.legs) {
      log(
        `    ${leg.series.padEnd(9)} ${leg.side.toLowerCase().padEnd(4)} ` +
          `${n(leg.contracts)} contracts @ ~${n(leg.expectedPrice)} (limit ${n(leg.limitPrice)})` +
          (leg.unfillable ? `  SKIP: ${leg.unfillable}` : ""),
      );
    }

    if (!mode.enabled) {
      log(`    dry run: would buy ${n(plan.unitsPlanned, 2)} units at ${n(plan.costPerUnit)} each`);
    } else if (plan.unitsPlanned === 0) {
      log("    nothing fillable this roll — skipping");
    } else {
      const receipt = await buyBasket(plan, books);
      const units = plan.unitsPlanned > 0 ? receipt.contractsFilled / plan.legs.length : 0;
      staked += receipt.collateralSpent;
      unitsHeld += units;
      log(
        `    filled ${n(receipt.contractsFilled)} contracts for ${n(receipt.collateralSpent)} ` +
          `${cfg.collateralLabel}` + (receipt.legsMissed ? ` · ${receipt.legsMissed} leg(s) missed` : ""),
      );
      for (const fill of receipt.fills.filter((f) => f.error)) {
        log(`    ! ${fill.series} ${fill.side}: ${fill.error}`);
      }
    }

    for (const leg of picked) boughtThrough.set(leg.series, leg.expiry);
    rollsDone++;

    // Claim before the next roll: redemption is the step people miss, and a
    // settled market drops out of the live list entirely, so nothing reminds you.
    const account = deskAccount();
    if (mode.enabled && account) {
      const view = await loadPortfolio(account, { windowsBack: 40 });
      if (view.claimable.length > 0) {
        const swept = await sweepRedeem(view);
        log(
          swept.error
            ? `    redeem failed: ${swept.error}`
            : `    claimed ${n(swept.claimed)} ${cfg.collateralLabel} from ${swept.positions} settled position(s)`,
        );
      } else if (view.live.length > 0) {
        log(`    holding ${n(view.liveContracts)} contracts across ${view.live.length} open position(s)`);
      }
    }

    if (rollsDone < ROLLS) {
      const soonest = Math.min(...picked.map((l) => l.expiry));
      const wait = Math.max(15, soonest - Math.floor(Date.now() / 1000) + 5);
      log(`    next window in ${wait}s`);
      await sleep(wait * 1000);
    }
  }

  log(`done: ${rollsDone} rolls, ${n(staked)} ${cfg.collateralLabel} staked, ${n(unitsHeld, 2)} units bought`);
  const account = deskAccount();
  if (mode.enabled && account) {
    const view = await loadPortfolio(account, { windowsBack: 60 });
    log(`open ${n(view.liveContracts)} contracts · claimable ${n(view.claimableCollateral)} ${cfg.collateralLabel}`);
    log("rerun to keep rolling, or claim the tail once the last windows settle");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
