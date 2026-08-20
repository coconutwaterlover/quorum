import { NextResponse } from "next/server";
import { readVaultState, vaultConfigs } from "@/somnia/vaults";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Everything the vault page shows that is not wallet-specific. */
export async function GET() {
  try {
    const [up, down] = await Promise.all(
      vaultConfigs().map((config) =>
        readVaultState(config).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    return NextResponse.json({ at: Math.floor(Date.now() / 1000), up, down });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
