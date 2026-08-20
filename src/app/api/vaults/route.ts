import { NextResponse, after } from "next/server";
import { discover } from "@/somnia/discover";
import { keeperTick, readVaultState, vaultConfigs } from "@/somnia/vaults";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Everything the vault page shows that is not wallet-specific — and, quietly,
 * the epoch engine. Per-minute crons need a paid Vercel plan, so the keeper
 * rides on the page's own polling instead: after each response is sent, one
 * debounced keeper pass runs post-response via `after()`. Any open tab keeps
 * the vaults rolling; with no viewers they pause mid-epoch and pick up on the
 * next visit (plus a daily cron as a dead-man fallback). Overlapping passes
 * from several instances are harmless — every state change is guarded by the
 * contract's phase checks, so the losers revert.
 */
let lastTickAt = 0;
const TICK_DEBOUNCE_MS = 45_000;

export async function GET() {
  try {
    const configs = vaultConfigs();
    // One book snapshot feeds both vaults' bucket views; a failure here only
    // costs the bucket display, never the vault state itself.
    const legs = await discover()
      .then((d) => d.legs)
      .catch(() => []);
    const [up, down] = await Promise.all(
      configs.map((config) =>
        readVaultState(config, legs).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );

    const configured = configs.some((c) => c.address);
    if (configured && Date.now() - lastTickAt > TICK_DEBOUNCE_MS) {
      lastTickAt = Date.now();
      after(async () => {
        try {
          const actions = await keeperTick();
          for (const action of actions) {
            if (action.action !== "idle") console.log(`[keeper] ${action.vault} ${action.action}: ${action.detail}`);
          }
        } catch (error) {
          console.error("[keeper]", error);
        }
      });
    }

    return NextResponse.json({ at: Math.floor(Date.now() / 1000), up, down });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
