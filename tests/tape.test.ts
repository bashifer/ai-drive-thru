import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesToBase64, base64ToBytes } from "../src/lib/audio";
import { TapeRecorder, decodeVoice, encodeVoice, trimSilences, type TapeEvent } from "../src/lib/tape";

/**
 * The replay tape keeps what AssemblyAI said and nothing Backseat decided. These check
 * that what is kept is what the handlers need, and that the agent's voice survives the
 * squeeze into the tape.
 */

const tone = (ms: number, hz = 440, rate = 24000) => {
  const n = Math.round((rate * ms) / 1000);
  const view = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), true);
  return new Uint8Array(view.buffer);
};

describe("the replay tape", () => {
  test("the agent's voice comes back at its own rate, recognisably the same", () => {
    const original = tone(200);
    const back = base64ToBytes(decodeVoice(bytesToBase64(encodeVoice(original).buffer as ArrayBuffer)));
    assert.equal(back.length, original.length, "same duration at 24 kHz");

    const a = new DataView(original.buffer);
    const b = new DataView(back.buffer);
    let signal = 0;
    let error = 0;
    for (let i = 10; i < back.length / 2 - 10; i++) {
      const s = a.getInt16(i * 2, true);
      signal += s * s;
      error += (s - b.getInt16(i * 2, true)) ** 2;
    }
    const snrDb = 10 * Math.log10(signal / error);
    assert.ok(snrDb > 20, `signal-to-noise ${snrDb.toFixed(1)} dB`);
  });

  test("it keeps what the handlers use and drops what they never read", () => {
    const rec = new TapeRecorder();
    rec.startCar();
    rec.scenario("prank");
    rec.agent({ type: "session.ready", session_id: "sess_1", config: { system_prompt: "a very long prompt" } });
    rec.agent({ type: "session.updated", config: {} });
    rec.agent({ type: "transcript.agent.delta", reply_id: "r", item_id: "i", delta: "Wel", start_ms: null, end_ms: null });
    rec.agent({ type: "tool.call", call_id: "c1", name: "add_item", arguments: { item: "nuggets", quantity: 260 } });
    rec.room({ type: "Turn", turn_order: 0, transcript: "I want", end_of_turn: false, words: [{ text: "I", start: 0, end: 90 }] });
    rec.room({ type: "Turn", turn_order: 0, transcript: "I want 260", end_of_turn: false });
    rec.room({ type: "Turn", turn_order: 0, transcript: "I want 260 chicken nuggets.", end_of_turn: true, words: [] });
    rec.clip(0);

    const [car] = rec.tape().cars;
    const kinds = car.events.map((e) => (e.ear === "agent" || e.ear === "room" ? e.event.type : e.ear));
    assert.deepEqual(kinds, ["session.ready", "tool.call", "Turn", "Turn", "clip"]);
    assert.deepEqual((car.events[0] as { event: object }).event, { type: "session.ready", session_id: "sess_1" });
    // A held tool call waits while a turn is open, so the replay has to know when one
    // opened — once, without its words.
    assert.deepEqual((car.events[2] as { event: object }).event, {
      type: "Turn",
      turn_order: 0,
      transcript: "I want",
      end_of_turn: false,
    });
  });

  test("a burst of audio chunks is one event, and a car that never ran a test is not kept", () => {
    const rec = new TapeRecorder();
    rec.startCar();
    rec.agent({ type: "reply.audio", data: bytesToBase64(tone(50).buffer as ArrayBuffer) });
    rec.agent({ type: "reply.audio", data: bytesToBase64(tone(50).buffer as ArrayBuffer) });
    assert.equal(rec.tape().cars.length, 0, "the idle lane before the first test is not a car");

    rec.startCar();
    rec.scenario("backseat");
    rec.agent({ type: "reply.audio", data: bytesToBase64(tone(50).buffer as ArrayBuffer) });
    rec.agent({ type: "reply.audio", data: bytesToBase64(tone(50).buffer as ArrayBuffer) });
    const [car] = rec.tape().cars;
    assert.equal(car.events.length, 1);
    assert.equal(car.events[0].ear, "voice");
    // 100 ms of 24 kHz PCM16 is 4,800 bytes; as 16 kHz μ-law it is 1,600.
    assert.equal(base64ToBytes((car.events[0] as { data: string }).data).length, 1600);
  });
});

describe("cutting the silences out of a tape", () => {
  const turn = (text: string, startMs: number) => ({
    type: "Turn" as const,
    turn_order: startMs,
    transcript: text,
    end_of_turn: true,
    words: [{ text, start: startMs, end: startMs + 400, speaker: "A", word_is_final: true }],
  });

  test("a long idle gap shrinks to a beat, and the words after it move with it", () => {
    // The room ear's stream started 1 s into the car, so stream time is car time − 1000.
    const events: TapeEvent[] = [
      { t: 2000, ear: "room", event: turn("first", 500) },
      { t: 2100, ear: "agent", event: { type: "reply.done", reply_id: "r1", status: "completed" } },
      // Twelve seconds of nobody saying anything.
      { t: 14100, ear: "clip", step: 1 },
      { t: 16000, ear: "room", event: turn("second", 13500) },
    ];
    const out = trimSilences(events, 1000);

    assert.deepEqual(out.map((e) => e.t), [2000, 2100, 3600, 5500]);
    const words = (i: number) => ((out[i] as { event: { words: { start: number }[] } }).event.words[0].start);
    assert.equal(words(0), 500, "before the cut, untouched");
    assert.equal(words(3), 13500 - 10500, "after the cut, moved up by the same 10.5 s");
  });

  test("a revision at the end moves only the words that came after the cut", () => {
    const events: TapeEvent[] = [
      { t: 2000, ear: "room", event: turn("first", 500) },
      { t: 20000, ear: "room", event: {
        type: "SpeakerRevision",
        revisions: [
          { turn_order: 500, speaker_label: "B", words: [{ text: "first", start: 500, end: 900, speaker: "B" }] },
        ],
      } },
    ];
    const out = trimSilences(events, 1000);
    const revised = (out[1] as unknown as { event: { revisions: { words: { start: number }[] }[] } }).event.revisions[0]
      .words[0];
    assert.equal(revised.start, 500, "the revised word was spoken before the silence");
    assert.equal(out[1].t, 3500);
  });

  test("a conversation with no long silence comes back exactly as it went in", () => {
    const events: TapeEvent[] = [
      { t: 1000, ear: "clip", step: 0 },
      { t: 3500, ear: "room", event: turn("hello", 2000) },
      { t: 5000, ear: "agent", event: { type: "reply.done", reply_id: "r", status: "completed" } },
    ];
    assert.deepEqual(trimSilences(events, 1000), events);
  });
});
