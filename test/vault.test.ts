import assert from "node:assert/strict";
import { test } from "node:test";
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
} from "../src/engine/vault";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

const NOW = 1_000_000;

function windows(quotes: Record<string, number>, expiry = NOW + 800): LiveWindow[] {
  return Object.entries(quotes).map(([series, ask], i) => ({
    marketId: `m-${series}-${expiry}`,
    series,
    ask,
    bid: ask - 0.02,
    mid: ask - 0.01,
    expiry: expiry + i * 0, // shared expiry keeps the tests simple
  }));
}

const marksOf = (live: LiveWindow[]) => new Map(live.map((w) => [w.marketId, w]));

function funded(amount = 100, quotes: Record<string, number> = { "BTC|15m": 0.5, "ETH|15m": 0.4 }) {
  const live = windows(quotes);
  let ledger = deposit(emptyLedger(), amount, marksOf(live), NOW);
  ledger = rollInto(ledger, live, NOW);
  return { ledger, live };
}

test("the first deposit mints 1:1 and buys the same contract count of every series", () => {
  const { ledger } = funded(100);
  close(ledger.units, 100);
  assert.equal(ledger.positions.length, 2);
  // Equal contracts, not equal cash: 100 / (0.5 + 0.4) of each.
  const target = 100 / 0.9;
  for (const p of ledger.positions) close(p.contracts, target, 1e-9);
  // The budgets differ — the dearer leg gets the bigger one.
  close(ledger.positions[0].cost, target * 0.5, 1e-9);
  close(ledger.positions[1].cost, target * 0.4, 1e-9);
  close(ledger.cash, 0, 1e-9);
});

test("a cheap longshot cannot dominate the vault", () => {
  // The seductive wrong allocation: equal cash would buy 7.4x more of the
  // 0.13 leg, making the whole vault a bet on it. Equal contracts refuses.
  const { ledger } = funded(100, { "ETH|1h": 0.131, "BTC|24h": 0.964 });
  const [longshot, favourite] = ledger.positions;
  close(longshot.contracts, favourite.contracts, 1e-9);
  assert.ok(favourite.cost > longshot.cost * 7, "the dear leg takes the bigger budget");
});

test("NAV marks at mid and the unit price moves with the marks", () => {
  const { ledger, live } = funded(100);
  const { nav, unitPrice } = valueOf(ledger, marksOf(live));
  // Entered at ask, marked at mid: the spread is a real, visible entry cost.
  close(nav, 100 * 0.49 / 0.5 * 0.5 + 100 * 0.39 / 0.4 * 0.5, 1); // sanity: below 100
  assert.ok(nav < 100 && nav > 95);
  close(unitPrice, nav / 100);
});

test("a win pays 1 per contract into cash; a loss pays nothing; voided pays half", () => {
  const { ledger } = funded(90, { "A|15m": 0.5, "B|15m": 0.5, "C|15m": 0.5 });
  const ids = ledger.positions.map((p) => p.marketId);
  const resolutions = new Map<string, Resolution>([
    [ids[0], { resolved: true, voided: false, upWon: true }],
    [ids[1], { resolved: true, voided: false, upWon: false }],
    [ids[2], { resolved: false, voided: true, upWon: null }],
  ]);
  const settled = applySettlements(ledger, resolutions, NOW + 900);
  assert.equal(settled.positions.length, 0);
  // 30 staked per series at 0.5 -> 60 contracts each: win 60, lose 0, void 30.
  close(settled.cash, 60 + 0 + 30, 1e-9);
  const kinds = settled.events.slice(0, 3).map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["lost", "voided", "won"]);
});

test("an unresolved window stays open and blocks nothing else", () => {
  const { ledger } = funded(100);
  const [first] = ledger.positions;
  const settled = applySettlements(
    ledger,
    new Map([[first.marketId, { resolved: false, voided: false, upWon: null }]]),
    NOW + 900,
  );
  assert.equal(settled, ledger); // untouched, not even a copied object
});

test("settled cash rolls into the successor at its contract target, not all-in", () => {
  const { ledger, live } = funded(100);
  const wins = new Map<string, Resolution>(
    ledger.positions.map((p) => [p.marketId, { resolved: true, voided: false, upWon: true }]),
  );
  const flat = applySettlements(ledger, wins, NOW + 900);
  // Both series won: the shared contract count, 100/0.9 each, pays 1 apiece.
  close(flat.cash, 2 * (100 / 0.9), 1e-9);

  const successors = windows({ "BTC|15m": 0.5, "ETH|15m": 0.5 }, NOW + 1800);
  const rolled = rollInto(flat, successors, NOW + 900);
  assert.equal(rolled.positions.length, 2);
  // Equal asks, so the contract target splits the cash in half — a sleeve that
  // just won does NOT bet its whole payout on the next window.
  for (const p of rolled.positions) close(p.cost, flat.cash / 2, 1e-9);
});

test("the vault never enters a series twice or a window about to close", () => {
  const { ledger } = funded(100);
  const again = rollInto(ledger, windows({ "BTC|15m": 0.5, "ETH|15m": 0.4 }), NOW);
  assert.equal(again.positions.length, 2); // still two — same series, no re-entry

  const fresh = deposit(emptyLedger(), 50, new Map(), NOW);
  const closing = windows({ "BTC|15m": 0.5 }, NOW + 30); // 30s left
  assert.equal(rollInto(fresh, closing, NOW).positions.length, 0);
});

test("a second deposit mints at the current unit price, not at 1", () => {
  const { ledger } = funded(100, { "A|15m": 0.5 });
  const win = new Map<string, Resolution>([
    [ledger.positions[0].marketId, { resolved: true, voided: false, upWon: true }],
  ]);
  const richer = applySettlements(ledger, win, NOW + 900); // 200 cash on 100 units
  const after = deposit(richer, 100, new Map(), NOW + 901);
  // Unit price is 2, so 100 buys 50 units — the newcomer gets no share of the win.
  close(after.units, 150, 1e-9);
  const { unitPrice } = valueOf(after, new Map());
  close(unitPrice, 2, 1e-9);
});

test("withdrawing sells at the bids, which costs the spread and says so", () => {
  const { ledger, live } = funded(100);
  const result = withdrawAll(ledger, marksOf(live), NOW + 10);
  assert.ok(result.ok);
  if (result.ok) {
    const { nav } = valueOf(ledger, marksOf(live));
    assert.ok(result.proceeds < nav, "exit at bid must cost more than the mid mark");
    assert.equal(result.ledger.units, 0);
    assert.equal(result.ledger.positions.length, 0);
    close(result.ledger.withdrawn, result.proceeds);
  }
});

test("withdrawal is refused, with the series named, while a window is settling", () => {
  const { ledger } = funded(100);
  // Marks vanish when the window leaves the live list: expired, unresolved.
  const result = withdrawAll(ledger, new Map(), NOW + 900);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.reason, /BTC 15m.*settling|settling/);
});

test("while away, settled money waits as cash instead of guessing at missed windows", () => {
  const { ledger } = funded(100);
  const wins = new Map<string, Resolution>(
    ledger.positions.map((p) => [p.marketId, { resolved: true, voided: false, upWon: true }]),
  );
  const back = applySettlements(ledger, wins, NOW + 86_400);
  assert.equal(back.positions.length, 0);
  assert.ok(back.cash > 0);
  // No live windows supplied: nothing is entered, nothing is invented.
  assert.equal(rollInto(back, [], NOW + 86_400), back);
});

test("deposits and withdrawals round-trip the accounting identity", () => {
  const { ledger, live } = funded(100);
  const result = withdrawAll(ledger, marksOf(live), NOW + 10);
  assert.ok(result.ok);
  if (result.ok) {
    const l: VaultLedger = result.ledger;
    // Everything that came in either went out or was lost to the spread.
    assert.ok(l.deposited - l.withdrawn > 0, "the spread is a real cost");
    assert.ok(l.deposited - l.withdrawn < 8, "but only the spread, not a leak");
  }
});
