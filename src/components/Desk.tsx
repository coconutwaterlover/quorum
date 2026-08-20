"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CorrelationMatrix } from "@/engine/correlation";
import type { IndexQuote } from "@/engine/quote";
import type { BacktestResult } from "@/engine/backtest";
import type { Leg, WeightedLeg } from "@/engine/types";
import type { BasketPlan, BasketReceipt } from "@/somnia/execute";
import type { PortfolioView, SweepResult } from "@/somnia/portfolio";
import type { DeskSnapshot } from "@/somnia/desk";
import { CorrelationGrid, EquityCurves, PayoffLadder, RiskBars, type Rung } from "./charts";

type QuoteView = Omit<IndexQuote, "distribution"> & { ladder: Rung[] };

interface QuoteResponse {
  asOf: number;
  legs: WeightedLeg[];
  quote: QuoteView;
  plan: BasketPlan;
  correlation: CorrelationMatrix;
  rhoBetweenRolls: number;
  rhoWindows: number;
  backtest: BacktestResult;
  missing: string[];
}

type Side = "UP" | "DOWN";

const price = (v: number | null | undefined, digits = 3) =>
  v === null || v === undefined ? "—" : v.toFixed(digits);
const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`;

function countdown(expiry: number, now: number): string {
  const seconds = expiry - now;
  if (seconds <= 0) return "closed";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

export default function Desk() {
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null);
  const [selection, setSelection] = useState<Map<string, Side>>(new Map());
  const [weighting, setWeighting] = useState<"equal" | "risk-parity">("equal");
  const [stake, setStake] = useState(10);
  const [rolls, setRolls] = useState(12);
  const [entryPrice, setEntryPrice] = useState(0.5);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [receipt, setReceipt] = useState<BasketReceipt | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [account, setAccount] = useState("");
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioBusy, setPortfolioBusy] = useState(false);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);

  const loadSnapshot = useCallback(async () => {
    const response = await fetch("/api/desk", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "could not reach the venue");
      return;
    }
    setSnapshot(body as DeskSnapshot);
    setError(null);
  }, []);

  useEffect(() => {
    void loadSnapshot();
    const refresh = setInterval(() => void loadSnapshot(), 30_000);
    return () => clearInterval(refresh);
  }, [loadSnapshot]);

  const upLegs = useMemo(
    () => (snapshot?.legs ?? []).filter((l) => l.side === "UP").sort((a, b) => a.expiry - b.expiry),
    [snapshot],
  );
  const legBySide = useMemo(() => {
    const map = new Map<string, { UP: Leg; DOWN: Leg }>();
    for (const leg of snapshot?.legs ?? []) {
      const entry = map.get(leg.marketId) ?? ({} as { UP: Leg; DOWN: Leg });
      entry[leg.side] = leg;
      map.set(leg.marketId, entry);
    }
    return map;
  }, [snapshot]);

  // Open on the widest basket, so the page shows a real index rather than an
  // empty form asking the reader to guess what one is.
  useEffect(() => {
    if (initialized.current || !snapshot || upLegs.length === 0) return;
    initialized.current = true;
    const widest = snapshot.templates.find((t) => t.id === "wide");
    setSelection(new Map((widest?.marketIds ?? upLegs.map((l) => l.marketId)).map((id) => [id, "UP" as Side])));
  }, [snapshot, upLegs]);

  const selectionPayload = useMemo(
    () => [...selection.entries()].map(([marketId, side]) => ({ marketId, side })),
    [selection],
  );

  useEffect(() => {
    if (selectionPayload.length === 0) {
      setQuote(null);
      return;
    }
    let live = true;
    const run = async () => {
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selection: selectionPayload,
          weighting,
          stake,
          rolls,
          assumedEntryPrice: entryPrice,
        }),
      });
      const body = await response.json();
      if (!live) return;
      if (!response.ok) {
        setError(body.error ?? "could not price the basket");
        return;
      }
      setQuote(body as QuoteResponse);
      setError(null);
    };
    void run();
    return () => {
      live = false;
    };
  }, [selectionPayload, weighting, stake, rolls, entryPrice]);

  const toggle = (marketId: string) =>
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(marketId)) next.delete(marketId);
      else next.set(marketId, "UP");
      return next;
    });

  const setSide = (marketId: string, side: Side) =>
    setSelection((current) => new Map(current).set(marketId, side));

  const applyTemplate = (marketIds: readonly string[]) =>
    setSelection(new Map(marketIds.map((id) => [id, "UP" as Side])));

  const loadPortfolio = useCallback(async (address: string) => {
    setPortfolioBusy(true);
    setSweep(null);
    try {
      const query = address.trim() ? `?account=${encodeURIComponent(address.trim())}` : "";
      const response = await fetch(`/api/portfolio${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        setPortfolioError(body.error ?? "could not read that account");
        setPortfolio(null);
      } else {
        setPortfolio(body as PortfolioView);
        setPortfolioError(null);
      }
    } finally {
      setPortfolioBusy(false);
    }
  }, []);

  const redeem = async () => {
    setPortfolioBusy(true);
    try {
      const response = await fetch("/api/portfolio", { method: "POST" });
      const body = await response.json();
      if (!response.ok) setPortfolioError(body.error ?? "redeem failed");
      else {
        setSweep(body as SweepResult);
        setPortfolioError(null);
        await loadPortfolio(account);
      }
    } finally {
      setPortfolioBusy(false);
    }
  };

  const buy = async () => {
    setBuying(true);
    setReceipt(null);
    try {
      const response = await fetch("/api/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: selectionPayload, weighting, stake }),
      });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "the basket did not go through");
      else {
        setReceipt(body as BasketReceipt);
        setError(null);
      }
    } finally {
      setBuying(false);
      void loadSnapshot();
    }
  };

  if (!snapshot) {
    return (
      <section className="panel">
        <h2>Connecting</h2>
        <p className="lede">Reading the live windows off the venue…</p>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  const { venue, trading } = snapshot;
  const q = quote?.quote;

  return (
    <>
      <div className="chips">
        <span className="chip live">{venue.network} · {venue.collateral}</span>
        <span className="chip">{upLegs.length} live windows</span>
        <span className="chip">{snapshot.history.rowsScanned} settled windows read</span>
        <span className={trading.enabled ? "chip live" : "chip off"}>
          {trading.enabled ? `trading on · max ${trading.maxStake} ${venue.collateral}` : "read-only"}
        </span>
      </div>

      {/* ------------------------------------------------------------ board */}
      <section className="panel">
        <h2>The board</h2>
        <p className="lede">
          Every window open on this venue right now. There is exactly one live window per series —
          no window <em>t+1</em> exists to buy today — so a basket built here is a cross-section of
          the open windows, and holding it over time means buying each successor as it appears.
        </p>

        <div className="presets">
          {snapshot.templates
            .filter((t) => t.marketIds.length >= 2)
            .map((template) => (
              <button key={template.id} className="preset" onClick={() => applyTemplate(template.marketIds)}>
                <b>{template.name} · {template.marketIds.length}</b>
                <span>{template.thesis}</span>
              </button>
            ))}
        </div>

        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>series</th>
                <th>closes in</th>
                <th>up bid</th>
                <th>up ask</th>
                <th>down ask</th>
                <th>spread</th>
                <th>depth</th>
                <th>in basket</th>
                <th>side</th>
                <th>weight</th>
              </tr>
            </thead>
            <tbody>
              {upLegs.map((leg) => {
                const pair = legBySide.get(leg.marketId);
                const side = selection.get(leg.marketId);
                const inBasket = side !== undefined;
                const weighted = quote?.legs.find((l) => l.marketId === leg.marketId);
                const spread = leg.ask !== null && leg.bid !== null ? leg.ask - leg.bid : null;
                return (
                  <tr key={leg.marketId} className={inBasket ? "picked" : undefined}>
                    <td className="series">{leg.asset} {leg.interval}</td>
                    <td className="num muted">{countdown(leg.expiry, now)}</td>
                    <td className="num">{price(leg.bid)}</td>
                    <td className="num up">{price(leg.ask)}</td>
                    <td className="num down">{price(pair?.DOWN.ask ?? null)}</td>
                    <td className="num dim">{spread === null ? "—" : spread.toFixed(3)}</td>
                    <td className="num dim">{leg.askSize === null ? "—" : leg.askSize.toFixed(0)}</td>
                    <td>
                      <button className={inBasket ? "tiny on" : "tiny"} onClick={() => toggle(leg.marketId)}>
                        {inBasket ? "in" : "add"}
                      </button>
                    </td>
                    <td>
                      <span className="sidepick">
                        <button className={side === "UP" ? "tiny on" : "tiny"} disabled={!inBasket}
                          onClick={() => setSide(leg.marketId, "UP")}>up</button>
                        <button className={side === "DOWN" ? "tiny on" : "tiny"} disabled={!inBasket}
                          onClick={() => setSide(leg.marketId, "DOWN")}>down</button>
                      </span>
                    </td>
                    <td className="num dim">
                      {weighted ? `${(weighted.weightBp / 100).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="controls" style={{ marginTop: 18 }}>
          <label className="field">
            weighting
            <span className="sidepick">
              <button className={weighting === "equal" ? "on" : ""} onClick={() => setWeighting("equal")}>equal</button>
              <button className={weighting === "risk-parity" ? "on" : ""} onClick={() => setWeighting("risk-parity")}>
                risk parity
              </button>
            </span>
          </label>
          <label className="field">
            stake ({venue.collateral})
            <input type="number" min={1} step={1} value={stake}
              onChange={(e) => setStake(Math.max(0, Number(e.target.value)))} />
          </label>
          <label className="field">
            rolls to hold: {rolls}
            <input type="range" min={1} max={48} value={rolls}
              onChange={(e) => setRolls(Number(e.target.value))} />
          </label>
        </div>
        {snapshot.skipped.length > 0 && (
          <p className="note">
            Filtered before quoting: {snapshot.skipped.map((s) => `${s.count} ${s.reason}`).join("; ")}.
          </p>
        )}
      </section>

      {error && <p className="error">{error}</p>}

      {/* ------------------------------------------------------------- unit */}
      {q && quote && (
        <>
          <section className="panel">
            <h2>One index unit</h2>
            <p className="lede">
              A unit is a slice of every leg — {quote.legs.length} of them — sized by weight. It costs the
              weighted average of the leg prices and pays the weighted fraction of legs that win. That is
              why it needs no vault and no issuer: buying the legs <em>is</em> creation, selling them is
              redemption, and the NAV is a sum over prices already on the book.
            </p>

            <div className="stats">
              <div className="stat hero">
                <div className="k">fair value</div>
                <div className="v">{price(q.fair)}</div>
                <div className="n">weighted mid of the legs</div>
              </div>
              <div className="stat">
                <div className="k">cost to take</div>
                <div className="v">{price(q.cost)}</div>
                <div className="n">crossing all {quote.legs.length} books</div>
              </div>
              <div className="stat">
                <div className="k">spread paid</div>
                <div className="v">{price(q.spreadCost)}</div>
                <div className="n">an index buyer pays every leg&rsquo;s</div>
              </div>
              <div className="stat">
                <div className="k">exit now</div>
                <div className="v">{price(q.exit)}</div>
                <div className="n">selling back into the bids</div>
              </div>
            </div>

            <div className="grid-2" style={{ marginTop: 20 }}>
              <div>
                <h2>What it can pay</h2>
                <PayoffLadder rungs={q.ladder} cost={q.cost} fair={q.fair} />
                <div className="legend">
                  <span><i className="swatch" style={{ background: "var(--up)" }} />above cost</span>
                  <span><i className="swatch" style={{ background: "var(--down)" }} />below cost</span>
                </div>
                <p className="note">
                  A single contract has two bars and nothing between them. This has {q.ladder.length}.
                  P(pays nothing at all) {pct(q.pTotalLoss)} · P(every leg wins) {pct(q.pTotalWin)} ·
                  P(beats what it cost) {pct(q.pProfit)}.
                </p>
              </div>
              <div>
                <h2>Risk, measured</h2>
                <RiskBars
                  bars={[
                    { label: `one contract at ${price(q.fair)}`, sd: q.sdSingleContract, tone: "base" },
                    ...(q.sdRealized !== null
                      ? [{ label: `this basket, measured correlation`, sd: q.sdRealized, tone: "good" as const }]
                      : []),
                    { label: "this basket, if legs were independent", sd: q.sdIndependent, tone: "hollow" },
                    ...(q.rollProjection
                      ? [{ label: `rolled ${q.rollProjection.rolls}×`, sd: q.rollProjection.sd, tone: "best" as const }]
                      : []),
                  ]}
                />
                <div className="stats" style={{ marginTop: 14 }}>
                  <div className="stat">
                    <div className="k">risk removed</div>
                    <div className="v">{pct(q.riskReduction)}</div>
                    <div className="n">against one contract of equal value</div>
                  </div>
                  <div className="stat">
                    <div className="k">effective legs</div>
                    <div className="v">{q.effectiveLegs === null ? "—" : q.effectiveLegs.toFixed(2)}</div>
                    <div className="n">independent flips, out of {quote.legs.length}</div>
                  </div>
                </div>
              </div>
            </div>

            <p className="callout">
              <strong>The honest part.</strong> The gap between those two basket bars is dependence.
              BTC and ETH close the same way most of the time, so {quote.legs.length} legs bought at
              once are worth about {q.effectiveLegs === null ? "—" : q.effectiveLegs.toFixed(1)} independent
              coin flips, not {quote.legs.length}. Diversifying <em>across time</em> is what works here:
              consecutive windows measure out near-independent — pooled lag-1 ρ of{" "}
              {quote.rhoBetweenRolls.toFixed(3)} over {quote.rhoWindows.toLocaleString()} settled
              windows — which is why the rolled bar is the short one.
            </p>
          </section>

          {/* ------------------------------------------------------- shapes */}
          <section className="panel">
            <h2>Same legs, four payoffs</h2>
            <p className="lede">
              The leg set is one thing; the function you settle against is another. All of these are priced
              from the same mids — only the first is a linear function of the legs, and only a linear
              function can be replicated by holding them.
            </p>
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>payoff</th>
                    <th>fair value</th>
                    <th>vs the average</th>
                    <th>buildable by holding the legs</th>
                    <th style={{ textAlign: "left" }}>why</th>
                  </tr>
                </thead>
                <tbody>
                  {q.shapes.map((shape) => (
                    <tr key={shape.label}>
                      <td className="series">{shape.label}</td>
                      <td className="num">{price(shape.fair)}</td>
                      <td className="num dim">
                        {shape.shape.kind === "AVERAGE" ? "—" : `${((shape.fair / q.fair - 1) * 100).toFixed(0)}%`}
                      </td>
                      <td className={shape.replicable ? "up" : "dim"}>{shape.replicable ? "yes" : "no"}</td>
                      <td style={{ textAlign: "left", whiteSpace: "normal" }} className="muted">{shape.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">
              This app only executes the replicable one. The thresholds are shown because the comparison is
              the point: the same {quote.legs.length} windows are a mild diversifier or a lottery ticket
              depending on nothing but which function of them settles.
            </p>
          </section>

          {/* ------------------------------------------------------ history */}
          <section className="panel">
            <h2>What settled history says</h2>
            <p className="lede">
              Correlation is the whole argument, so it is measured rather than assumed — from{" "}
              {snapshot.history.rowsScanned} settled windows on this venue. Red is agreement, blue is
              disagreement, and a pale cell is independence. Hover a cell for the paired window count.
            </p>
            <CorrelationGrid keys={snapshot.correlation.keys} rho={snapshot.correlation.rho} n={snapshot.correlation.n} />
            <div className="legend">
              <span><i className="swatch" style={{ background: "var(--down)" }} />moves together</span>
              <span><i className="swatch" style={{ background: "var(--panel-2)", border: "1px solid var(--line)" }} />independent</span>
              <span><i className="swatch" style={{ background: "var(--cool)" }} />moves opposite</span>
            </div>

            <div className="scroller" style={{ marginTop: 20 }}>
              <table>
                <thead>
                  <tr>
                    <th>series</th>
                    <th>settled windows</th>
                    <th>up rate</th>
                    <th>ρ with its own next window</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.seriesStats.map((stat) => (
                    <tr key={stat.series}>
                      <td className="series">{stat.series.replace("|", " ")}</td>
                      <td className="num dim">{stat.windows}</td>
                      <td className="num">{pct(stat.upRate)}</td>
                      <td className="num">{stat.lag1 === null ? "—" : stat.lag1.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="callout">
              <strong>Read that last column.</strong> Cross-asset dependence is high, but a series barely
              knows what it did last window. Time is the diversifier this venue actually offers, and a
              rolling index is how you buy it.
            </p>
          </section>

          {/* ----------------------------------------------------- backtest */}
          <section className="panel">
            <h2>Replayed on settled windows</h2>
            <p className="lede">
              The same basket and a single contract, over {quote.backtest.rolls} settled windows, both
              entered at the same price so their expected values match by construction. The claim is not
              more profit — it is less noise.
              {quote.backtest.driverSeries && (
                <>
                  {" "}A complete roll needs every leg to have settled, so the coarsest leg sets the
                  clock: <span className="series">{quote.backtest.driverSeries.replace("|", " ")}</span>{" "}
                  here. Mixing a 24h window into a basket of 15m windows buys diversification but costs
                  you most of the replay — pick a single cadence for the long history.
                </>
              )}
            </p>
            <EquityCurves index={quote.backtest.index.equity} single={quote.backtest.singleLeg.equity} />
            <div className="legend">
              <span><i className="swatch" style={{ background: "var(--up)" }} />{quote.backtest.index.label}</span>
              <span><i className="swatch" style={{ background: "var(--down)" }} />{quote.backtest.singleLeg.label}</span>
            </div>
            <div className="stats" style={{ marginTop: 16 }}>
              <div className="stat hero">
                <div className="k">noise removed</div>
                <div className="v">{pct(quote.backtest.sdReduction)}</div>
                <div className="n">realized sd, not modelled</div>
              </div>
              <div className="stat">
                <div className="k">worst single roll</div>
                <div className="v">{price(quote.backtest.index.worstRoll)}</div>
                <div className="n">single contract: {price(quote.backtest.singleLeg.worstRoll)}</div>
              </div>
              <div className="stat">
                <div className="k">deepest drawdown</div>
                <div className="v">{price(quote.backtest.index.maxDrawdown, 2)}</div>
                <div className="n">single contract: {price(quote.backtest.singleLeg.maxDrawdown, 2)}</div>
              </div>
              <div className="stat">
                <div className="k">total wipeouts</div>
                <div className="v">{quote.backtest.index.wipeouts}</div>
                <div className="n">single contract: {quote.backtest.singleLeg.wipeouts}</div>
              </div>
            </div>
            <div className="controls" style={{ marginTop: 16 }}>
              <label className="field">
                replay entry price: {entryPrice.toFixed(2)}
                <input type="range" min={0.3} max={0.7} step={0.01} value={entryPrice}
                  onChange={(e) => setEntryPrice(Number(e.target.value))} />
              </label>
            </div>
            <p className="note">
              {quote.backtest.rollsWithRealizedPrice} of {quote.backtest.rolls} replayed windows carried a
              real traded price; the rest are entered at the slider above, because most windows on this
              venue never traded and inventing a price for them would be modelling an assumption and
              calling it history. Windows where a leg had no settled counterpart are skipped
              ({quote.backtest.skippedIncompleteWindows} of them), and voided windows are excluded
              entirely — they paid both sides half and are neither an up nor a down.
            </p>
          </section>

          {/* --------------------------------------------------------- plan */}
          <section className="panel">
            <h2>The orders this becomes</h2>
            <p className="lede">
              No index token is minted. A {stake} {venue.collateral} buy is{" "}
              {quote.plan.legs.length} market orders, each IOC so an unfilled remainder never rests on the
              book behind you, each sized by sweeping the live asks so the quoted shares are the ones that
              fill. A basket is not atomic — nothing here could make it atomic — so partial fills are
              reported per leg rather than hidden.
            </p>
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>leg</th>
                    <th>side</th>
                    <th>weight</th>
                    <th>stake</th>
                    <th>contracts</th>
                    <th>expected fill</th>
                    <th>worst price</th>
                    <th>levels</th>
                    <th>escrow</th>
                    <th style={{ textAlign: "left" }}>status</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.plan.legs.map((leg) => (
                    <tr key={`${leg.marketId}-${leg.side}`}>
                      <td className="series">{leg.series.replace("|", " ")}</td>
                      <td className={leg.side === "UP" ? "up" : "down"}>{leg.side.toLowerCase()}</td>
                      <td className="num dim">{(leg.weightBp / 100).toFixed(1)}%</td>
                      <td className="num">{leg.stake.toFixed(3)}</td>
                      <td className="num">{leg.contracts.toFixed(3)}</td>
                      <td className="num">{price(leg.expectedPrice)}</td>
                      <td className="num dim">{price(leg.limitPrice)}</td>
                      <td className="num dim">{leg.levelsConsumed || "—"}</td>
                      <td className="num">{leg.escrow.toFixed(3)}</td>
                      <td style={{ textAlign: "left", whiteSpace: "normal" }}
                        className={leg.unfillable ? "down" : "muted"}>
                        {leg.unfillable ?? "ready"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="stats" style={{ marginTop: 16 }}>
              <div className="stat">
                <div className="k">units bought</div>
                <div className="v">{quote.plan.unitsPlanned.toFixed(2)}</div>
                <div className="n">held back by the thinnest leg</div>
              </div>
              <div className="stat">
                <div className="k">cost per unit</div>
                <div className="v">{price(quote.plan.costPerUnit)}</div>
                <div className="n">expected, after real depth</div>
              </div>
              <div className="stat">
                <div className="k">worst per unit</div>
                <div className="v">{price(quote.plan.worstCostPerUnit)}</div>
                <div className="n">if every leg fills at its limit</div>
              </div>
              <div className="stat">
                <div className="k">escrowed</div>
                <div className="v">{quote.plan.totalEscrow.toFixed(2)}</div>
                <div className="n">max loss, of {stake} staked</div>
              </div>
              <div className="stat">
                <div className="k">unfillable legs</div>
                <div className="v">{quote.plan.unfillableLegs}</div>
                <div className="n">empty book or under one lot</div>
              </div>
            </div>

            <div className="controls" style={{ marginTop: 18 }}>
              <button className="primary" disabled={!trading.enabled || buying || quote.plan.unitsPlanned === 0}
                onClick={() => void buy()}>
                {buying ? "sending…" : `Buy ${quote.plan.unitsPlanned.toFixed(2)} units for ${stake} ${venue.collateral}`}
              </button>
              {!trading.enabled && (
                <span className="muted">
                  Read-only: {trading.reason}. Everything above is live; the table is exactly what would be sent.
                </span>
              )}
            </div>

            {receipt && (
              <>
                <p className="callout" style={{ marginTop: 18 }}>
                  <strong>Filled {receipt.contractsFilled.toFixed(3)} contracts</strong> for{" "}
                  {receipt.collateralSpent.toFixed(3)} {venue.collateral}.
                  {receipt.legsMissed > 0 &&
                    ` ${receipt.legsMissed} leg${receipt.legsMissed === 1 ? "" : "s"} filled nothing, so the basket is lopsided — the weights below are what you actually hold.`}
                </p>
                <div className="scroller">
                  <table>
                    <thead>
                      <tr>
                        <th>leg</th>
                        <th>filled</th>
                        <th>spent</th>
                        <th style={{ textAlign: "left" }}>tx</th>
                        <th style={{ textAlign: "left" }}>note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipt.fills.map((fill) => (
                        <tr key={`${fill.marketId}-${fill.side}`}>
                          <td className="series">{fill.series.replace("|", " ")} {fill.side.toLowerCase()}</td>
                          <td className="num">{fill.contractsFilled.toFixed(3)}</td>
                          <td className="num">{fill.collateralSpent.toFixed(3)}</td>
                          <td style={{ textAlign: "left" }} className="num dim">
                            {fill.txHash ? (
                              <a href={`${venue.explorer}/tx/${fill.txHash}`} target="_blank" rel="noreferrer">
                                {fill.txHash.slice(0, 10)}…
                              </a>
                            ) : "—"}
                          </td>
                          <td style={{ textAlign: "left", whiteSpace: "normal" }} className={fill.error ? "down" : "muted"}>
                            {fill.error ?? "filled"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}

      {/* ---------------------------------------------------------- holdings */}
      <section className="panel">
        <h2>Positions and claims</h2>
        <p className="lede">
          There is no index token to look up, so a holding <em>is</em> a set of outcome-token balances —
          which is also why claiming is the step people miss. A settled market leaves the live list
          entirely, so scanning open markets for winnings finds nothing while real ones sit unclaimed.
          This reads the finalized markets instead.
        </p>
        <div className="controls">
          <label className="field">
            account
            <input type="text" placeholder={trading.enabled ? "blank = this desk's own key" : "0x…"}
              value={account} onChange={(e) => setAccount(e.target.value)}
              style={{
                font: "inherit", fontFamily: "var(--mono)", width: 400, padding: "6px 9px",
                background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 7, color: "var(--text)",
              }} />
          </label>
          <button onClick={() => void loadPortfolio(account)} disabled={portfolioBusy}>
            {portfolioBusy ? "reading…" : "read positions"}
          </button>
          {portfolio && portfolio.claimable.length > 0 && (
            <button className="primary" disabled={!trading.enabled || portfolioBusy} onClick={() => void redeem()}>
              Claim {portfolio.claimableCollateral.toFixed(3)} {venue.collateral}
            </button>
          )}
        </div>
        {portfolioError && <p className="error">{portfolioError}</p>}
        {sweep && (
          <p className="callout" style={{ marginTop: 14 }}>
            {sweep.error
              ? `Redeem failed: ${sweep.error}`
              : `Claimed ${sweep.claimed.toFixed(3)} ${venue.collateral} from ${sweep.positions} position(s).`}
            {sweep.txHash && (
              <> <a href={`${venue.explorer}/tx/${sweep.txHash}`} target="_blank" rel="noreferrer">tx</a></>
            )}
          </p>
        )}
        {portfolio && (
          <>
            <div className="stats" style={{ marginTop: 16 }}>
              <div className="stat">
                <div className="k">open contracts</div>
                <div className="v">{portfolio.liveContracts.toFixed(3)}</div>
                <div className="n">across {portfolio.live.length} position(s)</div>
              </div>
              <div className="stat hero">
                <div className="k">claimable now</div>
                <div className="v">{portfolio.claimableCollateral.toFixed(3)}</div>
                <div className="n">{portfolio.claimable.length} settled position(s)</div>
              </div>
            </div>
            {[...portfolio.live, ...portfolio.claimable].length > 0 ? (
              <div className="scroller" style={{ marginTop: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th>market</th>
                      <th>side</th>
                      <th>contracts</th>
                      <th>state</th>
                      <th>pays</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...portfolio.live, ...portfolio.claimable].map((position) => (
                      <tr key={`${position.marketId}-${position.outcomeIdx}`}>
                        <td className="series">{position.series.replace("|", " ")}</td>
                        <td className={position.side === "UP" ? "up" : "down"}>{position.side.toLowerCase()}</td>
                        <td className="num">{position.contracts.toFixed(3)}</td>
                        <td className="muted">
                          {position.status === "live"
                            ? `open, closes ${countdown(position.expiry, now)}`
                            : position.status === "voided"
                              ? "voided — both sides pay half"
                              : position.won
                                ? "won"
                                : "lost"}
                        </td>
                        <td className="num">{position.status === "live" ? "—" : position.claimable.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="note">Nothing held on this account in the windows scanned.</p>
            )}
            <p className="note">
              Redeeming a losing position does not revert — it succeeds and pays nothing — so only the
              winning side is claimed, and a voided market claims both sides explicitly because there is
              no winner to infer. dreamDEX sets the settlement fee to zero, so a winner redeems 1:1.
            </p>
          </>
        )}
      </section>
    </>
  );
}
