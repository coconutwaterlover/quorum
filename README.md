# Quorum

**Index contracts for [dreamDEX event contracts](https://docs.dreamdex.io/developers/event-contracts).**
Don't pick a market — pick how many of them have to be right.

A dreamDEX event contract is one Bernoulli draw. Fifteen minutes later it paid 1 or it paid 0, and
that is the entire distribution. Quorum buys a **slice of every live window at once**: one unit costs
the average of the leg prices and pays the fraction of legs that win.

There is no index token, no vault, and no oracle of its own. A unit *is* its legs, so its NAV is a sum
over prices already resting on the order book, and buying the legs is creation while selling them is
redemption. Nothing can trade away from fair value because nobody stands between the two.

```
npm install
npx tsx bots/census.ts     # read-only: what's live, what it costs, what history says
npm run dev                # the desk, at localhost:3000
```

Nothing above needs a key, an account, or a funded wallet.

---

## Does it actually work?

An index only reduces risk to the extent its legs disagree, and this venue's entire universe is *BTC
or ETH, up or down*. So the interesting question is empirical, and it has an answer. Read off the
venue's settled windows on 2026-08-20 — `npx tsx bots/census.ts` reprints all of it from live data:

| | measured ρ | windows |
| --- | --- | --- |
| BTC vs ETH, same 15m window | **0.58** | 492 |
| BTC vs ETH, same 1h window | **0.64** | 487 |
| BTC vs ETH, same 24h window | **0.82** | 23 |
| BTC 15m vs its own next window | **0.07** | 499 |
| ETH 15m vs its own next window | **−0.02** | 499 |
| BTC 4h vs its own next window | **−0.24** | 148 |

Read the two halves separately, because they say opposite things:

**Buying more legs at once barely helps.** BTC and ETH close the same way most of the time, so seven
simultaneous windows are worth about **3.3 independent coin flips**, not seven. The app reports that
number (`effective legs`) rather than the leg count, and shows the independence-assuming bar next to
the measured one so the gap is visible.

**Buying the same legs again next window helps a lot.** A series barely knows what it did last window.
That is the diversification this venue actually offers, and it is why the product is a *rolling*
sleeve rather than a basket you buy once.

Which is also the honest headline: **an index here is a claim about variance, not about profit.** It
costs one spread per leg and its expected value is the same as any of its legs. What changes is the
shape of the outcome.

---

## What one unit is

A unit is `weightᵢ` **contracts** of each leg. So:

```
cost of a unit   = Σ wᵢ · priceᵢ          ← a number anyone can recompute from the book
payoff of a unit = Σ wᵢ · 1{leg i wins}   ← the weighted fraction of legs that won
```

Because the payoff is *linear* in the legs, a portfolio of the legs is that payoff exactly. That is
the whole trick, and it is what makes the rest unnecessary — no authorized participants, no
creation/redemption basket, no NAV to publish, no premium or discount to arbitrage.

It also constrains what the venue can honestly offer. The app prices four payoff shapes off the same
mids and executes exactly one:

| payoff | fair value | replicable by holding the legs |
| --- | --- | --- |
| Average of N | `Σ wᵢpᵢ` | **yes** — this is what Quorum buys |
| Any 1 of N | `1 − Π(1−pᵢ)` | no |
| At least K of N | Poisson-binomial tail | no |
| All N (a parlay) | `Π pᵢ` | no |

The thresholds are shown because the comparison is the point: the same eight windows are a mild
diversifier or a lottery ticket depending on nothing but which function of them settles. They would
need a counterparty or a vault, so this app does not pretend to sell them.

### Sizing is where this goes wrong

Splitting a stake evenly across the legs is the obvious implementation and it silently builds a
different product. Equal *money* buys many more contracts of a leg priced at 0.13 than one priced at
0.98, so the payoff ends up dominated by whichever legs happened to be cheap — it is no longer an
average of anything. Each leg is therefore budgeted in proportion to `weightᵢ × priceᵢ`, which makes
the contract counts proportional to the weights. You can see it in the plan table: every leg buys the
same number of contracts.

---

## What is on the page

- **The board** — every live window, both sides, with real depth. There is exactly one live window per
  series; no window *t+1* exists to buy today.
- **One index unit** — fair value from mids, cost from asks, and the spread between them, because an
  index buyer crosses every leg and pretending otherwise flatters the product.
- **The payoff ladder** — a single contract has two bars. This has N+1, and the cost line shows which
  of them made money.
- **Risk, measured** — one contract, versus the basket assuming independence, versus the basket at
  measured correlation, versus the basket rolled.
- **Settled history** — the correlation matrix, per-series up-rates, and each series' correlation with
  its own next window.
- **A replay** — the basket and a single contract over the same settled windows, entered at the same
  price so their expected values match and only the dispersion differs.
- **The orders** — exactly what a buy becomes, per leg, before you send it.
- **Positions and claims** — outcome balances and a batched sweep-redeem.

---

## Running it for real

Read-only is the default and does everything except send. To trade:

```bash
cp .env.example .env.local
# QUORUM_ALLOW_TRADING=1
# QUORUM_PRIVATE_KEY=0x…
npm run dev
```

Two switches rather than one, on purpose: a key sitting in the environment is not consent to spend it.
`QUORUM_MAX_STAKE` caps what any single request may commit, which matters on a hosted demo where that
key is spending for anyone who opens the page.

Shannon testnet collateral is faucet tUSDC — `exchange.trader.faucet()` mints it.

### The bot

The web app can buy a cross-section; it cannot sit there and roll it, and rolling is where the
variance actually goes. `bots/roll-sleeve.ts` is the same index as a process you run with your own
key:

```bash
QUORUM_PRIVATE_KEY=0x… QUORUM_ALLOW_TRADING=1 \
QUORUM_SLEEVE=cross-asset QUORUM_STAKE=5 QUORUM_ROLLS=8 \
  npx tsx bots/roll-sleeve.ts
```

It discovers the live windows, quotes the basket, buys it in contract-proportional legs, sweeps
whatever settled, waits for the next window, and repeats. Without `QUORUM_ALLOW_TRADING` it prints
every order it would have sent and sends nothing.

---

## Layout

```
src/engine/        pure, no chain, no clock, no I/O — 65 unit tests
  distribution.ts  exact payoff distribution (weighted convolution) + Poisson-binomial
  correlation.ts   phi coefficients from settled outcomes, basket sd, effective legs
  quote.ts         NAV, cost, the four payoff shapes, risk projection
  backtest.ts      replay a basket against a single contract over settled windows
  templates.ts     the cross-sections worth holding, each isolating one dependence
  units.ts         collateral scale conversions (and why prices are never built here)

src/somnia/        everything that touches the chain, server-only
  exchange.ts      read-only and signing exchanges; the two trading switches
  discover.ts      live legs — indexer filter, on-chain status gate, expiry headroom
  history.ts       settled outcomes, paged by facet because there is no offset
  execute.ts       basket buy: contract-proportional legs, IOC, per-leg reporting
  portfolio.ts     outcome balances and batched sweep-redeem
  desk.ts          the composed snapshot every route reads

bots/census.ts     every number the app is built on, printed from a terminal
bots/roll-sleeve.ts the rolling index as a bot
```

`npm test` runs the engine suite. It is all pure functions, so the maths is testable without a chain:
the distribution's mean must equal `Σ wᵢpᵢ`, eight independent even legs must land at exactly
`0.5/√8`, perfectly correlated legs must diversify nothing, and an unmeasurable correlation must not
quietly become independence.

---

## Things that bit us

Worth reading before you build on event contracts, because each of these was a bug here first.

**The indexer keeps dead windows in `Trading`.** A flat `listBinaryMarkets({ status: "Trading" })`
returned 500 rows of which 8 were live; the rest had expired up to 25 days earlier. `listLiveBinaryMarkets`
filters `expiry > now` server-side. The on-chain status gate is still needed on top, because status is
time-derived and the index lags by seconds.

**`listBinaryMarkets` has a `limit` but no `offset`.** Paging with an offset returns *the same page*
again. Six "pages" of history were six copies of one page, and after sorting by expiry each window sat
next to its own duplicate — which reads as lag-1 correlation of **0.84** instead of the true **0.07**.
That single artifact reversed the product's central conclusion. History is now collected by narrowing
on `(asset, intervalSec)` facets, and rows are deduplicated by market id regardless.

**`fillPrice` is always the YES price.** On a Down leg the cost per contract is its complement.
Reading it as the traded side's own price under-reports spend on every Down fill.

**`getBinaryOrderBook`'s `decimals` option defaults to 6.** It is what the NO side is inverted
against, so leaving it out silently corrupts every NO price on an 18-decimal venue.

**Escrow is not a price forecast.** `quoteBinaryStakeOverBook` returns `escrow = quantity × the
protective limit` — a max loss. The expected fill comes from `quoteBinaryOrderOverBook`, which walks
the same book. Reporting the first as an average price makes every basket look 3% more expensive than
it is.

**A uniform correlation is not a correlation.** Projecting a dozen rolls with a uniform ρ is only
valid down to `−1/(n−1)`; a mildly negative measured ρ pushed the implied variance through zero and
the app reported a **risk-free index**. The projection is a lag-1 band now — the only sequential
dependence the data supports — because measured lag-2 and lag-4 are indistinguishable from zero.

**A thin sample will happily set your headline.** A 23-window reading of ρ = −0.57 is noise, and
averaged naively it dominated six other series and inflated "effective legs" by 50%. Estimates are
shrunk toward zero by `n/(n+30)` and pooled with `n` as the weight.

**Float prices are rejected on an 18-decimal venue.** `parseUnits((0.05).toFixed(18), 18)` lands three
wei off the tick grid and the pool answers `InvalidPrice`. Of the ordinary probabilities only 0.25,
0.5 and 0.75 survive the conversion. A 6-decimal venue never shows it, so testnet looks clean while
every mainnet order fails — which is why no price in this repo is ever built from a float.

---

Built with [`@somnia-chain/markets-sdk`](https://www.npmjs.com/package/@somnia-chain/markets-sdk) on
Somnia. Prices, books, correlations and settled outcomes are read live; the only modelled number
anywhere is the replay entry price, and it is a labelled slider.
