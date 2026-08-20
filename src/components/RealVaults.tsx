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
  const [apiError, setApiError] = useState<string | null>(null);

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

  return (
    <>
      <div className="chips">
        <span className="chip live">Somnia Shannon · real wallets, shared vaults, testnet collateral</span>
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
        {up && <VaultCard state={up} wallet={wrongChain ? undefined : address} />}
        {down && <VaultCard state={down} wallet={wrongChain ? undefined : address} />}
      </div>

      {(up || down) && <GetCollateral wallet={wrongChain ? undefined : address} />}

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
  const needsApproval = allowance.data !== undefined && allowance.data < raw;

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
          {needsApproval ? (
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
      {note && !writeError && <p className="note">{note} {receipt.isLoading && "(waiting for the chain)"}</p>}
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
