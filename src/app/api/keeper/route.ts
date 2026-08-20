import { NextResponse } from "next/server";
import { keeperTick } from "@/somnia/vaults";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The epoch driver. A Vercel cron hits this every minute (it sends
 * `Authorization: Bearer $CRON_SECRET` automatically once the env var is set);
 * a manual call needs the same secret. Every invocation is one full pass:
 * redeem, settle, deploy — each step guarded by on-chain phase checks, so two
 * overlapping invocations cannot double-spend; the loser's transaction simply
 * reverts and is reported as a race.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  const key = new URL(request.url).searchParams.get("key");
  if (secret && auth !== `Bearer ${secret}` && key !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const actions = await keeperTick();
    return NextResponse.json({ at: Math.floor(Date.now() / 1000), actions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
