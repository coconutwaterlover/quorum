import assert from "node:assert/strict";
import { test } from "node:test";
import { complement, fromHuman, gridFor, toHuman } from "../src/engine/units";
import { TEMPLATES, intervalSeconds } from "../src/engine/templates";
import type { Leg } from "../src/engine/types";

test("both venue scales round-trip", () => {
  for (const decimals of [6, 18]) {
    const grid = gridFor(decimals);
    assert.equal(grid.one, 10n ** BigInt(decimals));
    assert.equal(toHuman(fromHuman(12.5, grid), grid), 12.5);
  }
});

test("a stake converts down, never up", () => {
  const grid = gridFor(6);
  // 0.1 is not representable in binary, so this is the case that would round up.
  assert.ok(fromHuman(0.1, grid) <= 100_000n);
  assert.equal(fromHuman(1.9999999, grid), 1_999_999n);
});

test("the complement is exact at both scales", () => {
  for (const decimals of [6, 18]) {
    const grid = gridFor(decimals);
    const up = fromHuman(0.37, grid);
    assert.equal(complement(up, grid), grid.one - up);
    assert.equal(complement(complement(up, grid), grid), up);
  }
});

test("odd cadences parse rather than falling through a switch", () => {
  assert.equal(intervalSeconds("15m"), 900);
  assert.equal(intervalSeconds("1h"), 3600);
  assert.equal(intervalSeconds("176s"), 176);
  assert.equal(intervalSeconds("24h"), 86_400);
  assert.equal(intervalSeconds("nonsense"), Number.MAX_SAFE_INTEGER);
});

function stub(asset: string, interval: string, ask: number | null, bid: number | null): Leg {
  return {
    marketId: `${asset}-${interval}`,
    series: `${asset}|${interval}`,
    asset,
    interval,
    side: "UP",
    symbol: "s",
    yesSymbol: "s",
    poolAddress: "0x",
    marketAddress: "0x",
    expiry: 1_000_000 + intervalSeconds(interval),
    tradingStart: 1_000_000,
    strike: null,
    question: "",
    venueId: "0x",
    oracleQuestionId: null,
    decimals: 6,
    bid,
    ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask),
    askSize: 200,
  };
}

const universe: Leg[] = [
  stub("BTC", "15m", 0.51, 0.49),
  stub("ETH", "15m", 0.52, 0.5),
  stub("BTC", "1h", 0.9, 0.88),
  stub("ETH", "1h", null, 0.97),
  stub("BTC", "4h", 0.7, 0.6),
];

test("every template drops legs with no ask", () => {
  for (const template of TEMPLATES) {
    for (const leg of template.pick(universe)) {
      assert.notEqual(leg.ask, null, `${template.id} offered an unbuyable leg`);
    }
  }
});

test("the cross-asset template picks the shortest cadence both assets share", () => {
  const picked = TEMPLATES.find((t) => t.id === "cross-asset")!.pick(universe);
  assert.deepEqual(picked.map((l) => l.series).sort(), ["BTC|15m", "ETH|15m"]);
});

test("the cross-cadence template stays inside one asset", () => {
  const picked = TEMPLATES.find((t) => t.id === "cross-cadence")!.pick(universe);
  assert.ok(picked.length >= 2);
  assert.equal(new Set(picked.map((l) => l.asset)).size, 1);
});

test("the coin-flip template prefers the legs nearest even money", () => {
  const picked = TEMPLATES.find((t) => t.id === "coin-flips")!.pick(universe);
  assert.deepEqual(picked.slice(0, 2).map((l) => l.series).sort(), ["BTC|15m", "ETH|15m"]);
});

test("the liquidity template orders by spread", () => {
  const picked = TEMPLATES.find((t) => t.id === "liquid")!.pick(universe);
  const spreads = picked.map((l) => l.ask! - l.bid!);
  assert.deepEqual(spreads, [...spreads].sort((a, b) => a - b));
});
