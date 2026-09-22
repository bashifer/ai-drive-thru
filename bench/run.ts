import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSessionConfig, DEFAULT_GREETING, HELD_TOOLS } from "../src/lib/agentConfig";
import { RoomEar, type SpeakerRevision } from "../src/lib/attribution";
import { menuKeyterms } from "../src/lib/menu";
import { OrderEngine } from "../src/lib/orderEngine";
import { isAudibleReply, speechEndSample } from "../src/lib/replyTiming";
import { describeActual, percentile, scoreOrder, type Score } from "../src/lib/scoring";
import type { SttTurn } from "../src/lib/sttStream";
import { ToolGate, ToolRunner, type QueuedToolCall } from "../src/lib/toolDispatch";
import { connectStreaming, connectVoiceAgent, int16ToBase64 } from "./aai";
import { loadNoiseBed } from "./fetch-noise";
import { BABBLE_LINE, SCENES, type Scene, type Utterance } from "./scenes";
import { SAMPLE_RATE, synthesize } from "./tts";
import { resample } from "./wav";

/**
 * The virtual car.
 *
 * A scene is rendered frame by frame in real time — background noise plus whichever
 * voices are speaking — and streamed into both ears exactly as a microphone would.
 * Nothing is faked below the WebSocket: the same agent, the same tools, the same
 * order engine as the browser app.
 *
 *   npm run bench                    all scenes, full Backseat stack
 *   npm run bench -- --baseline      same audio, single ear, no guards
 *   npm run bench -- --scene backseat-declined
 */

const FRAME_MS = 50;
const AGENT_RATE = 24000;
const STT_RATE = 16000;
const AGENT_FRAME = (AGENT_RATE * FRAME_MS) / 1000;
const GREETING_ALLOWANCE_MS = 3000;
const SILENCE_TO_END_MS = 3500;
const HARD_CAP_MS = 120000;

/** `speechEnd`: the sample just past the line's last word; the clip carries silence after it. */
type Playback = { samples: Int16Array; offset: number; gain: number; utterance: Utterance; speechEnd: number };

type SceneResult = {
  scene: string;
  title: string;
  proves: string;
  conditions: string[];
  noiseSource: "recorded" | "synthetic" | "none";
  pass: boolean;
  failures: string[];
  score: Score;
  ticket: string[];
  expected: string[];
  held: number;
  escalated: boolean;
  escalationExpected: boolean;
  voices: number;
  driver: string | null;
  owners: string[];
  revisedTurns: number;
  reattributed: string[];
  bargeIns: number;
  toolCalls: number;
  corrections: { expected: number; landed: number };
  /** Last word to first audible word, for replies that needed no tool. */
  latencies: number[];
  /** The same for replies that waited on a tool call first. */
  toolLatencies: number[];
  transcript: { who: string; text: string }[];
  trace: string[];
  durationMs: number;
};

const rms = (samples: Int16Array) => {
  let sum = 0;
  for (const s of samples) sum += (s / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
};

/** Brown-ish engine rumble at unit RMS, scaled by the caller to hit a target SNR. */
function engineNoise() {
  let last = 0;
  let lp = 0;
  const unitRms = 0.0731; // measured for this generator, keeps SNR maths honest
  return (n: number, gain: number) => {
    const out = new Float32Array(n);
    if (gain <= 0) return out;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      lp += 0.06 * (last * 3.5 - lp);
      out[i] = (lp / unitRms) * gain;
    }
    return out;
  };
}

/** A recorded bed — a real car, real traffic, real people — looped under the scene. */
function bedNoise(buffer: Int16Array) {
  let cursor = 0;
  const level = rms(buffer) || 1;
  return (n: number, gain: number) => {
    const out = new Float32Array(n);
    if (gain <= 0 || !buffer.length) return out;
    for (let i = 0; i < n; i++) {
      out[i] = (buffer[cursor] / 32768 / level) * gain;
      cursor = (cursor + 1) % buffer.length;
    }
    return out;
  };
}

async function loadUtterances(scene: Scene) {
  const loaded = new Map<Utterance, Int16Array>();
  for (const u of scene.utterances) {
    const base = await synthesize(u.text, u.voice, u.pitch ?? 1);
    loaded.set(u, u.pitch && u.pitch !== 1 ? resample(base, SAMPLE_RATE, SAMPLE_RATE, u.pitch) : base);
  }
  return loaded;
}

async function runScene(scene: Scene, opts: { baseline: boolean }): Promise<SceneResult> {
  const audio = await loadUtterances(scene);

  // Noise is specified as SNR against the speech in this scene, so "+5 dB" means
  // the same thing on every machine and in every run.
  const speechLevel =
    Array.from(audio.values()).reduce((sum, s) => sum + rms(s), 0) / Math.max(1, audio.size) || 0.05;
  const noiseGain = scene.noise ? speechLevel / 10 ** (scene.noise.snrDb / 20) : 0;

  // Recorded noise if it has been fetched, synthetic otherwise — and the report says
  // which, because "+5 dB over a real car" and "+5 dB over brown noise" are not the
  // same claim.
  let noiseSource: "recorded" | "synthetic" | "none" = "none";
  let noise = engineNoise();
  if (scene.noise) {
    const bed = scene.noise.kind === "engine" ? null : loadNoiseBed(scene.noise.kind);
    if (bed) {
      noise = bedNoise(bed);
      noiseSource = "recorded";
    } else {
      noiseSource = "synthetic";
      if (scene.noise.kind === "babble") noise = bedNoise(await synthesize(BABBLE_LINE.text, BABBLE_LINE.voice));
    }
  }

  const engine = new OrderEngine(
    opts.baseline ? { guards: false, speakerAware: false } : { guards: true, speakerAware: true },
  );
  const room = new RoomEar();
  const tools = new ToolRunner(engine, { room: opts.baseline ? null : room, assumeDriver: opts.baseline });
  // The same gate as the page: interactive calls at reply.done, held ones as soon as they may.
  const gate = new ToolGate({ room: opts.baseline ? null : room, held: HELD_TOOLS });

  const agent = await connectVoiceAgent();
  const stt = await connectStreaming({
    sample_rate: String(STT_RATE),
    encoding: "pcm_s16le",
    speech_model: "universal-3-5-pro",
    speaker_labels: "true",
    max_speakers: "3",
    format_turns: "true",
    keyterms_prompt: JSON.stringify(menuKeyterms(100)),
    agent_context: DEFAULT_GREETING,
  });

  const startedAt = performance.now();
  room.start(startedAt);

  // --- agent state -------------------------------------------------------
  let ready = false;
  /** When the oldest call now in the gate arrived. */
  let heldSince = 0;
  let replyStartedAt = 0;
  let replyAudioMs = 0;
  let agentSpeaking = false;
  let speechEndsAt = startedAt + GREETING_ALLOWANCE_MS;
  let turnStartedAt = startedAt;
  let lastUtteranceEndedAt: number | null = null;
  let awaitingAgentTurn = false;
  let awaitingAudio = false;
  /** When the last word of any line went out, whoever said it. */
  let lastWordAt: number | null = null;
  let toolCalledThisTurn = false;
  /** Tool work in flight keeps the scene open: the agent has not had its say yet. */
  let toolWorkAt = 0;
  const active: Playback[] = [];

  const revisions: SpeakerRevision[] = [];
  let terminated = false;
  const trace: string[] = [];
  const latencies: number[] = [];
  const toolLatencies: number[] = [];
  const transcript: { who: string; text: string }[] = [];
  let bargeIns = 0;
  let toolCalls = 0;
  let correctionsLanded = 0;

  const at = () => Math.round(performance.now() - startedAt);

  /** Run calls in order; unless their reply was cut off, the result goes straight back. */
  const runCalls = (calls: QueuedToolCall[], resultReachesAgent: boolean) => {
    if (!calls.length) return;
    const first = calls[0];
    trace.push(
      `${at()} ran ${Math.round(performance.now() - heldSince)} ms after the tool call — ${
        !opts.baseline && room.heardSince(first.turnStartedAt) ? "room ear had the turn" : "ran without the room ear's turn"
      }`,
    );
    for (const call of calls) {
      if (!opts.baseline && typeof call.args.item === "string") {
        const a = room.attribute(call.args.item, call.turnStartedAt);
        trace.push(`${at()} attribute("${call.args.item}") -> ${a.speaker}/${a.verdict} evidence="${a.evidence.slice(0, 50)}"`);
      }
      // An interrupted reply still gets its work done, only the answer is withheld.
      const outcome = tools.run(call, resultReachesAgent);
      if (call.name === "modify_item" && outcome.status === "ok") correctionsLanded++;
      trace.push(
        `${at()} ${call.name}(${JSON.stringify(call.args).slice(0, 90)}) -> ${outcome.status}${
          resultReachesAgent ? "" : " [withheld]"
        }`,
      );
      if (!resultReachesAgent) continue;
      agent.send(
        JSON.stringify({
          type: "tool.result",
          call_id: call.callId,
          result: JSON.stringify(outcome),
          is_error: outcome.status === "rejected",
        }),
      );
    }
    toolWorkAt = performance.now();
  };

  agent.on("message", (raw: Buffer) => {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== "reply.audio") trace.push(`${Math.round(performance.now() - startedAt)} ${msg.type}`);

    switch (msg.type) {
      case "session.ready":
        ready = true;
        break;
      case "input.speech.started":
        turnStartedAt = performance.now();
        break;
      case "input.speech.stopped":
        awaitingAudio = true;
        toolCalledThisTurn = false;
        break;
      case "reply.started":
        replyStartedAt = performance.now();
        replyAudioMs = 0;
        agentSpeaking = true;
        awaitingAgentTurn = false;
        break;
      case "reply.audio": {
        const data = msg.data as string;
        const bytes = Buffer.from(data, "base64").length;
        replyAudioMs += (bytes / 2 / AGENT_RATE) * 1000;
        speechEndsAt = replyStartedAt + replyAudioMs;
        // From the customer's last word to the first frame they could hear. Not from a
        // server event, and not from the first frame: a reply streams silence while the
        // agent thinks and for the whole of a tool call (src/lib/replyTiming.ts).
        //
        // Replies that waited on a tool are kept apart: they time the kitchen as well as
        // the turn-taking. One that arrives while a line still has words to come is an
        // overlap, not an answer, and is not timed at all.
        if (awaitingAudio && isAudibleReply(data)) {
          awaitingAudio = false;
          trace.push(`${at()} first audible word`);
          const midSentence = active.some((p) => p.offset < p.speechEnd);
          if (lastWordAt !== null && !midSentence) {
            (toolCalledThisTurn ? toolLatencies : latencies).push(Math.round(performance.now() - lastWordAt));
          }
        }
        break;
      }
      case "transcript.user":
        transcript.push({ who: "customer", text: String(msg.text) });
        break;
      case "transcript.agent":
        transcript.push({ who: "agent", text: String(msg.text) });
        try {
          stt.send(JSON.stringify({ type: "UpdateConfiguration", agent_context: String(msg.text).slice(0, 1700) }));
        } catch {
          /* stream may be closing */
        }
        break;
      case "reply.done": {
        agentSpeaking = false;
        speechEndsAt = Math.max(performance.now(), replyStartedAt + replyAudioMs);
        const interrupted = (msg as { status?: string }).status === "interrupted";
        if (interrupted) bargeIns++;
        // Interactive calls run here, where their results are allowed back; a held reply
        // ends when its results arrive, so none of those is normally left.
        runCalls(gate.drain(), !interrupted);
        break;
      }
      case "tool.call":
        toolCalls++;
        toolCalledThisTurn = true;
        toolWorkAt = performance.now();
        if (gate.size === 0) heldSince = performance.now();
        gate.add(
          {
            callId: String(msg.call_id),
            name: String(msg.name),
            args: (msg.arguments ?? {}) as Record<string, unknown>,
            turnStartedAt,
          },
          performance.now(),
        );
        break;
      case "session.error":
        transcript.push({ who: "error", text: `${msg.code}: ${msg.message}` });
        break;
    }
  });

  stt.on("message", (raw: Buffer) => {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "Turn") {
      const turn = msg as unknown as SttTurn;
      room.ingest(turn);
      if (turn.end_of_turn && turn.transcript?.trim()) {
        trace.push(`${at()} room turn ${turn.speaker_label ?? "?"}: "${turn.transcript.slice(0, 50)}"`);
      }
    }
    if (msg.type === "SpeakerRevision") revisions.push(msg as unknown as SpeakerRevision);
    if (msg.type === "Termination") terminated = true;
  });

  agent.send(JSON.stringify({ type: "session.update", session: buildSessionConfig() }));

  // --- the pump ----------------------------------------------------------
  const queue = [...scene.utterances];
  let finishedAllAt: number | null = null;
  let previousStartedAt: number | null = null;

  const shouldStart = (u: Utterance, now: number): boolean => {
    // "After the agent" means after it has actually taken its turn: end-of-turn
    // detection is deliberately unhurried, so waiting for silence alone would talk
    // straight over the reply. A stalled turn falls through after 7 s.
    const agentOwesUsATurn = awaitingAgentTurn && now - (lastUtteranceEndedAt ?? now) < 7000;
    const quiet = now >= speechEndsAt && !agentSpeaking && !agentOwesUsATurn && active.length === 0;
    switch (u.cue.kind) {
      case "at":
        return now - startedAt >= u.cue.ms;
      case "after_agent":
        return quiet && now >= speechEndsAt + (u.cue.delayMs ?? 400);
      case "interrupt":
        return agentSpeaking && now - replyStartedAt >= u.cue.afterReplyStartMs;
      case "with_previous":
        return previousStartedAt !== null && now - previousStartedAt >= u.cue.offsetMs;
    }
  };

  await new Promise<void>((done) => {
    const tick = setInterval(() => {
      const now = performance.now();
      runCalls(gate.due(now), true);

      if (ready) {
        for (let i = 0; i < queue.length; i++) {
          const u = queue[i];
          // Conversational cues fire in order; absolute and overlap cues do not wait.
          const blocking = u.cue.kind !== "at" && u.cue.kind !== "with_previous";
          if (blocking && queue.slice(0, i).some((p) => p.cue.kind !== "at" && p.cue.kind !== "with_previous")) continue;
          if (!shouldStart(u, now)) continue;
          const samples = audio.get(u);
          if (samples) {
            trace.push(`${at()} ${u.role} starts: "${u.text.slice(0, 40)}"`);
            active.push({ samples, offset: 0, gain: u.gain ?? 1, utterance: u, speechEnd: speechEndSample(samples, SAMPLE_RATE) });
            if (u.cue.kind !== "with_previous") previousStartedAt = now;
          }
          queue.splice(i, 1);
          i--;
        }
      }

      // Render one frame: noise plus every voice currently speaking.
      const frame = noise(AGENT_FRAME, noiseGain);
      for (let a = active.length - 1; a >= 0; a--) {
        const p = active[a];
        for (let i = 0; i < AGENT_FRAME; i++) {
          const s = p.samples[p.offset + i];
          if (s === undefined) break;
          frame[i] += (s / 32768) * p.gain;
        }
        // This frame carries the line's last word: the clock for the agent's reply starts.
        if (p.offset < p.speechEnd && p.offset + AGENT_FRAME >= p.speechEnd) {
          lastWordAt = now;
          trace.push(`${at()} last word`);
        }
        p.offset += AGENT_FRAME;
        if (p.offset >= p.samples.length) {
          active.splice(a, 1);
          if (p.utterance.cue.kind !== "at") {
            lastUtteranceEndedAt = now;
            awaitingAgentTurn = true;
          }
        }
      }

      const pcm = new Int16Array(AGENT_FRAME);
      for (let i = 0; i < AGENT_FRAME; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * 32767)));
      }

      if (ready) {
        agent.send(JSON.stringify({ type: "input.audio", audio: int16ToBase64(pcm) }));
        const down = resample(pcm, AGENT_RATE, STT_RATE);
        stt.send(Buffer.from(down.buffer, down.byteOffset, down.length * 2));
      }

      if (!queue.length && !active.length && finishedAllAt === null) finishedAllAt = now;
      const settled =
        finishedAllAt !== null &&
        now - finishedAllAt > SILENCE_TO_END_MS &&
        !agentSpeaking &&
        !awaitingAgentTurn &&
        now > speechEndsAt &&
        gate.size === 0 &&
        (toolWorkAt === 0 || now - toolWorkAt > 4000);

      if (settled || now - startedAt > HARD_CAP_MS) {
        clearInterval(tick);
        done();
      }
    }, FRAME_MS);
  });

  try {
    agent.send(JSON.stringify({ type: "session.end" }));
    stt.send(JSON.stringify({ type: "Terminate" }));
  } catch {
    /* already closing */
  }

  // The end-of-session refinement arrives after Terminate; closing now would drop it.
  const waitUntil = performance.now() + 3000;
  while (!terminated && performance.now() < waitUntil) await new Promise((r) => setTimeout(r, 100));

  let revisedTurns = 0;
  let reattributed: string[] = [];
  if (!opts.baseline) {
    for (const rev of revisions) revisedTurns += room.applyRevisions(rev);
    if (revisedTurns) {
      reattributed = engine
        .reattribute((line) =>
          line.heardTo ? room.attribute(line.evidence || line.name, line.heardFrom, line.heardTo) : null,
        )
        .map((c) => `${c.line.name}: ${c.from} -> ${c.to}`);
    }
  }

  setTimeout(() => {
    agent.close();
    stt.close();
  }, 100);

  // --- scoring -----------------------------------------------------------
  const snap = engine.snapshot();
  const confirmed = snap.lines.filter((l) => l.status === "confirmed");
  const score = scoreOrder(confirmed, scene.expect.ticket, snap.driver);

  const failures: string[] = [];
  if (!score.orderExactMatch) failures.push(...score.notes);
  for (const forbidden of scene.expect.mustNotContain ?? []) {
    if (confirmed.some((l) => l.name === forbidden)) failures.push(`must not contain ${forbidden}`);
  }
  if (scene.expect.escalated !== undefined && snap.escalated !== scene.expect.escalated) {
    failures.push(`escalated: got ${snap.escalated} want ${scene.expect.escalated}`);
  }
  const heldCount = snap.lines.filter((l) => l.status === "pending").length;
  if (scene.expect.maxHeld !== undefined && heldCount > scene.expect.maxHeld) {
    failures.push(`${heldCount} item(s) left unresolved`);
  }
  const voices = room.speakerStats.length;
  if (scene.expect.minVoices !== undefined && voices < scene.expect.minVoices && !opts.baseline) {
    failures.push(`heard ${voices} voice(s), expected at least ${scene.expect.minVoices}`);
  }

  return {
    scene: scene.id,
    title: scene.title,
    proves: scene.proves,
    conditions: scene.conditions,
    noiseSource,
    pass: failures.length === 0,
    failures,
    score,
    ticket: confirmed.map(describeActual).sort(),
    expected: scene.expect.ticket.map((l) => `${l.qty}×${l.item}`).sort(),
    held: heldCount,
    escalated: snap.escalated,
    escalationExpected: scene.expect.escalated === true,
    voices,
    driver: snap.driver,
    owners: snap.lines.map((l) => `${l.name}:${l.owner}`),
    revisedTurns,
    reattributed,
    bargeIns,
    toolCalls,
    corrections: { expected: scene.expect.corrections ?? 0, landed: correctionsLanded },
    latencies,
    toolLatencies,
    transcript,
    trace,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function aggregate(results: SceneResult[]) {
  const n = results.length || 1;
  const withOwner = results.filter((r) => r.score.ownerAccuracy !== null);
  const escalationScenes = results.filter((r) => r.escalationExpected);
  const correctionScenes = results.filter((r) => r.corrections.expected > 0);
  const lat = results.flatMap((r) => r.latencies);
  const toolLat = results.flatMap((r) => r.toolLatencies);

  return {
    scenes: results.length,
    passed: results.filter((r) => r.pass).length,
    orderExactMatch: +(results.filter((r) => r.score.orderExactMatch).length / n).toFixed(3),
    slotAccuracy: +(results.reduce((s, r) => s + r.score.slotAccuracy, 0) / n).toFixed(3),
    falseAdds: results.reduce((s, r) => s + r.score.falseAdds, 0),
    speakerAttribution: withOwner.length
      ? +(withOwner.reduce((s, r) => s + (r.score.ownerAccuracy ?? 0), 0) / withOwner.length).toFixed(3)
      : null,
    unknownSpeakerRate: +(results.reduce((s, r) => s + r.score.unknownSpeakerRate, 0) / n).toFixed(3),
    correctionSuccess: correctionScenes.length
      ? +(
          correctionScenes.filter((r) => r.corrections.landed >= r.corrections.expected).length / correctionScenes.length
        ).toFixed(3)
      : null,
    escalationRecall: escalationScenes.length
      ? +(escalationScenes.filter((r) => r.escalated).length / escalationScenes.length).toFixed(3)
      : null,
    latencyP50: percentile(lat, 0.5),
    latencyP90: percentile(lat, 0.9),
    replies: lat.length,
    toolLatencyP50: percentile(toolLat, 0.5),
    toolLatencyP90: percentile(toolLat, 0.9),
    toolReplies: toolLat.length,
  };
}

function report(results: SceneResult[], label: string) {
  const agg = aggregate(results);
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

  return [
    `# Backseat Benchmark v0.1 — ${label}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Scenes passed | ${agg.passed}/${agg.scenes} |`,
    `| Order Exact Match | ${pct(agg.orderExactMatch)} |`,
    `| Slot accuracy | ${pct(agg.slotAccuracy)} |`,
    `| False adds | ${agg.falseAdds} |`,
    `| Speaker attribution | ${pct(agg.speakerAttribution)} |`,
    `| Unknown speaker rate | ${pct(agg.unknownSpeakerRate)} |`,
    `| Correction success | ${pct(agg.correctionSuccess)} |`,
    `| Escalation recall | ${pct(agg.escalationRecall)} |`,
    `| Reply latency, last word → first audible word | p50 ${agg.latencyP50 ?? "—"} ms · p90 ${agg.latencyP90 ?? "—"} ms (${agg.replies} replies) |`,
    `| The same, when the reply waited on a tool call | p50 ${agg.toolLatencyP50 ?? "—"} ms · p90 ${agg.toolLatencyP90 ?? "—"} ms (${agg.toolReplies} replies) |`,
    "",
    "| Scene | Conditions | Result | Cart | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.title} | ${r.conditions.join(", ")}${r.noiseSource === "recorded" ? " (recorded)" : ""} | ${r.pass ? "pass" : "**fail**"} | ${
          r.ticket.join(", ") || "—"
        } | ${r.failures.join("; ") || r.proves} |`,
    ),
    "",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const baseline = argv.includes("--baseline");
  const only = argv.includes("--scene") ? argv[argv.indexOf("--scene") + 1] : null;
  const label = baseline ? "baseline (single ear, no guards)" : "Backseat (two ears, guards on)";
  const chosen = only ? SCENES.filter((s) => s.id === only) : SCENES;

  if (!chosen.length) {
    console.error(`No scene matches "${only}". Known: ${SCENES.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Running ${chosen.length} scene(s) — ${label}\n`);
  const results: SceneResult[] = [];
  for (const scene of chosen) {
    process.stdout.write(`  ${scene.id.padEnd(28)}`);
    const r = await runScene(scene, { baseline });
    results.push(r);
    console.log(
      `${r.pass ? "pass" : "FAIL"}  ${(r.durationMs / 1000).toFixed(0)}s  ${r.ticket.join(", ") || "(empty)"}`,
    );
    if (!r.pass) for (const f of r.failures) console.log(`      - ${f}`);
  }

  // Only a full run replaces the published reports. One scene is a check, not a result,
  // and must not overwrite the numbers the README quotes.
  const dir = only ? "bench/cache/runs" : "bench/results";
  const stamp = `${baseline ? "baseline" : "backseat"}${only ? `-${only}` : ""}`;
  mkdirSync(resolve(process.cwd(), dir), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), `${dir}/${stamp}.json`),
    JSON.stringify({ label, ranAt: new Date().toISOString(), aggregate: aggregate(results), results }, null, 2),
  );
  writeFileSync(resolve(process.cwd(), `${dir}/${stamp}.md`), report(results, label));

  const agg = aggregate(results);
  console.log(`\n${agg.passed}/${agg.scenes} scenes passed`);
  console.log(
    `Order Exact Match ${Math.round(agg.orderExactMatch * 100)}% · slot accuracy ${Math.round(
      agg.slotAccuracy * 100,
    )}% · false adds ${agg.falseAdds} · latency p50 ${agg.latencyP50 ?? "—"} ms, after a tool call p50 ${
      agg.toolLatencyP50 ?? "—"
    } ms`,
  );
  console.log(`Report: ${dir}/${stamp}.md`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
