/**
 * The two on-chain vaults (QUP / QDWN) and the keeper that runs their epochs.
 *
 * The contract holds the trust story (shares only ever price while flat); this
 * module is the muscle: each tick it, per vault —
 *
 *   1. redeems whatever the oracle settled into the executor wallet;
 *   2. if the epoch's positions are all settled and redeemed, returns every
 *      collateral cent to the vault and calls settleEpoch — the price the
 *      holders get IS the returned balance, so this step is the honesty;
 *   3. if the vault is flat and holding cash with live windows open, takes the
 *      pot out and buys this side of the 15m cross-section, equal contracts.
 *
 * 15m windows only, on purpose: epochs stay short enough that "deposits queue
 * for the next settle" means minutes, and the fast cadence is the one with
 * hundreds of settled windows behind the numbers page's claims.
 */

import {
  SomniaMarkets,
  SOMNIA_MAINNET_ADDRESSES,
  SOMNIA_TESTNET_ADDRESSES,
} from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { equalWeights } from "@/engine/quote";
import type { Side, WeightedLeg } from "@/engine/types";
import { discover } from "./discover";
import { buyBasket, planBasket } from "./execute";
import { loadPortfolio, sweepRedeem } from "./portfolio";
import { venueConfig, collateralAddress } from "./exchange";
import { quorumVaultAbi } from "./vaultAbi";

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface VaultConfig {
  readonly symbol: "QUP" | "QDWN";
  readonly side: Side;
  readonly address: Address | null;
  readonly executorKey: Hex | null;
}

export function vaultConfigs(): VaultConfig[] {
  return [
    {
      symbol: "QUP",
      side: "UP",
      address: (process.env.NEXT_PUBLIC_QUP_ADDRESS as Address) || null,
      executorKey: (process.env.QUORUM_EXEC_UP_KEY as Hex) || null,
    },
    {
      symbol: "QDWN",
      side: "DOWN",
      address: (process.env.NEXT_PUBLIC_QDWN_ADDRESS as Address) || null,
      executorKey: (process.env.QUORUM_EXEC_DOWN_KEY as Hex) || null,
    },
  ];
}

function rpcUrl(): string {
  return process.env.QUORUM_HTTP_RPC_URL || "https://api.infra.testnet.somnia.network";
}

function chain() {
  return venueConfig().network === "mainnet" ? somniaMainnet : somniaShannon;
}

export function vaultPublicClient() {
  return createPublicClient({ chain: chain(), transport: http(rpcUrl()) });
}

function executorWallet(key: Hex) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: chain(), transport: http(rpcUrl()) });
}

function executorExchange(key: Hex): SomniaMarkets {
  const cfg = venueConfig();
  return new SomniaMarkets({
    indexerUrl: cfg.indexerUrl,
    chain: chain(),
    wsRpcUrl: cfg.wsRpcUrl,
    addresses: cfg.network === "mainnet" ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES,
    privateKey: key,
  });
}

export interface VaultState {
  readonly symbol: "QUP" | "QDWN";
  readonly side: Side;
  readonly address: Address;
  readonly phase: "OPEN" | "DEPLOYED";
  readonly epoch: number;
  /** Priced pot in the vault, human units. Zero while deployed. */
  readonly cash: number;
  readonly totalSupply: number;
  /** 1e18-scaled prices flattened to floats for display. */
  readonly openPrice: number;
  readonly lastSettlePrice: number | null;
  readonly pendingDeposits: number;
  readonly pendingWithdraws: number;
  readonly pendingDepositAssets: number;
  /** What the executor currently holds for this vault. */
  readonly executor: {
    readonly address: Address;
    readonly liveContracts: number;
    readonly livePositions: { series: string; contracts: number; expiry: number }[];
    readonly claimable: number;
    readonly idleCollateral: number;
  } | null;
}

export async function readVaultState(config: VaultConfig): Promise<VaultState | null> {
  if (!config.address) return null;
  const client = vaultPublicClient();
  const vault = { address: config.address, abi: quorumVaultAbi } as const;

  const [phase, epoch, cashRaw, supply, openPriceRaw, lastPriceRaw, queues, pendingAssets] =
    await Promise.all([
      client.readContract({ ...vault, functionName: "phase" }),
      client.readContract({ ...vault, functionName: "epoch" }),
      client.readContract({ ...vault, functionName: "cash" }),
      client.readContract({ ...vault, functionName: "totalSupply" }),
      client.readContract({ ...vault, functionName: "openPrice" }),
      client.readContract({ ...vault, functionName: "lastSettlePrice" }),
      client.readContract({ ...vault, functionName: "queueLengths" }),
      client.readContract({ ...vault, functionName: "pendingDepositAssets" }),
    ]);

  let executor: VaultState["executor"] = null;
  if (config.executorKey) {
    const account = privateKeyToAccount(config.executorKey).address;
    const [view, idle] = await Promise.all([
      loadPortfolio(account, { windowsBack: 12 }),
      client.readContract({
        address: collateralAddress(),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      }),
    ]);
    const mine = view.live.filter((p) => p.side === config.side);
    executor = {
      address: account,
      liveContracts: mine.reduce((sum, p) => sum + p.contracts, 0),
      livePositions: mine.map((p) => ({ series: p.series, contracts: p.contracts, expiry: p.expiry })),
      claimable: view.claimable
        .filter((p) => p.side === config.side)
        .reduce((sum, p) => sum + p.claimable, 0),
      idleCollateral: Number(formatUnits(idle, 6)),
    };
  }

  return {
    symbol: config.symbol,
    side: config.side,
    address: config.address,
    phase: Number(phase) === 0 ? "OPEN" : "DEPLOYED",
    epoch: Number(epoch),
    cash: Number(formatUnits(cashRaw, 6)),
    totalSupply: Number(formatUnits(supply, 6)),
    openPrice: Number(formatUnits(openPriceRaw, 18)),
    lastSettlePrice: lastPriceRaw === 0n ? null : Number(formatUnits(lastPriceRaw, 18)),
    pendingDeposits: Number(queues[0]),
    pendingWithdraws: Number(queues[1]),
    pendingDepositAssets: Number(formatUnits(pendingAssets, 6)),
    executor,
  };
}

export interface KeeperAction {
  readonly vault: "QUP" | "QDWN";
  readonly action: string;
  readonly detail: string;
}

const MIN_DEPLOY = 1; // don't bother trading pots under 1 tUSDC
const MIN_HEADROOM_SECONDS = 180;

/** One keeper pass over both vaults. Every step is reported, including skips. */
export async function keeperTick(): Promise<KeeperAction[]> {
  const actions: KeeperAction[] = [];
  const discovery = await discover();

  for (const config of vaultConfigs()) {
    if (!config.address || !config.executorKey) {
      actions.push({ vault: config.symbol, action: "skip", detail: "not configured" });
      continue;
    }
    const symbol = config.symbol;
    try {
      const state = await readVaultState(config);
      if (!state || !state.executor) continue;
      const wallet = executorWallet(config.executorKey);
      const client = vaultPublicClient();
      const exchange = executorExchange(config.executorKey);

      // 1. Claim whatever settled for this side.
      const view = await loadPortfolio(state.executor.address, { windowsBack: 12 });
      const claimables = view.claimable.filter((p) => p.side === config.side);
      if (claimables.length > 0) {
        const swept = await sweepRedeem({ ...view, claimable: claimables }, exchange);
        actions.push({
          vault: symbol,
          action: swept.error ? "redeem-failed" : "redeemed",
          detail: swept.error ?? `${swept.claimed.toFixed(2)} from ${swept.positions} position(s)`,
        });
        if (swept.error) continue;
      }

      // 2. All settled and claimed -> hand everything back and close the epoch.
      const liveMine = view.live.filter((p) => p.side === config.side);
      if (state.phase === "DEPLOYED" && liveMine.length === 0 && claimables.length === 0) {
        const idle = await client.readContract({
          address: collateralAddress(),
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [state.executor.address],
        });
        if (idle > 0n) {
          const hash = await wallet.writeContract({
            address: collateralAddress(),
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [config.address, idle],
          });
          await client.waitForTransactionReceipt({ hash });
        }
        const hash = await wallet.writeContract({
          address: config.address,
          abi: quorumVaultAbi,
          functionName: "settleEpoch",
        });
        const receipt = await client.waitForTransactionReceipt({ hash });
        actions.push({
          vault: symbol,
          action: receipt.status === "reverted" ? "settle-reverted" : "settled",
          detail: `epoch ${state.epoch} closed, returned ${formatUnits(idle, 6)}`,
        });
        continue;
      }

      // 3. Flat with cash and open windows -> take the pot out and buy the side.
      const legs = discovery.legs.filter(
        (l) =>
          l.side === config.side &&
          l.interval === "15m" &&
          l.ask !== null &&
          l.expiry - discovery.asOf > MIN_HEADROOM_SECONDS,
      );
      if (state.phase === "OPEN" && state.cash >= MIN_DEPLOY && legs.length >= 2) {
        const hash = await wallet.writeContract({
          address: config.address,
          abi: quorumVaultAbi,
          functionName: "deployFunds",
        });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          // Another invocation won the race; nothing lost, nothing bought.
          actions.push({ vault: symbol, action: "deploy-raced", detail: "another tick deployed first" });
          continue;
        }
        const weights = equalWeights(legs.length);
        const weighted: WeightedLeg[] = legs.map((leg, i) => ({ ...leg, weightBp: weights[i] }));
        const plan = planBasket(weighted, discovery.books, state.cash);
        const receipt2 = await buyBasket(plan, discovery.books, { exchange });
        actions.push({
          vault: symbol,
          action: "deployed",
          detail: `epoch ${state.epoch}: ${receipt2.contractsFilled.toFixed(2)} contracts across ${legs.length} windows for ${receipt2.collateralSpent.toFixed(2)}${receipt2.legsMissed ? `, ${receipt2.legsMissed} leg(s) missed` : ""}`,
        });
        continue;
      }

      actions.push({
        vault: symbol,
        action: "idle",
        detail: `phase ${state.phase}, cash ${state.cash.toFixed(2)}, ${liveMine.length} live position(s), ${legs.length} enterable window(s)`,
      });
    } catch (error) {
      actions.push({
        vault: symbol,
        action: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return actions;
}
