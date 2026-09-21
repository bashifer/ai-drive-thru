import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints a short-lived Streaming (Universal-3.5 Pro) token for the diarization
 * side-channel: the "room ear" that hears who is speaking in the car.
 */
export async function GET() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ASSEMBLYAI_API_KEY is not set. Put it in .env.local and restart `npm run dev`." },
      { status: 500 },
    );
  }

  const url = new URL("https://streaming.assemblyai.com/v3/token");
  url.searchParams.set("expires_in_seconds", "120");
  url.searchParams.set(
    "max_session_duration_seconds",
    process.env.MAX_SESSION_SECONDS ?? "180",
  );

  // Streaming auth takes the raw key with no Bearer prefix.
  let res = await fetch(url, { headers: { Authorization: key }, cache: "no-store" });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
  }

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json(
      { error: `AssemblyAI streaming token request failed (${res.status})`, detail: body.slice(0, 500) },
      { status: 502 },
    );
  }

  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
