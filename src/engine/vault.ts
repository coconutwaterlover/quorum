/**
 * The UP vault: one balance that holds a slice of every live market and rolls
 * itself forward as windows settle.
 *
 * The framing is a vault — deposit, get units, watch a number — but the
 * mechanics are deliberately *not* a pooled vault. Each depositor's ledger owns
 * its own legs directly, which removes the classic attack on pooled prediction
 * vaults outright: with no shared NAV there is nothing to manipulate with a
 * resting order just before a deposit, and no other holder to dilute. The vault
 * look-and-feel is an accounting layer over the same direct basket the rest of
 * this repo trades.
 *
 * Money policy, chosen to be boring:
 *   - the vault holds the same NUMBER OF CONTRACTS of every live series, which
 *     means budgeting each entry by its price — nav x ask_i / sum(asks) — and
 *     never splitting the deposit into equal cash parts. Equal cash is the
 *     seductive wrong answer: a dollar buys 7x more contracts at 0.13 than at
 *     0.96, so an equal-cash vault is a leveraged bet on whichever market is
 *     cheapest, not an average of anything. Equal contracts is what makes the
 *     payoff the fraction of markets that close up;
 *   - a settled window pays into cash, and cash re-enters that series' next
 *     window at the same contract target. Never all-in: compounding a sleeve's
 *     whole payout into its next window is a fast martingale to zero;
 *   - deposits mint units at the current NAV per unit; withdrawals sell every
 *     live position at its bid and pay cash. The bid/mid gap is the real cost
 *     of leaving early and is shown, not smoothed.
 *
 * Everything here is pure: chain facts (quotes, resolutions, the clock) come in
 * as arguments, so the whole lifecycle is unit-testable without a network and
 * the module is safe to run in the browser.
 */

export interface VaultPosition {
  readonly marketId: string;
  readonly series: string;
  /** The vault only ever buys Up — it is the everything-up token. */
  readonly side: "UP";
  readonly contracts: number;
  readonly entryPrice: number;
  /** Collateral spent to open, i.e. contracts x entryPrice. */
  readonly cost: number;
  readonly expiry: number;
  readonly openedAt: number;
}

export interface VaultEvent {
  readonly at: number;
  readonly kind: "deposit" | "withdraw" | "entered" | "won" | "lost" | "voided";
  readonly text: string;
  /** Signed collateral movement from the holder's point of view. */
  readonly amount: number;
}

export interface VaultLedger {
  readonly version: 1;
  /** UP units held. Minted at deposit against the NAV per unit of the moment. */
  readonly units: number;
  /** Idle collateral: deposits not yet deployed, and settled payouts awaiting a roll. */
  readonly cash: number;
  readonly positions: readonly VaultPosition[];
  readonly deposited: number;
  readonly withdrawn: number;
  readonly events: readonly VaultEvent[];
}

/** What the chain says about one market a position sits in. */
export interface Resolution {
  readonly resolved: boolean;
  readonly voided: boolean;
  /** Whether Up won. Only meaningful when `resolved`. */
  readonly upWon: boolean | null;
}

/** A live window's Up-side quotes, as the vault needs them. */
export interface LiveWindow {
  readonly marketId: string;
  readonly series: string;
  readonly ask: number | null;
  readonly bid: number | null;
  readonly mid: number | null;
  readonly expiry: number;
}

const EVENT_CAP = 48;
const MIN_STAKE = 0.01;
/** Don't enter a window about to close: the entry would be all spread, no time. */
const MIN_ENTRY_HEADROOM_SECONDS = 90;

export function emptyLedger(): VaultLedger {
  return { version: 1, units: 0, cash: 0, positions: [], deposited: 0, withdrawn: 0, events: [] };
}

export interface Valuation {
  /** Cash plus positions at mid — what the holding is worth. */
  readonly nav: number;
  readonly unitPrice: number;
  /** Cash plus positions at bid — what leaving right now would fetch. Null while a window is settling. */
  readonly exitValue: number | null;
  /** Series currently waiting on the oracle: expired, not yet resolved. */
  readonly settling: readonly string[];
}

export function valueOf(ledger: VaultLedger, marks: ReadonlyMap<string, LiveWindow>): Valuation {
  let nav = ledger.cash;
  let exit = ledger.cash;
  let exitKnown = true;
  const settling: string[] = [];

  for (const position of ledger.positions) {
    const mark = marks.get(position.marketId);
    if (!mark) {
      // The window closed and left the live list; until the oracle answers,
      // the honest mark is what was paid — and it cannot be sold at all.
      nav += position.cost;
      exitKnown = false;
      settling.push(position.series);
      continue;
    }
    nav += position.contracts * (mark.mid ?? position.entryPrice);
    if (mark.bid === null) exitKnown = false;
    else exit += position.contracts * mark.bid;
  }

  return {
    nav,
    unitPrice: ledger.units > 0 ? nav / ledger.units : 1,
    exitValue: exitKnown ? exit : null,
    settling,
  };
}

export function deposit(
  ledger: VaultLedger,
  amount: number,
  marks: ReadonlyMap<string, LiveWindow>,
  now: number,
): VaultLedger {
  if (!Number.isFinite(amount) || amount <= 0) return ledger;
  // Units price off the NAV *before* the new cash arrives, so a later deposit
  // buys in at the current unit price rather than diluting or subsidizing the
  // existing balance.
  const { unitPrice } = valueOf(ledger, marks);
  const minted = amount / unitPrice;
  return {
    ...ledger,
    units: ledger.units + minted,
    cash: ledger.cash + amount,
    deposited: ledger.deposited + amount,
    events: push(ledger.events, {
      at: now,
      kind: "deposit",
      text: `deposited ${amount.toFixed(2)} → minted ${minted.toFixed(2)} UP at ${unitPrice.toFixed(4)}`,
      amount,
    }),
  };
}

/** Apply on-chain resolutions: settled windows become cash, win or lose. */
export function applySettlements(
  ledger: VaultLedger,
  resolutions: ReadonlyMap<string, Resolution>,
  now: number,
): VaultLedger {
  let cash = ledger.cash;
  const open: VaultPosition[] = [];
  const events: VaultEvent[] = [];

  for (const position of ledger.positions) {
    const result = resolutions.get(position.marketId);
    if (!result || (!result.resolved && !result.voided)) {
      open.push(position);
      continue;
    }
    const rate = result.voided ? 0.5 : result.upWon ? 1 : 0;
    const payout = position.contracts * rate;
    cash += payout;
    events.push({
      at: now,
      kind: result.voided ? "voided" : rate > 0 ? "won" : "lost",
      text: result.voided
        ? `${label(position.series)} voided — both sides pay half: +${payout.toFixed(2)}`
        : rate > 0
          ? `${label(position.series)} closed up ✓ — ${position.contracts.toFixed(2)} contracts pay ${payout.toFixed(2)}`
          : `${label(position.series)} closed down ✗ — entry of ${position.cost.toFixed(2)} pays 0`,
      amount: payout - position.cost,
    });
  }

  if (events.length === 0) return ledger;
  return { ...ledger, cash, positions: open, events: push(ledger.events, ...events) };
}

/**
 * Stake idle cash into live windows the vault is not already in, 1/N of NAV
 * each. Paper fills at the real ask; the ask is a quote somebody is actually
 * resting, which is what makes the paper honest.
 */
export function rollInto(
  ledger: VaultLedger,
  live: readonly LiveWindow[],
  now: number,
): VaultLedger {
  if (ledger.units <= 0 || ledger.cash < MIN_STAKE) return ledger;

  const marks = new Map(live.map((w) => [w.marketId, w]));
  const alreadyIn = new Set(ledger.positions.map((p) => p.series));
  const quoted = live.filter((w) => w.ask !== null && w.ask > 0);
  if (quoted.length === 0) return ledger;

  // The contract target: spread NAV over the live cross-section so every
  // series ends up holding the same count. nav / sum(asks) is that count, and
  // each series' budget is then its own price times the shared count.
  const askSum = quoted.reduce((sum, w) => sum + w.ask!, 0);
  const contractTarget = valueOf(ledger, marks).nav / askSum;

  let cash = ledger.cash;
  const positions = [...ledger.positions];
  const events: VaultEvent[] = [];

  for (const window of quoted) {
    const ask = window.ask!; // `quoted` filtered nulls; TS cannot see through it
    if (alreadyIn.has(window.series)) continue;
    if (window.expiry - now < MIN_ENTRY_HEADROOM_SECONDS) continue;
    const stake = Math.min(cash, contractTarget * ask);
    if (stake < MIN_STAKE) continue;

    const contracts = stake / ask;
    positions.push({
      marketId: window.marketId,
      series: window.series,
      side: "UP",
      contracts,
      entryPrice: ask,
      cost: stake,
      expiry: window.expiry,
      openedAt: now,
    });
    cash -= stake;
    alreadyIn.add(window.series);
    events.push({
      at: now,
      kind: "entered",
      text: `rolled ${stake.toFixed(2)} into ${label(window.series)} at ${ask.toFixed(3)} — ${contracts.toFixed(2)} contracts`,
      amount: -stake,
    });
  }

  if (events.length === 0) return ledger;
  return { ...ledger, cash, positions, events: push(ledger.events, ...events) };
}

export type WithdrawResult =
  | { readonly ok: true; readonly ledger: VaultLedger; readonly proceeds: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Sell everything at the bids and pay out. Refused while a window is settling:
 * an expired, unresolved position cannot be sold and cannot yet be paid, and
 * guessing its value would reintroduce exactly the mark-manipulation surface
 * this design exists to avoid. Settlement is oracle-automatic and takes
 * seconds, so "try again in a moment" is the honest answer.
 */
export function withdrawAll(
  ledger: VaultLedger,
  marks: ReadonlyMap<string, LiveWindow>,
  now: number,
): WithdrawResult {
  if (ledger.units <= 0) return { ok: false, reason: "nothing to withdraw" };
  const { exitValue, settling } = valueOf(ledger, marks);
  if (exitValue === null) {
    return {
      ok: false,
      reason: `${settling.map(label).join(", ")} is settling — the oracle answers within moments, try again`,
    };
  }
  return {
    ok: true,
    proceeds: exitValue,
    ledger: {
      ...ledger,
      units: 0,
      cash: 0,
      positions: [],
      withdrawn: ledger.withdrawn + exitValue,
      events: push(ledger.events, {
        at: now,
        kind: "withdraw",
        text: `withdrew everything — sold at the bids for ${exitValue.toFixed(2)}`,
        amount: exitValue,
      }),
    },
  };
}

function push(events: readonly VaultEvent[], ...next: VaultEvent[]): VaultEvent[] {
  return [...next.reverse(), ...events].slice(0, EVENT_CAP);
}

function label(series: string): string {
  return series.replace("|", " ");
}
