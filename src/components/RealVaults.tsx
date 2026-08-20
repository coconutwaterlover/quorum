"use client";

/**
 * The shared vaults: pick a side, connect a wallet, deposit real (testnet)
 * collateral, hold QUP or QDWN.
 *
 * Anyone can participate — the tokens are plain ERC-20s and the pot is shared.
 * The UI leans on the contract's one big promise: shares only ever price while
 * the vault is flat, so both action paths exist. While OPEN the deposit is
 * instant at the on-chain balance price; while DEPLOYED it queues and mints at
 * the next settle, minutes away on 15m windows. Both are shown as what they
 * are rather than blurred into one button.
 */

import { useEffect, useMemo, useState } from "react";
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
import { quorumVaultAbi } from "@/somnia/vaultAbi";
import { shannon } from "@/app/providers";

const TEST_USDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address;
const ONE = 1_000_000n; // 6-decimal collateral and shares

const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "a" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "o" }, { type: "address", name: "s" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address", name: "s" }, { type: "uint256", name: "v" }], outputs: [{ type: "bool" }] },
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
  executor: {
    liveContracts: number;
    livePositions: { series: string; contracts: number; expiry: number }[];
    claimable: number;
    idleCollateral: number;
  } | null;
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

  useEffect(() => {
    // First visit gets the explainer; after that it hides behind the “what is
    // this?” chip. localStorage only exists client-side, hence the effect.
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
  const unconfigured = vaults !== null && !up && !down;
  const wallet = wrongChain ? undefined : address;

  const dismissIntro = () => {
    localStorage.setItem("quorum-intro-seen", "1");
    setShowIntro(false);
  };

  return (
    <>
      {showIntro && <IntroModal onClose={dismissIntro} />}
      <div className="chips">
        <span className="chip live">Somnia Shannon · real wallets, shared vaults, testnet collateral</span>
        <button className="tiny" onClick={() => setShowIntro(true)}>what is this?</button>
        {isConnected && address ? (
          <>
            <span className="chip">{address.slice(0, 6)}…{address.slice(-4)}</span>
            {wrongChain ? (
              <button className="tiny on" onClick={() => switchChain({ chainId: shannon.id })}>
                switch to Shannon
              </button>
            ) : null}
            <button className="tiny" onClick={() => disconnect()}>disconnect</button>
          </>
        ) : (
          <button className="tiny on" disabled={connecting}
            onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
            {connecting ? "connecting…" : "connect wallet"}
          </button>
        )}
      </div>

      {apiError && <p className="error">{apiError}</p>}
      {unconfigured && (
        <section className="panel">
          <h2>Not deployed yet</h2>
          <p className="lede">
            The QUP/QDWN contracts are not configured on this deployment — set{" "}
            <code>NEXT_PUBLIC_QUP_ADDRESS</code> / <code>NEXT_PUBLIC_QDWN_ADDRESS</code>. The paper
            sandbox at <a href="/paper">/paper</a> works without them.
          </p>
        </section>
      )}

      <div className="grid-2">
        {up && <VaultCard state={up} wallet={wallet} />}
        {down && <VaultCard state={down} wallet={wallet} />}
      </div>

      {(up || down) && (
        <Dashboard up={up} down={down} history={history} wallet={wallet} />
      )}

      {(up || down) && <GetCollateral wallet={wallet} />}

      <section className="panel">
        <h2>How the shared pot stays fair</h2>
        <p className="lede">
          Your shares are never priced off a posted NAV or a mark of open positions. They price only at
          moments when the vault is <em>flat</em> — everything sitting as plain collateral at the
          contract — so the price is <code>balance / supply</code>, an on-chain fact anyone can verify in
          the explorer. Deposits and withdrawals made mid-epoch simply queue for the next flat moment,
          minutes away on 15-minute windows. That one rule is what closes the classic vault attack
          (depress a thin book&rsquo;s mark, mint cheap shares, let it resolve): there is never a mark to
          depress.
        </p>
        <p className="callout warn">
          <strong>The honest limits.</strong> This is a testnet demonstration. The executor key custodies
          the pot while it is deployed and is trusted to return it — under-returning would be visible
          on-chain forever as a price drop, but visible is not prevented. And QUP is a bet that markets
          close up: diversification lowers the noise, not the direction.
        </p>
      </section>
    </>
  );
}

function VaultCard({ state, wallet }: { state: VaultStateApi; wallet?: Address }) {
  const [amount, setAmount] = useState(25);
  const [note, setNote] = useState<string | null>(null);
  const isUp = state.side === "UP";

  const shares = useReadContract({
    address: state.address,
    abi: quorumVaultAbi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet, refetchInterval: 12_000 },
  });
  const allowance = useReadContract({
    address: TEST_USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: wallet ? [wallet, state.address] : undefined,
    query: { enabled: !!wallet, refetchInterval: 12_000 },
  });

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (receipt.isSuccess) {
      setNote("confirmed ✓");
      void shares.refetch();
      void allowance.refetch();
    }
  }, [receipt.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = state.phase === "OPEN" ? state.openPrice : state.lastSettlePrice ?? 1;
  const myShares = shares.data !== undefined ? Number(formatUnits(shares.data, 6)) : null;
  const raw = parseUnits(String(amount || 0), 6);
  // Until the allowance is actually known, the only honest button is a
  // disabled one: guessing "Deposit" hands a fast user a silent revert.
  const allowanceKnown = allowance.data !== undefined;
  const needsApproval = allowanceKnown && allowance.data! < raw;

  const act = (fn: () => void, label: string) => {
    setNote(label);
    reset();
    fn();
  };

  const depositLabel = state.phase === "OPEN" ? `Deposit ${amount}` : `Queue ${amount} for next settle`;
  const busy = isPending || receipt.isLoading;

  return (
    <section className="panel">
      <h2>
        {state.symbol} — everything {isUp ? "up" : "down"}
      </h2>
      <p className="lede">
        One token that bets every live market closes {isUp ? "above" : "below"} its opening price,
        window after window.
      </p>

      <div className="stats">
        <div className="stat hero">
          <div className="k">share price</div>
          <div className="v">{num(price)}</div>
          <div className="n">
            {state.phase === "OPEN" ? "live, from the flat balance" : `last settle · epoch ${state.epoch}`}
          </div>
        </div>
        <div className="stat">
          <div className="k">pot</div>
          <div className="v">{state.phase === "OPEN" ? state.cash.toFixed(2) : "out working"}</div>
          <div className="n">{state.totalSupply.toFixed(2)} {state.symbol} outstanding</div>
        </div>
        <div className="stat">
          <div className="k">phase</div>
          <div className="v" style={{ fontSize: 15, paddingTop: 5 }}>
            {state.phase === "OPEN" ? "open — instant" : `epoch ${state.epoch} deployed`}
          </div>
          <div className="n">
            {state.pendingDeposits + state.pendingWithdraws > 0
              ? `${state.pendingDeposits} deposit(s), ${state.pendingWithdraws} withdrawal(s) queued`
              : "queue empty"}
          </div>
        </div>
      </div>

      {state.executor && state.executor.livePositions.length > 0 && (
        <p className="note">
          Holding now:{" "}
          {state.executor.livePositions
            .map((p) => `${p.contracts.toFixed(1)} × ${p.series.replace("|", " ")}`)
            .join(" · ")}
        </p>
      )}

      {wallet ? (
        <div className="controls" style={{ marginTop: 16 }}>
          <label className="field">
            amount (tUSDC)
            <input type="number" min={1} step={1} value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} />
          </label>
          {!allowanceKnown ? (
            <button className="primary" disabled>checking allowance…</button>
          ) : needsApproval ? (
            <button className="primary" disabled={busy}
              onClick={() =>
                act(
                  () =>
                    writeContract({
                      address: TEST_USDC, abi: erc20Abi, functionName: "approve",
                      args: [state.address, raw],
                    }),
                  "approving…",
                )
              }>
              Approve tUSDC
            </button>
          ) : (
            <button className="primary" disabled={busy || amount <= 0}
              onClick={() =>
                act(
                  () =>
                    writeContract({
                      address: state.address, abi: quorumVaultAbi,
                      functionName: state.phase === "OPEN" ? "deposit" : "requestDeposit",
                      args: [raw],
                    }),
                  "depositing…",
                )
              }>
              {depositLabel}
            </button>
          )}
          <button disabled={busy || !myShares}
            title={state.phase === "OPEN" ? "instant, at the flat price" : "queues; pays at the next settle"}
            onClick={() =>
              act(
                () =>
                  writeContract({
                    address: state.address, abi: quorumVaultAbi,
                    functionName: state.phase === "OPEN" ? "withdraw" : "requestWithdraw",
                    args: [shares.data!],
                  }),
                "withdrawing…",
              )
            }>
            {state.phase === "OPEN" ? "Withdraw all" : "Queue withdrawal"}
          </button>
        </div>
      ) : (
        <p className="note" style={{ marginTop: 16 }}>Connect a wallet above to deposit.</p>
      )}

      {wallet && (
        <p className="note">
          You hold <b>{myShares === null ? "—" : myShares.toFixed(2)} {state.symbol}</b>
          {myShares !== null && myShares > 0 && <> ≈ {(myShares * price).toFixed(2)} tUSDC at the {state.phase === "OPEN" ? "live" : "last"} price</>}
          {state.phase === "DEPLOYED" && " · mid-epoch actions queue and execute at the next settle, minutes away"}
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

/** Testnet self-service: the collateral token has an open faucet. */
function GetCollateral({ wallet }: { wallet?: Address }) {
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });
  const balance = useReadContract({
    address: TEST_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet, refetchInterval: 12_000 },
  });

  return (
    <section className="panel">
      <h2>Need testnet money?</h2>
      <div className="controls">
        <button disabled={!wallet || isPending || receipt.isLoading}
          onClick={() =>
            writeContract({
              address: TEST_USDC, abi: erc20Abi, functionName: "faucet",
              args: [1000n * ONE],
            })
          }>
          {isPending || receipt.isLoading ? "minting…" : "Mint 1,000 tUSDC (free faucet)"}
        </button>
        <span className="muted">
          {wallet && balance.data !== undefined
            ? `you hold ${Number(formatUnits(balance.data, 6)).toFixed(2)} tUSDC`
            : "connect a wallet first"}
          {" "}· gas (STT) comes from the{" "}
          <a href="https://testnet.somnia.network/" target="_blank" rel="noreferrer">Somnia faucet</a>
        </span>
      </div>
    </section>
  );
}

/**
 * Holdings and the vaults' track record. The chart is the settle-price series
 * from each vault's own EpochSettled events — the only price the contract ever
 * commits to, which is exactly why it is the honest thing to plot.
 */
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
    abi: quorumVaultAbi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet && !!up, refetchInterval: 15_000 },
  });
  const downShares = useReadContract({
    address: down?.address,
    abi: quorumVaultAbi,
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
        <>
          <div className="stats">
            <div className="stat hero">
              <div className="k">total value</div>
              <div className="v">{totalValue.toFixed(2)}</div>
              <div className="n">tUSDC, at each vault&rsquo;s latest price</div>
            </div>
            {holdings.map(({ state, count, price, value }) => (
              <div className="stat" key={state.symbol}>
                <div className="k">{state.symbol}</div>
                <div className="v">{count === null ? "—" : count.toFixed(2)}</div>
                <div className="n">
                  {value === null ? "connect to read" : `≈ ${value.toFixed(2)} tUSDC at ${price.toFixed(4)}`}
                </div>
              </div>
            ))}
          </div>
          <p className="note">
            Queued deposits appear here after the next settle mints them. Value uses the live flat price
            while a vault is open, and its last settle price while the money is out working.
          </p>
        </>
      ) : (
        <p className="lede">Connect a wallet above and your holdings appear here.</p>
      )}

      <h2 style={{ marginTop: 22 }}>Share price, every settle since launch</h2>
      <PriceChart history={history} />
      <p className="note">
        Each point is an <code>EpochSettled</code> event — the moment the vault was flat and its price
        was the on-chain balance divided by supply. Nothing between settles is plotted because nothing
        between settles is a price the contract stands behind. A vault that starts at 1.00 and jumps
        is winning windows; one that sinks is losing them — QUP and QDWN hold opposite sides, so over
        the same windows they move opposite ways.
      </p>
    </section>
  );
}

function PriceChart({ history }: { history: HistoryApi | null }) {
  // Every vault opens at exactly 1.00 by construction, so both lines are
  // anchored there — a first settle then reads as a move, not a floating dot.
  const anchor: HistoryPoint = { epoch: 0, price: 1, supply: 0, at: null };
  const up = history?.up.length ? [anchor, ...history.up] : [];
  const down = history?.down.length ? [anchor, ...history.down] : [];
  if (up.length + down.length === 0) {
    return <p className="dim">No settles yet — the first epoch is still out working.</p>;
  }

  const width = 720;
  const height = 200;
  const pad = { left: 44, right: 12, top: 12, bottom: 24 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  // Epoch index drives x per series; both start at launch, so index aligns well
  // enough without pretending the two vaults settle in lockstep.
  const maxLen = Math.max(up.length, down.length, 2);
  const prices = [...up, ...down].map((p) => p.price).concat(1);
  const lo = Math.min(...prices) * 0.95;
  const hi = Math.max(...prices) * 1.05;
  const x = (i: number, n: number) => pad.left + (n <= 1 ? plotW : (i / (maxLen - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const path = (points: HistoryPoint[]) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i, points.length).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
        aria-label="Settle price per epoch for QUP and QDWN">
        <line x1={pad.left} y1={y(1)} x2={width - pad.right} y2={y(1)} stroke="var(--line)" strokeDasharray="2 3" />
        <text x={pad.left - 6} y={y(1) + 3} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">1.00</text>
        <text x={pad.left - 6} y={y(hi) + 9} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">{hi.toFixed(2)}</text>
        <text x={pad.left - 6} y={y(lo) - 2} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">{lo.toFixed(2)}</text>
        {up.length > 0 && <path d={path(up)} fill="none" stroke="var(--up)" strokeWidth="1.8" />}
        {down.length > 0 && <path d={path(down)} fill="none" stroke="var(--down)" strokeWidth="1.8" />}
        {up.slice(1).map((p, i) => (
          <circle key={`u${p.epoch}`} cx={x(i + 1, up.length)} cy={y(p.price)} r="3" fill="var(--up)" />
        ))}
        {down.slice(1).map((p, i) => (
          <circle key={`d${p.epoch}`} cx={x(i + 1, down.length)} cy={y(p.price)} r="3" fill="var(--down)" />
        ))}
        <text x={width - pad.right} y={height - 8} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">
          {maxLen - 1} settle{maxLen === 2 ? "" : "s"} since launch at 1.00
        </text>
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: "var(--up)" }} />QUP</span>
        <span><i className="swatch" style={{ background: "var(--down)" }} />QDWN</span>
      </div>
    </>
  );
}

/** The first-visit explainer. Everything a newcomer needs, in one card. */
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
          Each one alone is a coin flip. <strong>Quorum bundles all of them into two tokens:</strong>
        </p>
        <p>
          <b className="up">QUP</b> — a share of a pot that bets <b>up</b> on every market, window after
          window.<br />
          <b className="down">QDWN</b> — the same pot betting <b>down</b> on everything.
        </p>
        <p>
          Deposit testnet tUSDC, receive the token, withdraw whenever you like. The pot buys the same
          number of contracts of each market, and every payout rolls itself into the next window. Your
          share is priced only when the pot is flat — plain collateral at the contract — so the price is
          an on-chain balance anyone can verify, never someone&rsquo;s estimate.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          Testnet, so it is free to try: gas (STT) from the{" "}
          <a href="https://testnet.somnia.network/" target="_blank" rel="noreferrer">Somnia faucet</a>,
          collateral from the mint button below. Prefer no wallet at all? The{" "}
          <a href="/paper">paper sandbox</a> runs the same strategy instantly, and{" "}
          <a href="/desk">the numbers</a> show the measured evidence behind the whole idea.
        </p>
        <button className="primary" onClick={onClose} style={{ marginTop: 6 }}>
          Got it — show me the vaults
        </button>
      </div>
    </div>
  );
}
