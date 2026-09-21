import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSessionConfig } from "../src/lib/agentConfig";
import { OrderEngine } from "../src/lib/orderEngine";
import { describeActual, scoreOrder, type ExpectedLine } from "../src/lib/scoring";
import { dispatchTool } from "../src/lib/toolDispatch";
import { connectVoiceAgent, int16ToBase64 } from "./aai";
import { loadNoiseBed } from "./fetch-noise";
import { coverage, loadCases } from "./foodordering";
import { synthesize } from "./tts";

/**
 * The order layer at volume.
 *
 * Every case is a real ordering utterance from Amazon's FoodOrdering dataset with an
 * annotated order attached. The utterance is spoken into a real Voice Agent session
 * and the resulting cart is compared to the annotation, slot by slot. One speaker, no
 * conversation: this isolates "did the order come out right" from the multi-party
 * behaviour the scene bench covers.
 *
 * With --snr it runs the same cases over engine noise, which turns the dataset into a
 * robustness sweep rather than a single number.
 *
 *   npm run bench:orders
 *   npm run bench:orders -- --limit 30 --snr 5
 */

const FRAME_MS = 50;
const AGENT_RATE = 24000;
const AGENT_FRAME = (AGENT_RATE * FRAME_MS) / 1000;
const VOICE = "george";
const SETTLE_MS = 3500;
const CASE_TIMEOUT_MS = 60000;

type Call = { name: string; args: Record<string, unknown>; callId: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function noiseFrame(n: number, gain: number, state: { last: number; lp: number }) {
  const out = new Float32Array(n);
  if (gain <= 0) return out;
  for (let i = 0; i < n; i++) {
    state.last = (state.last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    state.lp += 0.06 * (state.last * 3.5 - state.lp);
    out[i] = (state.lp / 0.0731) * gain;
  }
  return out;
}

const rms = (samples: Int16Array) => {
  let sum = 0;
  for (const s of samples) sum += (s / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
};

/** Speak one utterance into a session and collect what it books. */
async function speakToAgent(speech: Int16Array, snrDb: number | null, bed: Int16Array | null): Promise<Call[]> {
  const ws = await connectVoiceAgent();
  const calls: Call[] = [];
  const noiseGain = snrDb === null ? 0 : (rms(speech) || 0.05) / 10 ** (snrDb / 20);
  const noiseState = { last: 0, lp: 0 };
  const bedLevel = bed ? rms(bed) || 1 : 1;
  let bedCursor = Math.floor(Math.random() * (bed?.length ?? 1));

  let ready = false;
  let answeredTools = false;
  let doneAt: number | null = null;
  let failure: Error | null = null;
  /** Nothing the agent says before the customer has finished counts as an answer. */
  let speechSent = false;

  ws.on("message", (raw: Buffer) => {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "session.ready") ready = true;
    else if (msg.type === "tool.call") {
      calls.push({
        name: String(msg.name),
        args: (msg.arguments ?? {}) as Record<string, unknown>,
        callId: String(msg.call_id),
      });
    } else if (msg.type === "reply.done") {
      if (!speechSent) return;
      if (!answeredTools && calls.length) {
        answeredTools = true;
        for (const c of calls) {
          ws.send(
            JSON.stringify({
              type: "tool.result",
              call_id: c.callId,
              result: JSON.stringify({ status: "ok", message: "Added." }),
            }),
          );
        }
      } else {
        doneAt = Date.now();
      }
    } else if (msg.type === "session.error") {
      failure = new Error(`${msg.code}: ${msg.message}`);
    }
  });

  // No greeting: the customer speaks first, and a greeting would only be talked over.
  ws.send(JSON.stringify({ type: "session.update", session: { ...buildSessionConfig(), greeting: undefined } }));

  const startedAt = Date.now();
  while (!ready && Date.now() - startedAt < 10000 && !failure) await sleep(50);
  if (failure) {
    ws.close();
    throw failure;
  }

  // Stream the utterance at real time, then hold the line open while it thinks.
  let offset = 0;
  const speechFrames = Math.ceil(speech.length / AGENT_FRAME);
  const totalFrames = speechFrames + Math.ceil(SETTLE_MS / FRAME_MS);
  for (let frame = 0; frame < totalFrames; frame++) {
    if (frame === speechFrames) speechSent = true;
    if (failure || Date.now() - startedAt > CASE_TIMEOUT_MS) break;
    if (doneAt && Date.now() - doneAt > 800) break;

    const pcm = new Int16Array(AGENT_FRAME);
    const noise = bed ? null : noiseFrame(AGENT_FRAME, noiseGain, noiseState);
    for (let i = 0; i < AGENT_FRAME; i++) {
      const s = speech[offset + i] ?? 0;
      let n = 0;
      if (bed) {
        n = (bed[bedCursor] / 32768 / bedLevel) * noiseGain * 32768;
        bedCursor = (bedCursor + 1) % bed.length;
      } else if (noise) {
        n = noise[i] * 32768;
      }
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s + n)));
    }
    offset += AGENT_FRAME;

    ws.send(JSON.stringify({ type: "input.audio", audio: int16ToBase64(pcm) }));
    await sleep(FRAME_MS);
  }

  try {
    ws.send(JSON.stringify({ type: "session.end" }));
  } catch {
    /* already gone */
  }
  setTimeout(() => ws.close(), 100);
  if (failure) throw failure;
  return calls;
}

type CaseResult = {
  src: string;
  expected: string[];
  got: string[];
  exactMatch: boolean;
  slotAccuracy: number;
  falseAdds: number;
  missing: number;
  toolCalls: number;
  calls: string[];
  error?: string;
};

async function runCase(
  src: string,
  expected: ExpectedLine[],
  snrDb: number | null,
  bed: Int16Array | null,
): Promise<CaseResult> {
  const engine = new OrderEngine({ guards: true, speakerAware: false });
  const base: CaseResult = {
    src,
    expected: expected.map((e) => `${e.qty}×${e.item}`),
    got: [],
    exactMatch: false,
    slotAccuracy: 0,
    falseAdds: 0,
    missing: expected.length,
    toolCalls: 0,
    calls: [],
  };

  let calls: Call[];
  try {
    const speech = await synthesize(src, VOICE);
    calls = await speakToAgent(speech, snrDb, bed);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const trace: string[] = [];
  for (const call of calls) {
    const outcome = dispatchTool(engine, call.name, call.args, { room: null, turnStartedAt: 0, assumeDriver: true });
    trace.push(`${call.name}(${JSON.stringify(call.args)}) -> ${outcome.status}`);
  }

  const snap = engine.snapshot();
  const confirmed = snap.lines.filter((l) => l.status === "confirmed");
  const score = scoreOrder(confirmed, expected, snap.driver);

  return {
    src,
    expected: base.expected,
    got: confirmed.map(describeActual),
    exactMatch: score.orderExactMatch,
    slotAccuracy: score.slotAccuracy,
    falseAdds: score.falseAdds,
    missing: score.missing,
    toolCalls: calls.length,
    calls: trace,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const limit = Number(flag("--limit") ?? Infinity);
  const snrDb = flag("--snr") !== undefined ? Number(flag("--snr")) : null;
  const concurrency = Number(flag("--concurrency") ?? 4);

  const cases = await loadCases();
  const { clean, missing } = coverage(cases);
  const chosen = clean.slice(0, Number.isFinite(limit) ? limit : undefined);
  const bed = snrDb === null ? null : loadNoiseBed(flag("--noise") ?? "car");
  const condition =
    snrDb === null ? "clean" : `${bed ? "recorded car" : "synthetic engine"} +${snrDb} dB`;

  console.log(
    `FoodOrdering burger dev set: ${cases.length} cases, ${clean.length} map onto this menu (${Math.round(
      (100 * clean.length) / cases.length,
    )}%)`,
  );
  if (missing.length) console.log(`  not covered: ${missing.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  console.log(`Speaking ${chosen.length} orders into the lane — ${condition}\n`);

  const results: CaseResult[] = [];
  for (let i = 0; i < chosen.length; i += concurrency) {
    const batch = chosen.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((c) => runCase(c.src, c.expected, snrDb, bed)))));
    const exact = results.filter((r) => r.exactMatch).length;
    process.stdout.write(`\r  ${results.length}/${chosen.length}  exact ${Math.round((100 * exact) / results.length)}%`);
  }
  console.log("\n");

  const n = results.length || 1;
  const agg = {
    condition,
    cases: results.length,
    orderExactMatch: +(results.filter((r) => r.exactMatch).length / n).toFixed(3),
    slotAccuracy: +(results.reduce((s, r) => s + r.slotAccuracy, 0) / n).toFixed(3),
    falseAdds: results.reduce((s, r) => s + r.falseAdds, 0),
    missing: results.reduce((s, r) => s + r.missing, 0),
    errors: results.filter((r) => r.error).length,
  };

  const md = [
    `# Backseat Benchmark v0.1 — order accuracy (${condition})`,
    "",
    `Source: Amazon FoodOrdering burger dev set (CC BY-NC 4.0), ${clean.length}/${cases.length} cases mapped onto the Burger Lab menu.`,
    "Each utterance is spoken into a real Voice Agent session; the cart it produces is compared to the dataset's annotation.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Cases | ${agg.cases} |`,
    `| Order Exact Match | ${Math.round(agg.orderExactMatch * 100)}% |`,
    `| Slot accuracy | ${Math.round(agg.slotAccuracy * 100)}% |`,
    `| False adds | ${agg.falseAdds} |`,
    `| Missing lines | ${agg.missing} |`,
    `| Errors | ${agg.errors} |`,
    "",
    "## Where the cart came out wrong",
    "",
    ...results
      .filter((r) => !r.exactMatch)
      .slice(0, 25)
      .flatMap((r) => [
        `- "${r.src}"`,
        `  - expected ${r.expected.join(", ")}`,
        `  - got ${r.got.join(", ") || "nothing"}${r.error ? ` (${r.error})` : ""}`,
      ]),
    "",
  ].join("\n");

  // A --limit run is a sample; only the whole set replaces the published report.
  const partial = chosen.length < clean.length;
  const dir = partial ? "bench/cache/runs" : "bench/results";
  const stamp = `${snrDb === null ? "orders-clean" : `orders-${bed ? "car" : "synth"}-snr${snrDb}`}${
    partial ? `-first${chosen.length}` : ""
  }`;
  mkdirSync(resolve(process.cwd(), dir), { recursive: true });
  writeFileSync(resolve(process.cwd(), `${dir}/${stamp}.json`), JSON.stringify({ aggregate: agg, results }, null, 2));
  writeFileSync(resolve(process.cwd(), `${dir}/${stamp}.md`), md);

  console.log(
    `Order Exact Match ${Math.round(agg.orderExactMatch * 100)}% · slot accuracy ${Math.round(
      agg.slotAccuracy * 100,
    )}% · false adds ${agg.falseAdds} · missing ${agg.missing}${agg.errors ? ` · errors ${agg.errors}` : ""}`,
  );
  console.log(`Report: ${dir}/${stamp}.md`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
