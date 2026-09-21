import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { base64ToInt16, connectVoiceAgent } from "./aai";
import { decodeWav, encodeWav } from "./wav";

/**
 * Scene voices come from AssemblyAI's own TTS: a Voice Agent session is opened with
 * the line as its `greeting`, the spoken audio is captured and cached as a WAV.
 *
 * That gives the bench a dozen distinct, consistent speaker identities with no extra
 * vendor, no licence question about redistributing someone's corpus, and voices the
 * diarization model has never been tuned on any differently than a human's.
 */

export const SAMPLE_RATE = 24000;
const CACHE_DIR = resolve(process.cwd(), "bench/cache");

const cachePath = (text: string, voice: string, pitch: number) => {
  const hash = createHash("sha1").update(`${voice}|${pitch}|${text}`).digest("hex").slice(0, 12);
  return resolve(CACHE_DIR, `${voice}-${pitch}-${hash}.wav`);
};

export async function synthesize(text: string, voice: string, pitch = 1): Promise<Int16Array> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(text, voice, pitch);
  if (existsSync(file)) return decodeWav(readFileSync(file)).samples;

  const ws = await connectVoiceAgent();
  const chunks: Int16Array[] = [];

  const audio = await new Promise<Int16Array>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`TTS timeout for "${text.slice(0, 40)}"`)), 45000);

    ws.on("message", (raw: Buffer) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "reply.audio") {
        chunks.push(base64ToInt16(msg.data as string));
      } else if (msg.type === "reply.done" || msg.type === "transcript.agent") {
        if (msg.type !== "reply.done") return;
        clearTimeout(timer);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Int16Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        res(out);
      } else if (msg.type === "session.error") {
        clearTimeout(timer);
        rej(new Error(`TTS session error: ${msg.code} ${msg.message}`));
      }
    });

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // The greeting is spoken verbatim on connect; the agent never gets a turn.
          greeting: text,
          system_prompt: "Stay silent. Do not speak unless spoken to.",
          input: { format: { encoding: "audio/pcm" } },
          output: { voice, format: { encoding: "audio/pcm" } },
        },
      }),
    );
  }).finally(() => {
    try {
      ws.send(JSON.stringify({ type: "session.end" }));
    } catch {
      /* socket may already be gone */
    }
    setTimeout(() => ws.close(), 200);
  });

  if (!audio.length) throw new Error(`TTS produced no audio for "${text.slice(0, 40)}"`);
  writeFileSync(file, encodeWav(audio, SAMPLE_RATE));
  return audio;
}

/** Pre-generate every line in the scene book so a bench run has no cold start. */
async function warmCache() {
  const { SCENES } = await import("./scenes");
  const lines = SCENES.flatMap((s) => s.utterances.map((u) => ({ text: u.text, voice: u.voice, pitch: u.pitch ?? 1 })));
  const unique = new Map(lines.map((l) => [`${l.voice}|${l.pitch}|${l.text}`, l]));
  console.log(`Synthesising ${unique.size} unique lines…`);
  let i = 0;
  for (const line of unique.values()) {
    process.stdout.write(`  [${++i}/${unique.size}] ${line.voice}: ${line.text.slice(0, 56)}… `);
    const pcm = await synthesize(line.text, line.voice, line.pitch);
    console.log(`${(pcm.length / SAMPLE_RATE).toFixed(1)}s`);
  }
  console.log("Cached in bench/cache/");
}

if (process.argv[1]?.endsWith("tts.ts")) {
  warmCache().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
