import { NextResponse } from "next/server";
import { buyBasket } from "@/somnia/execute";
import { currentBooks, quoteSelection, type QuoteRequest } from "@/somnia/desk";
import { tradingMode } from "@/somnia/exchange";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const mode = tradingMode();
  if (!mode.enabled) {
    return NextResponse.json(
      { error: `trading is off: ${mode.reason}. The plan above is exactly what it would have sent.` },
      { status: 409 },
    );
  }

  try {
    const body = (await request.json()) as QuoteRequest;
    if (!Array.isArray(body.selection) || body.selection.length === 0) {
      return NextResponse.json({ error: "pick at least one leg" }, { status: 400 });
    }
    const stake = Number(body.stake ?? 0);
    if (!Number.isFinite(stake) || stake <= 0) {
      return NextResponse.json({ error: "stake must be a positive number" }, { status: 400 });
    }
    if (stake > mode.maxStake) {
      return NextResponse.json(
        { error: `stake ${stake} exceeds the ceiling of ${mode.maxStake} set by QUORUM_MAX_STAKE` },
        { status: 400 },
      );
    }

    // Re-plan against the current snapshot rather than trusting a plan the
    // client posted back: the book it was built from may be minutes old.
    const { plan } = await quoteSelection(body);
    const receipt = await buyBasket(plan, await currentBooks());
    return NextResponse.json(receipt);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
