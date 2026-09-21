import { base64ToBytes } from "./audio";

/**
 * Reply latency is what a customer hears: from their last word to the agent's first
 * audible one. Neither end is an event.
 *
 * The Voice Agent API starts streaming `reply.audio` the moment it decides to reply, and
 * until the words are ready those frames are digital silence — through a whole tool call,
 * for seconds. Timing the first frame measured the decision, not the answer (the bench
 * reported p50 188 ms that way). And a scripted clip ends with silence of its own, so the
 * end of the file is not the end of the customer's sentence either.
 */

/** About −50 dBFS: below this a frame carries no speech. */
const AUDIBLE_RMS = 0.003;
const WINDOW_MS = 10;

function rms(samples: Int16Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Whether a `reply.audio` payload (PCM16, base64) has anything in it a customer would hear. */
export function isAudibleReply(base64: string): boolean {
  const bytes = base64ToBytes(base64);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  return rms(samples) > AUDIBLE_RMS;
}

/** The sample just past the last window with speech in it: where a line really stops. */
export function speechEndSample(samples: Int16Array, rate: number): number {
  const window = Math.max(1, Math.round((rate * WINDOW_MS) / 1000));
  for (let start = Math.floor((samples.length - 1) / window) * window; start >= 0; start -= window) {
    const end = Math.min(samples.length, start + window);
    if (rms(samples, start, end) > AUDIBLE_RMS) return end;
  }
  return 0;
}
