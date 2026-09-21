import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS } from "../src/lib/scenarios";
import { SAMPLE_RATE, synthesize } from "./tts";
import { encodeWav, resample } from "./wav";

/**
 * Generates the audio for the in-page regression tests, from the same AssemblyAI
 * voices the offline bench uses.
 *
 * This is what lets a judge reproduce a whole car alone at a laptop: no second
 * person, no recording session, and the same audio on every machine.
 *
 *   npm run clips
 */

async function main() {
  const dir = resolve(process.cwd(), "public/clips");
  mkdirSync(dir, { recursive: true });

  let count = 0;
  for (const scenario of SCENARIOS) {
    for (const [index, step] of scenario.steps.entries()) {
      const file = `${scenario.id}-${index}.wav`;
      process.stdout.write(`  ${file.padEnd(20)} ${step.voice.padEnd(9)} ${step.text.slice(0, 52)}… `);
      const raw = await synthesize(step.text, step.voice, step.pitch ?? 1);
      const pcm = step.pitch && step.pitch !== 1 ? resample(raw, SAMPLE_RATE, SAMPLE_RATE, step.pitch) : raw;
      writeFileSync(resolve(dir, file), encodeWav(pcm, SAMPLE_RATE));
      console.log(`${(pcm.length / SAMPLE_RATE).toFixed(1)}s`);
      count++;
    }
  }

  console.log(`\n${count} clips written to public/clips/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
