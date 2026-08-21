"use client";

/**
 * The whole app: two self-driving vaults, one screen.
 *
 * Layout doctrine, after a few rounds of user feedback: the buckets and the
 * numbers carry the story, prose does not. Everything explanatory lives behind
 * the FAQ in the navbar; the page itself holds one sentence per card. One
 * deposit button (the no-approval faucet path — the "use my own tUSDC" path
 * still exists on the contract and in the FAQ, but a second button was noise),
 * one withdraw button, both phase-aware.
 */

import { useEffect, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { quorumVaultV3Abi as vaultAbi } from "@/somnia/vaultAbi";
import { shannon } from "@/app/providers";

const TEST_USDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address;

const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "a" }], outputs: [{ type: "uint256" }] },
  { name: "faucet", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "amount" }], outputs: [] },
] as const;

interface HistoryPoint {
  epoch: number;
  price: number;
  supply: number;
  at: number | null;
}
interface HistoryApi {
  up: HistoryPoint[];
  down: HistoryPoint[];
}
interface VaultsApi {
  up: VaultStateApi | { error: string } | null;
  down: VaultStateApi | { error: string } | null;
}
interface BucketMarket {
  marketId: string;
  series: string;
  asset: string;
  interval: string;
  price: number | null;
  expiry: number;
  question: string;
  held: number | null;
}
interface BrainApi {
  address: Address;
  fireCount: number;
  windowsFed: number;
  bondStt: number;
}
interface VaultStateApi {
  symbol: "QUP" | "QDWN";
  side: "UP" | "DOWN";
  address: Address;
  phase: "OPEN" | "DEPLOYED";
  epoch: number;
  cash: number;
  totalSupply: number;
  openPrice: number;
  lastSettlePrice: number | null;
  pendingDeposits: number;
  pendingWithdraws: number;
  bucket: BucketMarket[];
  brain: BrainApi | null;
}

const num = (v: number | null | undefined, d = 4) => (v === null || v === undefined ? "—" : v.toFixed(d));

export default function RealVaults() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [vaults, setVaults] = useState<VaultsApi | null>(null);
  const [history, setHistory] = useState<HistoryApi | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  const [showFaq, setShowFaq] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!localStorage.getItem("quorum-intro-seen")) setShowIntro(true);
  }, []);

  useEffect(() => {
    let live = true;
    const pull = async () => {
      try {
        const response = await fetch("/api/vaults/history", { cache: "no-store" });
        const body = await response.json();
        if (live && response.ok) setHistory(body as HistoryApi);
      } catch {
        /* the chart is a nice-to-have; the page works without it */
      }
    };
    void pull();
    const interval = setInterval(() => void pull(), 60_000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let live = true;
    const pull = async () => {
      try {
        const response = await fetch("/api/vaults", { cache: "no-store" });
        const body = await response.json();
        if (!live) return;
        if (!response.ok) setApiError(body.error ?? "vaults unavailable");
        else {
          setVaults(body as VaultsApi);
          setApiError(null);
        }
      } catch {
        if (live) setApiError("vaults unavailable");
      }
    };
    void pull();
    const interval = setInterval(() => void pull(), 12_000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, []);

  const wrongChain = isConnected && chainId !== shannon.id;
  const up = vaults?.up && !("error" in vaults.up) ? vaults.up : null;
  const down = vaults?.down && !("error" in vaults.down) ? vaults.down : null;
  const wallet = wrongChain ? undefined : address;
  const brain = up?.brain ?? down?.brain ?? null;

  const dismissIntro = () => {
    localStorage.setItem("quorum-intro-seen", "1");
    setShowIntro(false);
  };

  return (
    <>
      {showIntro && <IntroModal onClose={dismissIntro} />}
      {showFaq && <FaqModal brain={brain} onClose={() => setShowFaq(false)} />}

      <nav className="navbar">
        <span className="navbar-brand">Quorum</span>
        <span className="navbar-right">
          <span className="chip live">Somnia Shannon</span>
          <button className="tiny" onClick={() => setShowFaq(true)}>FAQ</button>
          <FaucetButton wallet={wallet} />
          {isConnected && address ? (
            wrongChain ? (
              <button className="tiny on" onClick={() => switchChain({ chainId: shannon.id })}>
                switch to Shannon
              </button>
            ) : (
              <button className="tiny" title="click to disconnect" onClick={() => disconnect()}>
                {address.slice(0, 6)}…{address.slice(-4)} ✕
              </button>
            )
          ) : (
            <button className="tiny on" disabled={connecting}
              onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
              {connecting ? "connecting…" : "connect wallet"}
            </button>
          )}
        </span>
      </nav>

      <header className="masthead">
        <h1>Pick a side. Hold every market at once.</h1>
        <p>
          <strong>QUP</strong> bets every live 15-minute market closes up, <strong>QDWN</strong> that
          they all close down — one deposit, one token, a shared pot that trades itself.
        </p>
      </header>

      {apiError && <p className="error">{apiError}</p>}

      <div className="grid-2">
        {up && <VaultCard state={up} wallet={wallet} now={now} />}
        {down && <VaultCard state={down} wallet={wallet} now={now} />}
      </div>

      {(up || down) && <Dashboard up={up} down={down} history={history} wallet={wallet} />}
    </>
  );
}

/** Mint free test collateral, straight from the navbar. */
function FaucetButton({ wallet }: { wallet?: Address }) {
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });
  const balance = useReadContract({
    address: TEST_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet, refetchInterval: 15_000 },
  });
  const busy = isPending || receipt.isLoading;
  return (
    <button className="tiny" disabled={!wallet || busy}
      title={
        wallet
          ? `free testnet collateral · you hold ${balance.data !== undefined ? Number(formatUnits(balance.data, 6)).toFixed(0) : "—"} tUSDC · gas (STT) from testnet.somnia.network`
          : "connect a wallet first"
      }
      onClick={() => writeContract({ address: TEST_USDC, abi: erc20Abi, functionName: "faucet", args: [1_000_000_000n] })}>
      {busy ? "minting…" : "🚰 get tUSDC"}
    </button>
  );
}

function VaultCard({ state, wallet, now }: { state: VaultStateApi; wallet?: Address; now: number }) {
  const [amount, setAmount] = useState(25);
  const [note, setNote] = useState<string | null>(null);
  const isUp = state.side === "UP";

  const shares = useReadContract({
    address: state.address,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet, refetchInterval: 12_000 },
  });
  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (receipt.isSuccess) {
      setNote("confirmed ✓");
      void shares.refetch();
    }
  }, [receipt.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = state.phase === "OPEN" ? state.openPrice : state.lastSettlePrice ?? 1;
  const myShares = shares.data !== undefined ? Number(formatUnits(shares.data, 6)) : null;
  const busy = isPending || receipt.isLoading;
  const queued = state.phase === "DEPLOYED";

  const act = (fn: () => void, label: string) => {
    setNote(label);
    reset();
    fn();
  };

  return (
    <section className="panel">
      <h2>{state.symbol} — everything {isUp ? "up" : "down"}</h2>
      <p className="lede">
        Not one bet — a <strong>bucket</strong>. One {state.symbol} is the same-size position in{" "}
        <em>every</em> market below at once, re-bought every window.
      </p>

      <Bucket state={state} now={now} />

      <div className="stats" style={{ marginTop: 14 }}>
        <div className="stat hero">
          <div className="k">share price</div>
          <div className="v">{num(price)}</div>
          <div className="n">{state.phase === "OPEN" ? "live" : `last settle · epoch ${state.epoch}`}</div>
        </div>
        <div className="stat">
          <div className="k">pot</div>
          <div className="v">{state.phase === "OPEN" ? state.cash.toFixed(2) : "in the markets"}</div>
          <div className="n">{state.totalSupply.toFixed(2)} {state.symbol} outstanding</div>
        </div>
        <div className="stat">
          <div className="k">queue</div>
          <div className="v" style={{ fontSize: 15, paddingTop: 5 }}>
            {state.pendingDeposits + state.pendingWithdraws || "empty"}
          </div>
          <div className="n">{queued ? "actions settle in minutes" : "actions are instant now"}</div>
        </div>
      </div>

      {wallet ? (
        <div className="controls" style={{ marginTop: 16 }}>
          <label className="field">
            amount (tUSDC)
            <input type="number" min={1} step={1} value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} />
          </label>
          <button className="primary" disabled={busy || amount <= 0}
            title="one transaction, no approval — see the FAQ for how"
            onClick={() =>
              act(
                () =>
                  writeContract({
                    address: state.address, abi: vaultAbi,
                    functionName: "depositFree", args: [parseUnits(String(amount || 0), 6)],
                  }),
                "depositing…",
              )
            }>
            Deposit {amount}
          </button>
          <button disabled={busy || !myShares}
            onClick={() =>
              act(
                () =>
                  writeContract({
                    address: state.address, abi: vaultAbi,
                    functionName: "exit", args: [shares.data!],
                  }),
                "withdrawing…",
              )
            }>
            Withdraw all
          </button>
          {queued && <span className="dim" style={{ fontSize: 12 }}>settles at next window</span>}
        </div>
      ) : (
        <p className="note" style={{ marginTop: 16 }}>Connect a wallet (top right) to deposit.</p>
      )}

      {wallet && (
        <p className="note">
          You hold <b>{myShares === null ? "—" : myShares.toFixed(2)} {state.symbol}</b>
          {myShares !== null && myShares > 0 && <> ≈ {(myShares * price).toFixed(2)} tUSDC</>}
          {amount > 0 && state.bucket.some((m) => m.price) && (
            <> · {amount} tUSDC ≈ {(amount / state.bucket.reduce((s, m) => s + (m.price ?? 0), 0)).toFixed(1)} contracts of each market</>
          )}
        </p>
      )}
      {note && !writeError && !receipt.isError && (
        <p className="note">{note} {receipt.isLoading && "(waiting for the chain)"}</p>
      )}
      {receipt.isError && <p className="error">the transaction reverted on-chain — nothing moved</p>}
      {writeError && <p className="error">{writeError.message.split("\n")[0]}</p>}
    </section>
  );
}

/** The bucket: every market this pot is spread across, live. */
function Bucket({ state, now }: { state: VaultStateApi; now: number }) {
  const isUp = state.side === "UP";
  if (state.bucket.length === 0) {
    return <p className="dim">Between windows — the next markets list here the moment they open.</p>;
  }
  return (
    <div className="bucket">
      {state.bucket.map((market) => {
        const seconds = market.expiry - now;
        return (
          <div className="bucket-tile" key={market.marketId}>
            <div className="bucket-market">
              {market.asset} {market.interval}
              <span className={isUp ? "up" : "down"}> {isUp ? "▲ up" : "▼ down"}</span>
            </div>
            <div className="bucket-price">
              {market.price === null ? "—" : market.price.toFixed(3)}
              <span className="bucket-unit"> /contract</span>
            </div>
            <div className="bucket-meta">
              {market.held !== null ? `holding ${market.held.toFixed(1)}` : "in the next buy"}
            </div>
            <div className="bucket-meta dim">
              {seconds > 0
                ? `closes in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
                : "settling…"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Dashboard({
  up,
  down,
  history,
  wallet,
}: {
  up: VaultStateApi | null;
  down: VaultStateApi | null;
  history: HistoryApi | null;
  wallet?: Address;
}) {
  const upShares = useReadContract({
    address: up?.address,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet && !!up, refetchInterval: 15_000 },
  });
  const downShares = useReadContract({
    address: down?.address,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet && !!down, refetchInterval: 15_000 },
  });

  const holdings = [
    { state: up, shares: upShares.data },
    { state: down, shares: downShares.data },
  ]
    .filter((h): h is { state: VaultStateApi; shares: bigint | undefined } => h.state !== null)
    .map(({ state, shares }) => {
      const count = shares !== undefined ? Number(formatUnits(shares, 6)) : null;
      const price = state.phase === "OPEN" ? state.openPrice : state.lastSettlePrice ?? 1;
      return { state, count, price, value: count !== null ? count * price : null };
    });
  const totalValue = holdings.reduce((sum, h) => sum + (h.value ?? 0), 0);

  return (
    <section className="panel">
      <h2>Your dashboard</h2>
      {wallet ? (
        <div className="stats">
          <div className="stat hero">
            <div className="k">total value</div>
            <div className="v">{totalValue.toFixed(2)}</div>
            <div className="n">tUSDC, at the latest prices</div>
          </div>
          {holdings.map(({ state, count, price, value }) => (
            <div className="stat" key={state.symbol}>
              <div className="k">{state.symbol}</div>
              <div className="v">{count === null ? "—" : count.toFixed(2)}</div>
              <div className="n">{value === null ? "—" : `≈ ${value.toFixed(2)} tUSDC at ${price.toFixed(4)}`}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="lede">Connect a wallet and your holdings appear here.</p>
      )}

      <h2 style={{ marginTop: 22 }}>Share price, every settle since launch</h2>
      <PriceChart history={history} />
      <p className="note">
        One dot per settle: the vault flat, price = balance ÷ supply, on-chain. Log scale.
      </p>
    </section>
  );
}

function PriceChart({ history }: { history: HistoryApi | null }) {
  // X is wall-clock time (epoch counts differ between the vaults); Y is log —
  // multiplicative returns on a linear axis flatten everything below 1.00.
  const raw = [...(history?.up ?? []), ...(history?.down ?? [])];
  const timed = raw.filter((p) => p.at !== null);
  if (timed.length === 0) {
    return <p className="dim">No settles yet — the first epoch is still out working.</p>;
  }
  const t0 = Math.min(...timed.map((p) => p.at!)) - 600;
  const t1 = Math.max(...timed.map((p) => p.at!));
  const anchor: HistoryPoint = { epoch: 0, price: 1, supply: 0, at: t0 };
  const up = history?.up.length ? [anchor, ...history.up.filter((p) => p.at !== null)] : [];
  const down = history?.down.length ? [anchor, ...history.down.filter((p) => p.at !== null)] : [];

  const width = 720;
  const height = 210;
  const pad = { left: 46, right: 12, top: 12, bottom: 24 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const logs = [...up, ...down].map((p) => Math.log(Math.max(1e-4, p.price)));
  const loLog = Math.min(...logs) - 0.15;
  const hiLog = Math.max(...logs) + 0.15;
  const x = (at: number) => pad.left + (t1 === t0 ? plotW : ((at - t0) / (t1 - t0)) * plotW);
  const y = (price: number) =>
    pad.top + plotH - ((Math.log(Math.max(1e-4, price)) - loLog) / (hiLog - loLog || 1)) * plotH;
  const path = (points: HistoryPoint[]) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at!).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const label = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(v >= 0.1 ? 2 : 3));
  const grid = [8, 4, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02].filter(
    (v) => Math.log(v) > loLog && Math.log(v) < hiLog,
  );

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
        aria-label="Settle price over time for QUP and QDWN, log scale">
        {grid.map((v) => (
          <g key={v}>
            <line x1={pad.left} y1={y(v)} x2={width - pad.right} y2={y(v)}
              stroke="var(--line)" strokeDasharray={v === 1 ? "4 3" : "1 4"} opacity={v === 1 ? 1 : 0.6} />
            <text x={pad.left - 6} y={y(v) + 3} textAnchor="end" fontSize="10"
              fill={v === 1 ? "var(--muted)" : "var(--dim)"} fontFamily="var(--mono)">
              {label(v)}
            </text>
          </g>
        ))}
        {up.length > 0 && <path d={path(up)} fill="none" stroke="var(--up)" strokeWidth="1.8" />}
        {down.length > 0 && <path d={path(down)} fill="none" stroke="var(--down)" strokeWidth="1.8" />}
        {up.slice(1).map((p) => (
          <circle key={`u${p.epoch}`} cx={x(p.at!)} cy={y(p.price)} r="3" fill="var(--up)" />
        ))}
        {down.slice(1).map((p) => (
          <circle key={`d${p.epoch}`} cx={x(p.at!)} cy={y(p.price)} r="3" fill="var(--down)" />
        ))}
        <text x={width - pad.right} y={height - 8} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">
          {raw.length} settle{raw.length === 1 ? "" : "s"} since launch at 1.00
        </text>
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: "var(--up)" }} />QUP</span>
        <span><i className="swatch" style={{ background: "var(--down)" }} />QDWN</span>
      </div>
    </>
  );
}

/** The first-visit explainer, kept to what a newcomer needs before clicking. */
function IntroModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p className="wordmark">Quorum</p>
        <h2 style={{ margin: "0 0 10px", fontSize: 22, textTransform: "none", letterSpacing: 0, color: "var(--text)" }}>
          One token. Every market. Pick a side.
        </h2>
        <p>
          dreamDEX runs fast prediction markets: every 15 minutes, <em>does BTC close up? does ETH?</em>{" "}
          Quorum bundles all of them into two tokens:
        </p>
        <p>
          <b className="up">QUP</b> — a share of a pot betting <b>up</b> on every market, window after window.<br />
          <b className="down">QDWN</b> — the same pot betting <b>down</b> on everything.
        </p>
        <p>
          Deposit, receive the token, withdraw whenever you like. Deposits are one transaction with no
          approval, and it&rsquo;s all free testnet money — gas from the faucet in the navbar. Questions?
          The FAQ is up there too.
        </p>
        <button className="primary" onClick={onClose} style={{ marginTop: 6 }}>
          Got it — show me the vaults
        </button>
      </div>
    </div>
  );
}

/** The questions people actually ask, answered the way the contracts work. */
function FaqModal({ brain, onClose }: { brain: BrainApi | null; onClose: () => void }) {
  const items: { q: string; a: React.ReactNode }[] = [
    {
      q: "What am I actually buying?",
      a: (
        <>A share of a pot that holds <b>the same number of contracts of every live 15-minute market</b> on
        the venue — QUP betting each closes up, QDWN betting each closes down. Equal contracts is the whole
        design: equal <em>cash</em> would buy 7× more of a cheap market and quietly turn the bucket into a
        bet on whichever market happens to be a longshot.</>
      ),
    },
    {
      q: "How is the share price calculated?",
      a: (
        <>One rule: <code>price = tUSDC in the vault ÷ tokens in circulation</code>, measured only when the
        vault is flat — pure collateral, no open positions. Worked example: the vault holds <b>300 tUSDC</b>{" "}
        against <b>250 shares</b>, so the price is <b>1.20</b>. You deposit 60 tUSDC → you are minted
        60 ÷ 1.20 = <b>50 shares</b>. The pot is now 360 against 300 shares — still exactly 1.20, so
        joining never moves the price for anyone. Next epoch the bucket wins and the pot settles at
        396 tUSDC: the price is 396 ÷ 300 = <b>1.32</b>, and withdrawing your 50 shares pays
        50 × 1.32 = <b>66 tUSDC</b>. There is no formula beyond that division — no oracle, no posted NAV —
        which is why deposits and withdrawals only execute at flat moments (see the queue question below).</>
      ),
    },
    {
      q: "How is the money in the vault divided?",
      a: (
        <>Each epoch the vault stakes <b>about a third of the pot</b> and keeps two thirds in reserve as
        plain collateral. The staked third is split to buy <b>the same number of contracts of every live
        market</b>, so each market&rsquo;s budget is proportional to its price. Example: pot 300 tUSDC →
        stake 100; three markets ask 0.60, 0.30 and 0.10 per contract (sum 1.00) → the vault buys{" "}
        <b>100 contracts of each</b>, spending 60, 30 and 10. Every winning contract redeems for exactly
        1.00, every losing one for 0. Orders carry a small protective cushion (~3%) and are
        immediate-or-cancel, so anything that doesn&rsquo;t fill at a fair price returns to the reserve
        untouched.</>
      ),
    },
    {
      q: "How are the bucket quotes calculated?",
      a: (
        <>Each tile shows the venue&rsquo;s <b>best resting ask for this vault&rsquo;s side</b>, read
        straight from the pool contract at that moment — for QUP the lowest Up ask; for QDWN the Down ask,
        which on a binary book is 1 − the best Up bid. It is what the vault&rsquo;s next contract would
        actually cost — not an oracle, an average, or anyone&rsquo;s estimate. When the vault enters, it
        pays at most that price plus a small protective cushion (~3%), and an IOC order refunds whatever
        doesn&rsquo;t fill.</>
      ),
    },
    {
      q: "What does “queues for next settle” mean?",
      a: (
        <>Deposits and withdrawals made while the money is out in the markets wait in a queue, and execute
        the moment the current window resolves and the pot is back to plain collateral. At that instant the
        price is <code>balance ÷ supply</code> — an on-chain fact nobody can bend — and one snapshot pays
        everyone in line. On 15-minute windows the wait is minutes. This single rule is what makes the
        shared pot safe: the classic vault attack (push a thin book&rsquo;s mark, mint cheap shares, let it
        resolve) needs a mark to push, and here there never is one.</>
      ),
    },
    {
      q: "Where does the share price on the chart come from?",
      a: (
        <>Every dot is an <code>EpochSettled</code> event: the moment the vault came back to flat and its
        price was the actual collateral balance divided by supply. Nothing between settles is plotted,
        because nothing between settles is a price the contract stands behind.</>
      ),
    },
    {
      q: "Why does the price move so much per epoch?",
      a: (
        <>Each epoch the vault stakes about a third of the pot across the bucket. BTC and ETH close the
        same way in most windows, so &ldquo;the whole bucket lost&rdquo; happens regularly and costs about
        a third; &ldquo;the whole bucket won&rdquo; pays the odds on that third. A third — not everything —
        because staking the full pot each window is a fast road to zero. QUP and QDWN hold opposite sides
        of the same windows, so their charts move opposite ways.</>
      ),
    },
    {
      q: "How can deposits need no approval?",
      a: (
        <>The test collateral&rsquo;s faucet is open to anyone — contracts included — so the vault mints
        the tUSDC to itself inside your deposit call: one transaction, nothing to approve. That is only
        honest because the same faucet is free to every wallet anyway; nobody is diluted by anything they
        couldn&rsquo;t have done themselves. (Depositing tUSDC you already hold also works — the
        contract&rsquo;s <code>deposit()</code> takes it after a standard ERC-20 approval.)</>
      ),
    },
    {
      q: "How do I get my money out?",
      a: (
        <>Press withdraw. If the vault is flat you are paid instantly at the exact balance price; if the
        money is out working, your shares queue and pay at the next settle, minutes later. No lock-up, no
        fee — the only cost anywhere is the markets&rsquo; own bid-ask spread.</>
      ),
    },
    {
      q: "Who runs this?",
      a: (
        <>Nobody. Each vault holds its own money, reads the books on-chain, places its own orders, redeems
        its own winnings, and settles its own epochs. A small on-chain brain — holding a Somnia Reactivity
        bond — receives the venue&rsquo;s market-creation events and fires a self-re-arming heartbeat every
        window; it can say <em>when</em>, never where the money goes. Every part is permissionless, so a
        dropped callback can be healed by anyone.
        {brain && (
          <>
            {" "}Receipt:{" "}
            <a href={`https://shannon-explorer.somnia.network/address/${brain.address}`} target="_blank" rel="noreferrer">
              the brain
            </a>{" "}
            has fired {brain.fireCount} heartbeats, fed {brain.windowsFed} windows, and holds{" "}
            {brain.bondStt.toFixed(1)} STT of bond.
          </>
        )}
        {" "}The honest limits: unaudited testnet Solidity, and a bucket lowers variance — never the
        direction of the bet.</>
      ),
    },
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 12px", fontSize: 20, color: "var(--text)" }}>FAQ</h2>
        <div className="modal-scroll">
          {items.map((item) => (
            <details key={item.q} className="faq">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
        <button onClick={onClose} style={{ marginTop: 14 }}>Close</button>
      </div>
    </div>
  );
}
