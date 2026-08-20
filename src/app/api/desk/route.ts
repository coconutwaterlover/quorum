import { NextResponse } from "next/server";
import { deskSnapshot } from "@/somnia/desk";

export const dynamic = "force-dynamic";

/**
 * Every request to this route is a cold one on a serverless deploy: the
 * in-process snapshot cache lives inside one instance, so a fresh instance pays
 * the full discovery cost. That is ~1s of concurrent chain reads, comfortably
 * inside the default ceiling — but the ceiling is raised anyway so a slow RPC
 * round trip degrades into a slow page rather than a 504.
 */
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(await deskSnapshot());
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 502 });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
