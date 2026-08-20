import { NextResponse } from "next/server";
import { deskSnapshot } from "@/somnia/desk";

export const dynamic = "force-dynamic";

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
