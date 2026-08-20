import { NextResponse } from "next/server";
import type { Address } from "viem";
import { deskAccount, loadPortfolio, sweepRedeem } from "@/somnia/portfolio";
import { tradingMode } from "@/somnia/exchange";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams.get("account");
  const account = (asked as Address | null) ?? deskAccount();
  if (!account) {
    return NextResponse.json(
      { error: "no account: pass ?account=0x… or set QUORUM_PRIVATE_KEY to read the desk's own book" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await loadPortfolio(account));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

/** Sweep every claimable position into collateral, in one transaction. */
export async function POST() {
  const mode = tradingMode();
  const account = deskAccount();
  if (!mode.enabled || !account) {
    return NextResponse.json({ error: `cannot redeem: ${mode.reason ?? "no signer"}` }, { status: 409 });
  }
  try {
    const view = await loadPortfolio(account);
    return NextResponse.json(await sweepRedeem(view));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
