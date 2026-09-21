import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesToBase64 } from "../src/lib/audio";
import { isAudibleReply, speechEndSample } from "../src/lib/replyTiming";

/**
 * Reply latency is what a customer hears: from their last word to the agent's first
 * audible one. The Voice Agent API streams silent frames from the moment it decides to
 * reply — through a whole tool call — and a scripted clip ends with silence of its own,
 * so both ends of the clock are read from the audio.
 */

const RATE = 24000;

const pcm = (parts: { ms: number; amplitude: number }[]) => {
  const total = parts.reduce((n, p) => n + Math.round((RATE * p.ms) / 1000), 0);
  const out = new Int16Array(total);
  let i = 0;
  for (const p of parts) {
    const n = Math.round((RATE * p.ms) / 1000);
    for (let k = 0; k < n; k++, i++) out[i] = Math.round(p.amplitude * 32767 * Math.sin((2 * Math.PI * 220 * k) / RATE));
  }
  return out;
};

const asReplyAudio = (samples: Int16Array) =>
  bytesToBase64(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer);

describe("timing a reply", () => {
  test("the silent frames a reply opens with are not the reply", () => {
    assert.equal(isAudibleReply(asReplyAudio(new Int16Array(960))), false, "digital silence");
    assert.equal(isAudibleReply(asReplyAudio(pcm([{ ms: 40, amplitude: 0.001 }]))), false, "a hiss is not a word");
    assert.equal(isAudibleReply(asReplyAudio(pcm([{ ms: 40, amplitude: 0.2 }]))), true, "speech is");
  });

  test("a frame that starts silent and then speaks counts as heard", () => {
    const onset = pcm([
      { ms: 30, amplitude: 0 },
      { ms: 10, amplitude: 0.2 },
    ]);
    assert.equal(isAudibleReply(asReplyAudio(onset)), true);
  });

  test("a line stops at its last word, not at the end of the file", () => {
    const clip = pcm([
      { ms: 300, amplitude: 0 },
      { ms: 1200, amplitude: 0.2 },
      { ms: 600, amplitude: 0 },
    ]);
    const endMs = (speechEndSample(clip, RATE) / RATE) * 1000;
    assert.ok(endMs >= 1480 && endMs <= 1520, `speech ends at ${endMs} ms, the file at 2100 ms`);
  });

  test("a clip with no silence at the end ends where the file does, and silence ends at once", () => {
    const allSpeech = pcm([{ ms: 500, amplitude: 0.2 }]);
    assert.equal(speechEndSample(allSpeech, RATE), allSpeech.length);
    assert.equal(speechEndSample(new Int16Array(RATE), RATE), 0);
  });
});
