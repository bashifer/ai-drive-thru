import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Post-order audit through AssemblyAI's LLM Gateway.
 *
 * The ticket the agent built is checked against what was actually said, by a model
 * that had no part in building it. This is the QA loop a restaurant manager gets
 * instead of listening to recordings: which orders went out wrong, and why.
 */

const GATEWAY = "https://llm-gateway.assemblyai.com/v1/chat/completions";
const MODEL = process.env.AUDIT_MODEL ?? "qwen3.5-4b-32k-fast";

const SYSTEM = `You audit drive-thru orders after the fact.

You get the lane transcript and the ticket the voice agent produced. Decide whether the
ticket matches what the customer asked for.

Rules:
- Judge only against what was said. Do not invent store policy or prices.
- An item requested by a voice other than the driver should be on the ticket only if the
  driver agreed out loud.
- A correction ("make that three", "no pickles") must be reflected, not appended.
- Report at most four findings, most serious first.

Reply with JSON only:
{"verdict":"clean"|"issues","accuracy":0-100,"findings":[{"severity":"high"|"low","what":"...","evidence":"quote from the transcript"}],"summary":"one sentence"}`;

export async function POST(req: Request) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return NextResponse.json({ error: "ASSEMBLYAI_API_KEY is not set" }, { status: 500 });

  let body: { transcript?: { role: string; text: string }[]; ticket?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const transcript = (body.transcript ?? [])
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n")
    .slice(0, 12000);

  if (!transcript.trim()) return NextResponse.json({ error: "Nothing to audit" }, { status: 400 });

  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `TRANSCRIPT\n${transcript}\n\nTICKET\n${JSON.stringify(body.ticket ?? {}, null, 2)}`,
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: `LLM Gateway ${res.status}`, detail: text.slice(0, 400) }, { status: 502 });
  }

  const payload = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content ?? "";

  // The model is asked for JSON; fall back to the raw text if it wandered.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return NextResponse.json({ verdict: "unknown", summary: content.slice(0, 400) });

  try {
    return NextResponse.json(JSON.parse(match[0]));
  } catch {
    return NextResponse.json({ verdict: "unknown", summary: content.slice(0, 400) });
  }
}
