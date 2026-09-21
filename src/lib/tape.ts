import { base64ToBytes, bytesToBase64 } from "./audio";
import type { SpeakerRevision } from "./attribution";
import type { SttEvent, SttTurn, SttWord } from "./sttStream";
import type { VoiceAgentEvent } from "./voiceAgent";

/**
 * A recorded lane, for watching Backseat work without a microphone, a key or credits.
 *
 * Only what AssemblyAI said is on the tape: the Voice Agent's events (transcripts, tool
 * calls, the agent's own voice) and the room ear's finished turns with their word
 * timings and speaker labels. Nothing Backseat decided is recorded. On replay the same
 * events go through the same handlers at the same moments, so attribution, the order
 * engine and the A/B shadow cart all decide again, in the browser, as it plays.
 */

export type TapeEvent =
  | { t: number; ear: "agent"; event: VoiceAgentEvent }
  | { t: number; ear: "room"; event: SttEvent }
  /** The agent's voice: 16 kHz μ-law, base64. Played back as the `reply.audio` it was. */
  | { t: number; ear: "voice"; data: string }
  /** A scripted line started playing into the lane: the scenario's step index. */
  | { t: number; ear: "clip"; step: number };

export type TapeCar = {
  /** The in-page scenario this car played, for its clips and its expected ticket. */
  scenarioId: string;
  /** When the room ear's clock started, in ms after the car pulled up. */
  roomStartedAt: number;
  events: TapeEvent[];
  durationMs: number;
};

export type Tape = { version: 1; recordedAt: string; cars: TapeCar[] };

const AGENT_RATE = 24000;
const TAPE_RATE = 16000;

/**
 * Only what the handlers use. Partial turns never reach attribution, agent text deltas
 * are not drawn, and the session's echoed configuration is the same every time.
 */
function keep(ear: "agent" | "room", event: VoiceAgentEvent | SttEvent): VoiceAgentEvent | SttEvent | null {
  if (ear === "room") {
    if (event.type === "Turn") return (event as SttTurn).end_of_turn ? event : null;
    return event.type === "SpeakerRevision" ? event : null;
  }
  if (event.type === "transcript.agent.delta" || event.type === "session.updated") return null;
  if (event.type === "session.ready") return { type: "session.ready", session_id: (event as { session_id: string }).session_id };
  return event;
}

export class TapeRecorder {
  private cars: TapeCar[] = [];
  private car: (Omit<TapeCar, "events"> & { t0: number; events: RecordedEvent[] }) | null = null;

  /** A car pulled up: everything from here is timed against this moment. */
  startCar(at = performance.now()) {
    this.finishCar();
    this.car = { scenarioId: "", roomStartedAt: 0, events: [], durationMs: 0, t0: at };
  }

  roomStarted(at = performance.now()) {
    if (this.car) this.car.roomStartedAt = Math.round(at - this.car.t0);
  }

  scenario(id: string) {
    if (this.car) this.car.scenarioId = id;
  }

  agent(event: VoiceAgentEvent) {
    if (!this.car) return;
    if (event.type === "reply.audio") {
      this.voice(base64ToBytes((event as { data: string }).data));
      return;
    }
    const kept = keep("agent", event);
    if (kept) this.car.events.push({ t: this.now(), ear: "agent", event: kept as VoiceAgentEvent });
  }

  room(event: SttEvent) {
    const kept = this.car && keep("room", event);
    if (this.car && kept) this.car.events.push({ t: this.now(), ear: "room", event: kept as SttEvent });
  }

  clip(step: number) {
    if (this.car) this.car.events.push({ t: this.now(), ear: "clip", step });
  }

  /** Agent audio arrives in bursts of small chunks; a burst is kept as one event. */
  private voice(pcm24: Uint8Array) {
    if (!this.car) return;
    const t = this.now();
    const last = this.car.events[this.car.events.length - 1];
    const bytes = encodeVoice(pcm24);
    if (last?.ear === "voice" && t - last.t < 40) last.chunks.push(bytes);
    else this.car.events.push({ t, ear: "voice", chunks: [bytes] });
  }

  private now() {
    return this.car ? Math.round(performance.now() - this.car.t0) : 0;
  }

  /** Cars that never played a scenario — the lane idling before the first test — are left out. */
  finishCar() {
    if (!this.car) return;
    const { scenarioId, roomStartedAt, events } = this.car;
    this.car = null;
    if (!scenarioId) return;
    const packed = events.map((e): TapeEvent =>
      e.ear === "voice" ? { t: e.t, ear: "voice", data: bytesToBase64(join(e.chunks).buffer) } : e,
    );
    const trimmed = trimSilences(packed, roomStartedAt);
    this.cars.push({ scenarioId, roomStartedAt, events: trimmed, durationMs: trimmed[trimmed.length - 1]?.t ?? 0 });
  }

  tape(): Tape {
    this.finishCar();
    return { version: 1, recordedAt: new Date().toISOString(), cars: this.cars };
  }
}

type RecordedEvent = Exclude<TapeEvent, { ear: "voice" }> | { t: number; ear: "voice"; chunks: Uint8Array[] };

/**
 * Silences where nothing at all happens — the lane idling before the first line, or
 * after the last one until somebody ended the call — are cut to a beat, so a replay is
 * all conversation. Nothing inside a conversation is that quiet: a pause that long is
 * never between a customer and the agent's answer, so reply latency is untouched.
 *
 * Everything after a cut moves up with it, including the room ear's word timings. Those
 * count from the start of the stream, and a word left behind would fall outside the
 * window attribution looks in.
 */
export function trimSilences(events: TapeEvent[], roomStartedAt: number, longest = 3000, keep = 1500): TapeEvent[] {
  const cuts: { at: number; by: number }[] = [];
  const shiftFor = (streamMs: number) => cuts.reduce((n, cut) => (streamMs > cut.at ? n + cut.by : n), 0);
  const moveWords = (words: SttWord[] | undefined) =>
    words?.map((w) => ({ ...w, start: w.start - shiftFor(w.start), end: w.end - shiftFor(w.start) }));

  let shift = 0;
  return events.map((e, i) => {
    const gap = i > 0 ? e.t - events[i - 1].t : 0;
    if (gap > longest) {
      // Stream time runs roomStartedAt behind car time.
      cuts.push({ at: events[i - 1].t - roomStartedAt, by: gap - keep });
      shift += gap - keep;
    }
    const t = e.t - shift;
    if (e.ear !== "room" || !cuts.length) return { ...e, t };

    if (e.event.type === "Turn") {
      const turn = e.event as SttTurn;
      return { ...e, t, event: { ...turn, words: moveWords(turn.words) } };
    }
    const revision = e.event as unknown as SpeakerRevision;
    const revisions = revision.revisions?.map((r) => ({ ...r, words: moveWords(r.words) }));
    return { ...e, t, event: { ...revision, revisions } as unknown as SttEvent };
  });
}

function join(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 24 kHz PCM16 → 16 kHz μ-law: a third of the size, still clearly the agent's voice. */
export function encodeVoice(pcm24: Uint8Array): Uint8Array {
  const view = new DataView(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength);
  const n = pcm24.byteLength >> 1;
  const sample = (i: number) => view.getInt16(Math.min(n - 1, Math.max(0, i)) * 2, true);
  // A little smoothing before dropping a third of the samples keeps the highs from folding back.
  const smooth = (i: number) => (sample(i - 1) + 2 * sample(i) + sample(i + 1)) / 4;
  const out = new Uint8Array(Math.floor((n * TAPE_RATE) / AGENT_RATE));
  for (let i = 0; i < out.length; i++) {
    const at = (i * AGENT_RATE) / TAPE_RATE;
    const j = Math.floor(at);
    const a = smooth(j);
    out[i] = muLawEncode(a + (smooth(j + 1) - a) * (at - j));
  }
  return out;
}

/** The inverse, back to the 24 kHz PCM16 base64 that `reply.audio` carries. */
export function decodeVoice(data: string): string {
  const mu = base64ToBytes(data);
  const n = Math.floor((mu.length * AGENT_RATE) / TAPE_RATE);
  const out = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) {
    const at = (i * TAPE_RATE) / AGENT_RATE;
    const j = Math.floor(at);
    const a = muLawDecode(mu[Math.min(j, mu.length - 1)]);
    const b = muLawDecode(mu[Math.min(j + 1, mu.length - 1)]);
    out.setInt16(i * 2, Math.round(a + (b - a) * (at - j)), true);
  }
  return bytesToBase64(out.buffer);
}

const BIAS = 0x84;
const CLIP = 32635;

/** G.711 μ-law: 8 bits a sample, the telephone standard. */
function muLawEncode(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(CLIP, Math.abs(Math.round(sample))) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  s = sign | (exponent << 4) | mantissa;
  return ~s & 0xff;
}

function muLawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const sample = (((u & 0x0f) << 3) + BIAS) << exponent;
  return u & 0x80 ? BIAS - sample : sample - BIAS;
}
