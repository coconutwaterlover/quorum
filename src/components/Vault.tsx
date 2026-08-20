"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeskSnapshot } from "@/somnia/desk";
import {
  applySettlements,
  deposit,
  emptyLedger,
  rollInto,
  valueOf,
  withdrawAll,
  type LiveWindow,
  type Resolution,
  type VaultLedger,
} from "@/engine/vault";

const STORAGE_KEY = "quorum-up-vault-v1";
const SYNC_EVERY_MS = 10_000;

function countdown(expiry: number, now: number): string {
  const seconds = expiry - now;
  if (seconds <= 0) return "settling…";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

function clock(at: number): string {
  return new Date(at * 1000).toISOString().slice(11, 19);
}

function load(): VaultLedger {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as VaultLedger;
    return parsed.version === 1 ? parsed : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

export default function Vault() {
  const [ledger, setLedger] = useState<VaultLedger | null>(null);
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null);
  const [amount, setAmount] = useState(100);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const ledgerRef = useRef<VaultLedger | null>(null);
  ledgerRef.current = ledger;

  // The ledger lives in this browser: load once, persist on every change.
  useEffect(() => setLedger(load()), []);
  useEffect(() => {
    if (ledger) localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
  }, [ledger]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);

  const liveWindows: LiveWindow[] = useMemo(
    () =>
      (snapshot?.legs ?? [])
        .filter((l) => l.side === "UP")
        .map((l) => ({
          marketId: l.marketId,
          series: l.series,
          ask: l.ask,
          bid: l.bid,
          mid: l.mid,
          expiry: l.expiry,
        })),
    [snapshot],
  );
  const marks = useMemo(() => new Map(liveWindows.map((w) => [w.marketId, w])), [liveWindows]);

  /**
   * One sync pass: read the venue, settle whatever the oracle answered, roll
   * idle cash into whatever is open. All decisions are the pure engine's; the
   * network calls only fetch facts.
   */
  const sync = useCallback(async () => {
    const deskResponse = await fetch("/api/desk", { cache: "no-store" });
    const desk = (await deskResponse.json()) as DeskSnapshot & { error?: string };
    if (!deskResponse.ok) {
      setNotice(desk.error ?? "could not reach the venue");
      return;
    }
    setSnapshot(desk);
    setNotice(null);

    const current = ledgerRef.current;
    if (!current) return;
    const tick = Math.floor(Date.now() / 1000);
    let next = current;

    if (current.positions.length > 0) {
      const response = await fetch("/api/vault/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketIds: current.positions.map((p) => p.marketId) }),
      });
      const body = (await response.json()) as {
        resolutions?: Record<string, Resolution>;
        error?: string;
      };
      if (response.ok && body.resolutions) {
        next = applySettlements(next, new Map(Object.entries(body.resolutions)), tick);
      }
    }

    const live: LiveWindow[] = desk.legs
      .filter((l) => l.side === "UP")
      .map((l) => ({ marketId: l.marketId, series: l.series, ask: l.ask, bid: l.bid, mid: l.mid, expiry: l.expiry }));
    next = rollInto(next, live, tick);
    if (next !== ledgerRef.current) setLedger(next);
  }, []);

  useEffect(() => {
    void sync();
    const interval = setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => clearInterval(interval);
  }, [sync]);

  if (!ledger || !snapshot) {
    return (
      <section className="panel">
        <h2>Connecting</h2>
        <p className="lede">Reading the live markets…</p>
        {notice && <p className="error">{notice}</p>}
      </section>
    );
  }

  const valuation = valueOf(ledger, marks);
  const pnl = valuation.nav + ledger.withdrawn - ledger.deposited;
  const collateral = snapshot.venue.collateral;

  const onDeposit = () => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const tick = Math.floor(Date.now() / 1000);
    const funded = deposit(ledger, amount, marks, tick);
    setLedger(rollInto(funded, liveWindows, tick));
  };

  const onWithdraw = () => {
    const result = withdrawAll(ledger, marks, Math.floor(Date.now() / 1000));
    if (!result.ok) setNotice(result.reason);
    else {
      setLedger(result.ledger);
      setNotice(null);
    }
  };

  const withdrawBlocked =
    ledger.units <= 0 ? "nothing to withdraw" : valuation.exitValue === null ? "a window is settling — a few seconds" : null;

  return (
    <>
      <div className="chips">
        <span className="chip live">{snapshot.venue.network} · real markets, real prices, real outcomes</span>
        <span className="chip off">paper {collateral} — nothing at risk</span>
        <span className="chip">{liveWindows.length} live windows</span>
      </div>

      {/* -------------------------------------------------------- the balance */}
      <section className="panel">
        <h2>Your UP</h2>
        <div className="vault-hero">
          <div>
            <div className="vault-balance">
              {ledger.units.toFixed(2)} <span className="vault-ticker">UP</span>
            </div>
            <div className="vault-worth">
              worth <b>{valuation.nav.toFixed(2)} {collateral}</b> at {valuation.unitPrice.toFixed(4)} per unit
              {ledger.deposited > 0 && (
                <span className={pnl >= 0 ? "up" : "down"}>
                  {" "}· {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} all-time
                </span>
              )}
            </div>
          </div>
          <div className="controls">
            <label className="field">
              amount ({collateral})
              <input
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              />
            </label>
            <button className="primary" onClick={onDeposit}>
              {ledger.units > 0 ? `Deposit ${amount || 0}` : `Try it — deposit ${amount || 0} paper ${collateral}`}
            </button>
            <button onClick={onWithdraw} disabled={withdrawBlocked !== null} title={withdrawBlocked ?? undefined}>
              {valuation.exitValue !== null && ledger.units > 0
                ? `Withdraw all → ${valuation.exitValue.toFixed(2)}`
                : "Withdraw all"}
            </button>
          </div>
        </div>
        {withdrawBlocked === null && ledger.units > 0 && valuation.exitValue !== null && (
          <p className="note">
            Withdrawing now sells every position back into the books at the bid — the{" "}
            {(valuation.nav - valuation.exitValue).toFixed(2)} {collateral} gap to fair value is the real
            cost of leaving mid-window, not a fee.
          </p>
        )}
        {notice && <p className="error">{notice}</p>}
      </section>

      {/* ---------------------------------------------------- where the money is */}
      <section className="panel">
        <h2>Where your money is right now</h2>
        <p className="lede">
          One deposit, split equally across every open market — the same number of contracts of each,
          all betting the window closes <b>up</b>. When a window settles, its payout rolls straight into
          that market&rsquo;s next window.
        </p>
        {ledger.positions.length === 0 && ledger.cash < 0.01 ? (
          <p className="muted">Nothing yet — deposit above and the money appears here within a second.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>market</th>
                  <th>contracts</th>
                  <th>bought at</th>
                  <th>now</th>
                  <th>closes in</th>
                  <th>value</th>
                </tr>
              </thead>
              <tbody>
                {ledger.positions.map((position) => {
                  const mark = marks.get(position.marketId);
                  const mid = mark?.mid ?? null;
                  return (
                    <tr key={position.marketId}>
                      <td className="series">{position.series.replace("|", " ")} <span className="up">up</span></td>
                      <td className="num">{position.contracts.toFixed(2)}</td>
                      <td className="num dim">{position.entryPrice.toFixed(3)}</td>
                      <td className="num">{mid === null ? "settling…" : mid.toFixed(3)}</td>
                      <td className="num muted">{countdown(position.expiry, now)}</td>
                      <td className="num">{(position.contracts * (mid ?? position.entryPrice)).toFixed(2)}</td>
                    </tr>
                  );
                })}
                {ledger.cash >= 0.01 && (
                  <tr>
                    <td className="series dim">cash</td>
                    <td className="num dim">—</td>
                    <td className="num dim">—</td>
                    <td className="num dim">—</td>
                    <td className="num muted">waiting for the next window</td>
                    <td className="num">{ledger.cash.toFixed(2)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          The vault only rolls while a tab is open. Away, settled money simply waits as cash — nothing is
          back-filled or invented for the windows you missed.
        </p>
      </section>

      {/* -------------------------------------------------------------- activity */}
      {ledger.events.length > 0 && (
        <section className="panel">
          <h2>Activity</h2>
          <div className="scroller">
            <table>
              <tbody>
                {ledger.events.slice(0, 14).map((event, i) => (
                  <tr key={`${event.at}-${i}`}>
                    <td className="num dim" style={{ width: 80 }}>{clock(event.at)}</td>
                    <td style={{ textAlign: "left", whiteSpace: "normal" }}
                      className={event.kind === "won" ? "up" : event.kind === "lost" ? "down" : "muted"}>
                      {event.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------ the deal */}
      <section className="panel">
        <h2>What you are actually holding</h2>
        <p className="lede">
          There is no pooled fund here. Your UP units are an accounting of markets <em>you</em> hold
          directly — which is why no whale, oracle, or fund manager can dilute you, and why the value on
          this page can be recomputed by anyone from the order books. Prices are the venue&rsquo;s real
          asks and bids, and outcomes come from its real oracle; only the money is paper.
        </p>
        <p className="callout">
          <strong>Why hold many markets instead of one?</strong> A single contract pays all or nothing.
          A basket of them pays the <em>fraction</em> that close up — and because each next window is
          statistically independent of the last (measured, not assumed), rolling turns one loud coin flip
          into hundreds of quiet ones. The measurements behind that claim, including the ones that make it
          look worse, live on <a href="/desk">the numbers page</a>.
        </p>
      </section>
    </>
  );
}
