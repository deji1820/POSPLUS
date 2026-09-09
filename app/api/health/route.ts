import { NextResponse } from "next/server";
import { ok } from "@/lib/api/envelope";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ...ok({ service: "posplus-web", status: "healthy" }),
    requestId: crypto.randomUUID(),
  });
}
