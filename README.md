# Quorum

**One token, every market. Two self-driving vaults on
[dreamDEX event contracts](https://docs.dreamdex.io/developers/event-contracts).**
Don't pick a market — pick a side: **QUP** bets every live 15-minute market on the venue closes up,
**QDWN** that they all close down.

**Live:** [quorum-somnia-coco.vercel.app](https://quorum-somnia-coco.vercel.app), on Somnia Shannon —
[QUP `0x1f089ea0…fcd6`](https://shannon-explorer.somnia.network/address/0x1f089ea05b7d0e13d9ebc23ee7233fe94027fcd6),
[QDWN `0x119e0ebf…40ab`](https://shannon-explorer.somnia.network/address/0x119e0ebff8edd84dc3e1c969e2f9a35cac1640ab),
kept alive by [the brain `0xb69a86f4…14e8`](https://shannon-explorer.somnia.network/address/0xb69a86f47cbbd0fedd0612208d355261994314e8),
holding real (testnet) deposits from real wallets.

## What it is

Each vault is a plain ERC-20 (6 decimals) wrapped around a shared pot of testnet tUSDC. Deposit and
you're minted shares; the pot buys **the same number of contracts of every live 15-minute market**,
rides the window to resolution, redeems, settles, and buys the next window — epoch after epoch, with
no server, keeper, or operator in the loop. Withdraw whenever you like.

- **Deposits are one transaction with no approval**: the Shannon test collateral's faucet is open to
  contracts too, so `depositFree()` mints the tUSDC to the vault inside your own call. (Plain
  `deposit()` after an ERC-20 approval also works, for tUSDC you already hold.)
- **Anyone can join**; the tokens are transferable and the pot is shared.
- The site is a thin window onto the contracts: live bucket tiles quoted from the pools, a share-price
  chart drawn only from `EpochSettled` events, and an FAQ that documents every rule below.

## How the pot is divided

Each epoch the vault stakes **`STAKE_BP` = ⅓ of the pot** and keeps the rest in reserve. Never all-in:
BTC and ETH agree most windows (measured ρ ≈ 0.6), so "the whole bucket lost" is a regular event, and
an all-in pot multiplies by ~0 every time it happens — the very first live vault went
1.00 → 2.44 → 4.57 → 0.10 in an hour proving it.

The staked third buys **equal contracts, not equal cash** — each market's budget is proportional to
its price. Equal cash is the seductive wrong vault: a dollar buys 7× more contracts at 0.13 than at
0.96, so an equal-cash pot is secretly a leveraged bet on whichever market happens to be cheapest.

Two guards, both on-chain in `QuorumVaultV3`:

- **Price band** — a leg asking outside **0.05–0.95** is skipped. Budget ∝ price means a near-decided
  market eats the most stake for the worst asymmetry: risking 0.97 to win 0.03 is a fee, not a
  position.
- **Protective IOC residual** — whatever the pair mint (below) didn't cover is bought
  immediate-or-cancel at ask + ~3% cushion; anything that doesn't fill at a fair price refunds to the
  reserve untouched.

## Pair minting: the vaults trade with each other

One Up contract plus one Down contract of the same market always pays exactly 1.00, so the venue's
CLOB mints a fresh pair whenever a Buy-YES and a Buy-NO cross at complementary prices — no seller
needed. QUP and QDWN want opposite sides of the same markets at the same moment: they are each
other's perfect counterparty, and paying the public book's spread twice was pure leak.

So each window, inside one brain transaction per market:

1. `QUP.pairMake` rests a bid at the spread's midpoint — strictly inside the spread so it can't cross
   on placement, expiring in 90 s so a failed cross self-cleans (there is no cancel).
2. `QDWN.pairCross` sends an IOC priced exactly at that bid; price priority guarantees it fills the
   maker first, and the pool mints the pair at fair value — **zero spread, zero cushion** on the
   overlapping size (`min` of the two pots' plans).
3. Each vault's residual entry tops up `target − already-held`, so pair fills — or a third party
   hitting the maker, which is also a fair-priced fill — shrink it automatically.

Execution cost is the one guaranteed loss in the system, paid win or lose every window; pairing
deletes it wherever the pots overlap. The brain's `pairsMinted` counter is the public receipt, and
each vault still enforces its own price and budget bounds on every order — the brain sequences, it
never prices.

## How the shared pot stays fair

The classic attack on pooled prediction vaults is mark manipulation: push a thin book's quote, mint
cheap shares, let it resolve. Quorum closes the whole class by never pricing shares off a mark.
Shares price **only at flat moments** — everything sitting as plain collateral — so the price is
`balance ÷ supply`, an on-chain fact nobody can bend. Mid-epoch deposits and withdrawals queue and
execute at the next settle (minutes, on 15-minute windows), all paid from one snapshot. The share
math carries the OZ-style virtual-liquidity offset, so first-depositor donation-inflation costs more
than it can recover.

There is no executor, no custody hop, no posted NAV: **the vault holds its own money**, places its
own orders, redeems its own winnings through the module, and settles its own epochs.

## Nobody runs it

`QuorumBrain` holds a 32 STT Somnia Reactivity bond and owns two subscriptions:

- the venue MarketCreator's `MarketCreated` events — chain-fed bucket discovery, filtered to the
  15-minute cadence in the handler, forwarded to both vaults' `noteWindow`;
- a self-re-arming quarter-hour heartbeat that fires 45 s after each boundary and runs the full pass:
  `redeemAndSettle` both vaults → pair-mint the overlap → residual entries.

Every moving part is permissionless — `runEpoch`, `rearm`, `pokeVaults` — so a dropped callback is
healable by any EOA. Public `runEpoch()` waits `PAIR_GRACE` = 120 s into a window before entering
solo, giving the brain first shot at pairing; if the brain dies, the vaults keep rolling the old way.
The web app keeps only a tiny healer that does exactly what any stranger could
(`/api/vaults` schedules one debounced pass post-response; a daily cron on `/api/keeper` with
`CRON_SECRET` is the dead-man fallback).

Verified unattended on Shannon: the first heartbeat after deploy paired both windows (identical
quantity and price on `PairMade`/`PairCrossed`, mids 0.077/0.089, QDWN's whole target filled with
zero book residual), the second settled epoch 0 on both vaults at opposite prices (0.722 / 1.028) and
re-paired epoch 1 — zero external transactions throughout.

## Why a bucket, and why it rolls

An index only reduces risk to the extent its legs disagree, and this venue's universe is *BTC or ETH,
up or down*. Measured off ~2,300 settled windows (`npx tsx bots/census.ts` reprints it live):

| | measured ρ | windows |
| --- | --- | --- |
| BTC vs ETH, same 15m window | **0.58** | 492 |
| BTC vs ETH, same 1h window | **0.64** | 487 |
| BTC vs ETH, same 24h window | **0.82** | 23 |
| BTC 15m vs its own next window | **0.07** | 499 |
| ETH 15m vs its own next window | **−0.02** | 499 |

The two halves say opposite things. **Buying more legs at once barely helps** — simultaneous windows
are worth ~3.3 independent flips, not 7. **Buying the same legs again next window helps a lot** — a
series barely remembers what it just did. That is the diversification this venue actually offers,
which is why the product is a *rolling* vault, not a basket bought once. And the honest headline: a
bucket is a claim about **variance**, never about profit — QUP and QDWN hold opposite sides of the
same windows, and their charts move opposite ways.

## Running it

```bash
npm install
npm test                   # 92 engine tests, pure functions, no chain
npx tsx bots/census.ts     # read-only: what's live, what it costs, what history says
npm run dev                # the app at localhost:3000
```

The app is read-only by default and needs nothing: with `NEXT_PUBLIC_QUP_ADDRESS`,
`NEXT_PUBLIC_QDWN_ADDRESS` and `NEXT_PUBLIC_BRAIN_ADDRESS` set it shows the live vaults; visitors
bring their own wallets. `KEEPER_PRIVATE_KEY` (an ordinary unfunded-with-anything-precious key)
enables the healer; `CRON_SECRET` gates `/api/keeper`.

To deploy your own trio:

```bash
DEPLOYER_KEY=0x… node scripts/deploy-v3.mjs
# deploys QUP + QDWN + brain, seeds both pots, funds the 33 STT bond, arms both subscriptions
```

Needs ~40 STT: three deploys (a 13KB contract genuinely costs ~50M gas on Somnia — trust the node's
estimate; a hand-pinned "sane" limit is an out-of-gas revert that still burns the whole limit) plus
the bond. `scripts/build-abis.mjs` recompiles the contracts into `src/somnia/vaultAbi.ts`.

## Layout

```
contracts/
  QuorumVaultV3.sol   the vault: ERC-20 shares, flat-moment pricing, queues, the
                      epoch machine (redeem → settle → pair → enter), band, pair legs
  QuorumBrain.sol     reactivity hub: MarketCreated feed, quarter-hour heartbeat,
                      pair-mint orchestration; holds the bond, can never touch money

src/app/              the site: vault cards, dashboard chart, FAQ, navbar
  api/vaults          state for the UI + the piggybacked keeper pass
  api/vaults/history  EpochSettled events via the explorer, one dot per settle
  api/keeper          the dead-man cron target

src/somnia/           chain access, server-only
  vaults.ts           v3 reads, brain receipt, the healer
  vaultAbi.ts         generated by scripts/build-abis.mjs
  discover/history/execute/portfolio/exchange
                      the research + bot toolchain (census, roll-sleeve)

src/engine/           pure maths, no chain, no clock — the 92-test suite
  distribution/correlation/quote/backtest/templates/units/vault

bots/census.ts        every number the docs claim, printed from live data
bots/roll-sleeve.ts   the rolling index as a standalone bot with your own key
```

## What is verified, and what isn't

**Verified live on Shannon.** The full self-driving loop across multiple epochs with zero external
transactions: chain-fed window discovery, paired entry (`pairsMinted` on the brain, matching
`PairMade`/`PairCrossed` on the vaults), IOC residuals, marketId-keyed redemption, flat-moment
settles paying the queues. One-transaction `depositFree` from a cold wallet; deposit/withdraw driven
through the real UI with a real wallet; the chart's dots reconcile against `EpochSettled` logs. Plus
everything the research pages ever verified: discovery, four-sided books, basket pricing, the
correlation matrix over ~2,300 settled windows.

**Not verified / honest limits.** Unaudited testnet Solidity throughout. The band and pairing bounds
are enforced per-order, but the brain's sequencing has only the venue's CLOB semantics as its
counterparty-safety argument — a venue-side change to matching or pair-mint rules would need a
re-read. If a market never resolves, `RESOLUTION_GRACE` (2 h) abandons it into the settle rather than
freezing the vault; the stranded tokens stay claimable by a later pass. And a bucket lowers variance
— never the direction of the bet.

## Things that bit us

Worth reading before you build on event contracts; each was a bug here first.

**Pools and market shells are recycled onto the next window within minutes of expiry.** Any address
you stored is answering for a *different market* by settle time — the first cut asked the stored
market `isResolved()` and got the next window's honest "false". Redemption must be keyed by
`marketId` through the module; try/catch on `redeem` doubles as the readiness check.

**The indexer keeps dead windows in `Trading`.** `listLiveBinaryMarkets` plus an on-chain status gate,
always.

**`listBinaryMarkets` has a `limit` but no `offset`.** Paging returns the same page again; duplicated
rows read as lag-1 correlation of 0.84 instead of the true 0.07 — an artifact that reversed the
product's central conclusion until caught. Collect by `(asset, intervalSec)` facets and dedup by id.

**`fillPrice` is always the YES price.** A Down leg's cost is the complement.

**`getBinaryOrderBook`'s `decimals` defaults to 6.** Pass it explicitly or every NO price is inverted
against the wrong scale.

**Equal cash per market is the seductive wrong vault.** See "How the pot is divided" — the first UP
vault shipped it, and 95-vs-13 contract counts in the activity feed are what caught it.

**The SDK's slippage cushion has a fixed floor that distorts sizing.** Budgeting each leg on its ask
under-buys the cheap legs by up to a third; seed on the ask, re-budget on what the first pass was
actually charged.

**Order expiry must not outlive the market.** The pool enforces `0 < expireNs ≤ market expiry`; a
"five minutes from now" order placed four minutes before the close reverts. Every vault order clamps
to `min(now + TTL, window expiry)`.

**A one-tick spread has nowhere to rest a maker.** `pairMake` requires the tick-snapped mid to sit
strictly between best bid and best ask, and reverts into the plain IOC path otherwise — resting *at*
the bid would let time priority hand the cross to a stranger and leave the maker stranded.

**Float prices are rejected on an 18-decimal venue.** No price in this repo is ever built from a
float.

---

Built with 🥥 by [coconutwaterlover](https://github.com/coconutwaterlover/quorum), on
[`@somnia-chain/markets-sdk`](https://www.npmjs.com/package/@somnia-chain/markets-sdk) and Somnia
Reactivity. Prices, books, correlations and settled outcomes are read live; the only trusted number
anywhere is `balance ÷ supply`, and the chain computes it.
