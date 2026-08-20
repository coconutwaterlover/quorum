import { NextResponse } from "next/server";
import { quoteSelection, type QuoteRequest } from "@/somnia/desk";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as QuoteRequest;
    if (!Array.isArray(body.selection) || body.selection.length === 0) {
      return NextResponse.json({ error: "pick at least one leg" }, { status: 400 });
    }
    // Float64Array does not survive JSON, so the payoff ladder is sent as the
    // handful of levels a basket can actually pay rather than 10,001 zeroes.
    const result = await quoteSelection(body);
    const { distribution, ...rest } = result.quote;
    const smallestWeight = Math.min(...result.legs.map((l) => l.weightBp), 10_000);
    return NextResponse.json({
      ...result,
      quote: { ...rest, ladder: ladderOf(distribution.pmf, smallestWeight) },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

/**
 * The distinct payoffs a basket can pay, with their probabilities.
 *
 * Equal weights over 7 legs are 1430 and 1428 basis points, not a clean seventh,
 * so the exact grid holds two rungs a couple of basis points apart wherever a
 * subset happens to include the leg carrying the rounding remainder. They are
 * the same rung to anyone reading the chart, so rungs closer together than half
 * the smallest weight are merged — a real gap between levels is at least one
 * whole weight wide, so nothing distinguishable is ever collapsed.
 */
function ladderOf(
  pmf: Float64Array,
  smallestWeightBp: number,
): { payoff: number; probability: number }[] {
  const scale = pmf.length - 1;
  const mergeWithin = Math.max(1, Math.floor(smallestWeightBp / 2));
  const rungs: { payoff: number; probability: number }[] = [];
  let openAt = -Infinity;
  let mass = 0;
  let weightedSum = 0;

  const flush = () => {
    if (mass > 0) rungs.push({ payoff: weightedSum / mass / scale, probability: mass });
  };

  for (let v = 0; v < pmf.length; v++) {
    if (pmf[v] <= 1e-9) continue;
    if (v - openAt > mergeWithin) {
      flush();
      mass = 0;
      weightedSum = 0;
      openAt = v;
    }
    mass += pmf[v];
    weightedSum += v * pmf[v];
  }
  flush();
  return rungs;
}
