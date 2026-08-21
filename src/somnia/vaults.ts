/**
 * The self-driving vaults (QUP / QDWN v3) and their reactivity brain.
 *
 * There is no keeper anymore — the chain runs the machine. The QuorumBrain
 * contract owns two reactivity subscriptions (the venue's MarketCreated event
 * stream, which feeds the vaults their buckets, and a self-re-arming
 * quarter-hour heartbeat that calls the vaults' permissionless runEpoch), and
 * the vaults trade, redeem and settle entirely on-chain.
 *
 * What remains here server-side is a HEALER: everything on the contracts is
 * permissionless by design, so if a callback is ever dropped or the brain's
 * bond runs dry, any funded key can poke the machine back to life. That is the
 * whole job of keeperTick now — rearm a stale heartbeat, poke the vaults —
 * and doing it when nothing is wrong is merely a cheap no-op.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Leg, Side } from "@/engine/types";
import { venueConfig } from "./exchange";
import { quorumVaultV3Abi, quorumBrainAbi } from "./vaultAbi";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

export interface VaultConfig {
  readonly symbol: "QUP" | "QDWN";
  readonly side: Side;
  readonly address: Address | null;
}

export function vaultConfigs(): VaultConfig[] {
  return [
    { symbol: "QUP", side: "UP", address: (process.env.NEXT_PUBLIC_QUP_ADDRESS as Address) || null },
    { symbol: "QDWN", side: "DOWN", address: (process.env.NEXT_PUBLIC_QDWN_ADDRESS as Address) || null },
  ];
}

export function brainAddress(): Address | null {
  return (process.env.NEXT_PUBLIC_BRAIN_ADDRESS as Address) || null;
}

function healerKey(): Hex | null {
  return (process.env.QUORUM_EXEC_UP_KEY as Hex) || null;
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

/** One market in the bucket a vault is (or is about to be) betting on. */
export interface BucketMarket {
  readonly marketId: string;
  readonly series: string;
  readonly asset: string;
  readonly interval: string;
  /** Price of THIS vault's side right now — what the next contract costs. */
  readonly price: number | null;
  readonly expiry: number;
  readonly question: string;
  /** Contracts the vault currently holds in this market's window. */
  readonly held: number | null;
}

export interface VaultState {
  readonly symbol: "QUP" | "QDWN";
  readonly side: Side;
  readonly address: Address;
  readonly phase: "OPEN" | "DEPLOYED";
  readonly epoch: number;
  readonly cash: number;
  readonly totalSupply: number;
  readonly openPrice: number;
  readonly lastSettlePrice: number | null;
  readonly pendingDeposits: number;
  readonly pendingWithdraws: number;
  readonly pendingDepositAssets: number;
  readonly bucket: readonly BucketMarket[];
  /** The brain keeping it alive, for the UI to link and show. */
  readonly brain: {
    readonly address: Address;
    readonly fireCount: number;
    readonly windowsFed: number;
    readonly pairsMinted: number;
    readonly bondStt: number;
  } | null;
}

export async function readVaultState(
  config: VaultConfig,
  legs?: readonly Leg[],
): Promise<VaultState | null> {
  if (!config.address) return null;
  const client = vaultPublicClient();
  const vault = { address: config.address, abi: quorumVaultV3Abi } as const;

  const [phase, epoch, cashRaw, supply, openPriceRaw, lastPriceRaw, queues, pendingAssets, windowsView] =
    await Promise.all([
      client.readContract({ ...vault, functionName: "phase" }),
      client.readContract({ ...vault, functionName: "epoch" }),
      client.readContract({ ...vault, functionName: "cash" }),
      client.readContract({ ...vault, functionName: "totalSupply" }),
      client.readContract({ ...vault, functionName: "openPrice" }),
      client.readContract({ ...vault, functionName: "lastSettlePrice" }),
      client.readContract({ ...vault, functionName: "queueLengths" }),
      client.readContract({ ...vault, functionName: "pendingDepositAssets" }),
      client.readContract({ ...vault, functionName: "windowsView" }),
    ]);

  // What the vault holds, straight from its own windows and the ERC-6909
  // balances windowsView reads for us.
  const [windowList, held] = windowsView as unknown as [
    { marketId: string; expiry: bigint; entered: boolean }[],
    bigint[],
  ];
  const heldByMarket = new Map<string, number>();
  for (let i = 0; i < windowList.length; i++) {
    if (windowList[i].entered && held[i] > 0n) {
      heldByMarket.set(windowList[i].marketId.toLowerCase(), Number(formatUnits(held[i], 6)));
    }
  }

  const bucket: BucketMarket[] = (legs ?? [])
    .filter((l) => l.side === config.side && l.interval === "15m")
    .sort((a, b) => a.series.localeCompare(b.series))
    .map((l) => ({
      marketId: l.marketId,
      series: l.series,
      asset: l.asset,
      interval: l.interval,
      price: l.ask ?? l.mid,
      expiry: l.expiry,
      question: l.question,
      held: heldByMarket.get(l.marketId.toLowerCase()) ?? null,
    }));

  let brain: VaultState["brain"] = null;
  const brainAddr = brainAddress();
  if (brainAddr) {
    try {
      const [fireCount, windowsFed, pairsMinted, bond] = await Promise.all([
        client.readContract({ address: brainAddr, abi: quorumBrainAbi, functionName: "fireCount" }),
        client.readContract({ address: brainAddr, abi: quorumBrainAbi, functionName: "windowsFed" }),
        client.readContract({ address: brainAddr, abi: quorumBrainAbi, functionName: "pairsMinted" }),
        client.getBalance({ address: brainAddr }),
      ]);
      brain = {
        address: brainAddr,
        fireCount: Number(fireCount),
        windowsFed: Number(windowsFed),
        pairsMinted: Number(pairsMinted),
        bondStt: Number(formatUnits(bond, 18)),
      };
    } catch {
      brain = null;
    }
  }

  return {
    symbol: config.symbol,
    side: config.side,
    address: config.address,
    phase: Number(phase) === 0 ? "OPEN" : "DEPLOYED",
    epoch: Number(epoch),
    cash: Number(formatUnits(cashRaw as bigint, 6)),
    totalSupply: Number(formatUnits(supply as bigint, 6)),
    openPrice: Number(formatUnits(openPriceRaw as bigint, 18)),
    lastSettlePrice: (lastPriceRaw as bigint) === 0n ? null : Number(formatUnits(lastPriceRaw as bigint, 18)),
    pendingDeposits: Number((queues as [bigint, bigint])[0]),
    pendingWithdraws: Number((queues as [bigint, bigint])[1]),
    pendingDepositAssets: Number(formatUnits(pendingAssets as bigint, 6)),
    bucket,
    brain,
  };
}

export interface KeeperAction {
  readonly vault: string;
  readonly action: string;
  readonly detail: string;
}

/**
 * The healer pass. Rearm the heartbeat if it is stale, poke the vaults if a
 * fire seems overdue. All targets are permissionless; a pass that finds
 * nothing wrong costs one small transaction at most.
 */
export async function keeperTick(): Promise<KeeperAction[]> {
  const actions: KeeperAction[] = [];
  const brainAddr = brainAddress();
  const key = healerKey();
  if (!brainAddr || !key) {
    return [{ vault: "brain", action: "skip", detail: "brain or healer key not configured" }];
  }

  const client = vaultPublicClient();
  const wallet = createWalletClient({
    account: privateKeyToAccount(key),
    chain: chain(),
    transport: http(rpcUrl()),
  });

  try {
    const armedForMs = Number(
      await client.readContract({ address: brainAddr, abi: quorumBrainAbi, functionName: "armedForMs" }),
    );
    const lateBy = Date.now() - armedForMs;

    if (armedForMs !== 0 && lateBy < 60_000) {
      actions.push({ vault: "brain", action: "healthy", detail: `armed for ${new Date(armedForMs).toISOString()}` });
      return actions;
    }

    // The heartbeat is overdue (or was never armed): do its job once and re-arm.
    try {
      const hash = await wallet.writeContract({ address: brainAddr, abi: quorumBrainAbi, functionName: "pokeVaults" });
      await client.waitForTransactionReceipt({ hash });
      actions.push({ vault: "brain", action: "poked", detail: `heartbeat ${Math.round(lateBy / 1000)}s late — ran the vaults manually` });
    } catch (error) {
      actions.push({ vault: "brain", action: "poke-failed", detail: String(error instanceof Error ? error.message : error).slice(0, 120) });
    }
    try {
      const hash = await wallet.writeContract({ address: brainAddr, abi: quorumBrainAbi, functionName: "rearm" });
      await client.waitForTransactionReceipt({ hash });
      actions.push({ vault: "brain", action: "rearmed", detail: "next heartbeat scheduled" });
    } catch {
      actions.push({ vault: "brain", action: "rearm-skipped", detail: "already armed for the next boundary" });
    }
  } catch (error) {
    actions.push({ vault: "brain", action: "error", detail: String(error instanceof Error ? error.message : error).slice(0, 160) });
  }
  return actions;
}
