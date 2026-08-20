import { NextResponse } from "next/server";
import { decodeEventLog, parseAbiItem, toEventSelector, type Hex } from "viem";
import { vaultConfigs, vaultPublicClient } from "@/somnia/vaults";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Each vault's settle-price track record, straight from its own EpochSettled
 * events. The explorer's log API is used instead of eth_getLogs because the
 * public RPC caps ranges at 1,000 blocks and Somnia mints several blocks a
 * second — a day of history would be thousands of range calls.
 */
const SETTLED = parseAbiItem(
  "event EpochSettled(uint64 indexed epoch_, uint256 price, uint256 cash, uint256 supply)",
);
const SETTLED_TOPIC = toEventSelector(SETTLED);
const EXPLORER = "https://shannon-explorer.somnia.network/api/v2";

interface Point {
  epoch: number;
  price: number;
  cash: number;
  supply: number;
  at: number | null;
  block: number;
}

const blockTimes = new Map<number, number>();

async function history(address: string): Promise<Point[]> {
  const response = await fetch(`${EXPLORER}/addresses/${address}/logs`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`explorer ${response.status}`);
  const body = (await response.json()) as {
    items?: { topics?: (string | null)[]; data?: string; block_number?: number }[];
  };

  const points: Point[] = [];
  for (const item of body.items ?? []) {
    if ((item.topics ?? [])[0] !== SETTLED_TOPIC) continue;
    const decoded = decodeEventLog({
      abi: [SETTLED],
      topics: (item.topics ?? []).filter((t): t is Hex => t !== null) as [Hex, ...Hex[]],
      data: (item.data ?? "0x") as Hex,
    });
    points.push({
      epoch: Number(decoded.args.epoch_),
      price: Number(decoded.args.price) / 1e18,
      cash: Number(decoded.args.cash) / 1e6,
      supply: Number(decoded.args.supply) / 1e6,
      at: null,
      block: item.block_number ?? 0,
    });
  }
  points.sort((a, b) => a.epoch - b.epoch);

  // Settles are rare (a handful per hour), so per-block timestamp lookups are
  // cheap — and cached, since a block's timestamp never changes.
  const client = vaultPublicClient();
  await Promise.all(
    points.map(async (point) => {
      if (!point.block) return;
      const cached = blockTimes.get(point.block);
      if (cached !== undefined) {
        point.at = cached;
        return;
      }
      try {
        const block = await client.getBlock({ blockNumber: BigInt(point.block) });
        const at = Number(block.timestamp);
        blockTimes.set(point.block, at);
        point.at = at;
      } catch {
        point.at = null;
      }
    }),
  );
  return points;
}

export async function GET() {
  try {
    const [upConfig, downConfig] = vaultConfigs();
    const [up, down] = await Promise.all([
      upConfig.address ? history(upConfig.address) : Promise.resolve([]),
      downConfig.address ? history(downConfig.address) : Promise.resolve([]),
    ]);
    return NextResponse.json({ at: Math.floor(Date.now() / 1000), up, down });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
