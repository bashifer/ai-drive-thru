import { NextResponse } from "next/server";
import { takeSessionSlot } from "@/lib/demoBudget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints a short-lived Voice Agent API token so the browser never sees the API key.
 * Each token is single-use and starts exactly one session.
 */
export async function GET() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ASSEMBLYAI_API_KEY is not set. Put it in .env.local and restart `npm run dev`." },
      { status: 500 },
    );
  }

  const slot = takeSessionSlot();
  if (!slot.ok) {
    return NextResponse.json({ error: slot.message }, { status: 429 });
  }

  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", "120");
  url.searchParams.set(
    "max_session_duration_seconds",
    process.env.MAX_SESSION_SECONDS ?? "180",
  );

  // The agents API accepts the raw key; some deployments expect a Bearer prefix.
  let res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: key }, cache: "no-store" });
  }

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json(
      { error: `AssemblyAI token request failed (${res.status})`, detail: body.slice(0, 500) },
      { status: 502 },
    );
  }

  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
