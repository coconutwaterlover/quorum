import { NextResponse } from "next/server";
import { readExchange } from "@/somnia/exchange";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The one chain fact the vault cannot get from the desk snapshot: how a window
 * that has *left* the live list resolved. Stateless on purpose — the ledger
 * lives with its holder, and this route only reports what the chain says about
 * the market ids it is asked about.
 */
export async function POST(request: Request) {
  let ids: unknown;
  try {
    ids = ((await request.json()) as { marketIds?: unknown }).marketIds;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "pass marketIds: string[]" }, { status: 400 });
  }
  const marketIds = [...new Set(ids)].filter(
    (id): id is string => typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id),
  );
  if (marketIds.length === 0 || marketIds.length > 24) {
    return NextResponse.json({ error: "between 1 and 24 valid bytes32 market ids" }, { status: 400 });
  }

  try {
    const exchange = readExchange();
    const entries = await Promise.all(
      marketIds.map(async (marketId) => {
        const onchain = await exchange.client.getMarketOnchain(marketId as `0x${string}`);
        return [
          marketId,
          {
            resolved: onchain.isResolved,
            voided: onchain.isVoided,
            // winningOutcome defaults to 0 before resolution, so it is only a
            // fact once isResolved says so.
            upWon: onchain.isResolved ? Number(onchain.winningOutcome) === 0 : null,
          },
        ] as const;
      }),
    );
    return NextResponse.json({
      asOf: Math.floor(Date.now() / 1000),
      resolutions: Object.fromEntries(entries),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
