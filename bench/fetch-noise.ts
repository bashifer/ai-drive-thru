import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeWav, encodeWav, resample } from "./wav";

/**
 * Real recorded noise for the benchmark.
 *
 * The synthetic rumble the bench generates is repeatable and costs nothing, but it
 * is not a car, and babble made of our own TTS is not a room full of people. These
 * beds are real recordings, so "engine +5 dB" stops being a plausible condition and
 * becomes a measured one.
 *
 * Primary source: Microsoft's MS-SNSD noise set (MIT licence, on GitHub) — a car
 * interior, street traffic, a restaurant, and twelve recordings of human babble.
 * DEMAND (CC BY 4.0, Zenodo 1227121) is richer and can be used instead, but Zenodo
 * rate-limits whole networks; pass a downloaded archive with --demand <path>.
 *
 * Nothing fetched here is committed: bench/data/ is gitignored.
 *
 *   npm run fetch:noise                  # car, traffic, babble
 *   npm run fetch:noise -- restaurant
 *   npm run fetch:noise -- --demand ~/Downloads/TCAR_16k.zip
 */

const MS_SNSD = "https://raw.githubusercontent.com/microsoft/MS-SNSD/master/noise_train";
const TARGET_RATE = 24000;

/** Each bed is one or more source recordings, concatenated into a loopable file. */
const BEDS: Record<string, { files: string[]; about: string }> = {
  car: { files: ["Car_1.wav"], about: "a car interior" },
  traffic: { files: ["Traffic_1.wav"], about: "street traffic" },
  babble: { files: ["Babble_1.wav", "Babble_2.wav", "Babble_8.wav"], about: "people talking nearby" },
  restaurant: { files: ["Restaurant_1.wav"], about: "a restaurant room" },
  station: { files: ["Station_1.wav"], about: "a station concourse" },
};

const dataDir = resolve(process.cwd(), "bench/data/noise");

export const noisePath = (name: string) => resolve(dataDir, `${name}.wav`);

/** Load a prepared noise bed, or null when it has not been fetched. */
export function loadNoiseBed(name: string): Int16Array | null {
  const file = noisePath(name);
  if (!existsSync(file)) return null;
  try {
    return decodeWav(readFileSync(file)).samples;
  } catch {
    return null;
  }
}

export const NOISE_BEDS = Object.keys(BEDS);

async function fetchWav(url: string): Promise<Int16Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const { samples, sampleRate } = decodeWav(Buffer.from(await res.arrayBuffer()));
  return sampleRate === TARGET_RATE ? samples : resample(samples, sampleRate, TARGET_RATE);
}

async function buildBed(name: string) {
  const bed = BEDS[name];
  if (!bed) throw new Error(`Unknown bed "${name}". Known: ${NOISE_BEDS.join(", ")}`);

  const out = noisePath(name);
  if (existsSync(out)) {
    console.log(`  ${name.padEnd(11)} already prepared (${Math.round(statSync(out).size / 1e6)} MB)`);
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  process.stdout.write(`  ${name.padEnd(11)} fetching ${bed.files.length} recording(s)… `);

  const parts: Int16Array[] = [];
  for (const file of bed.files) parts.push(await fetchWav(`${MS_SNSD}/${file}`));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  writeFileSync(out, encodeWav(joined, TARGET_RATE));
  console.log(`${(joined.length / TARGET_RATE).toFixed(0)}s of ${bed.about}, ready`);
}

/** Prepare a bed from a DEMAND archive the user downloaded themselves. */
function buildFromDemand(archive: string, name: string) {
  mkdirSync(dataDir, { recursive: true });
  const raw = resolve(dataDir, `${name}-ch01.wav`);

  if (process.platform === "win32") {
    const script = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::OpenRead('${archive.replace(/'/g, "''")}')
      $entry = $zip.Entries | Where-Object { $_.Name -eq 'ch01.wav' } | Select-Object -First 1
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '${raw.replace(/'/g, "''")}', $true)
      $zip.Dispose()
    `;
    execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "pipe" });
  } else {
    execFileSync("unzip", ["-o", "-j", archive, "*/ch01.wav", "-d", dataDir], { stdio: "pipe" });
  }

  const { samples, sampleRate } = decodeWav(readFileSync(raw));
  const bed = sampleRate === TARGET_RATE ? samples : resample(samples, sampleRate, TARGET_RATE);
  writeFileSync(noisePath(name), encodeWav(bed, TARGET_RATE));
  rmSync(raw, { force: true });
  console.log(`  ${name.padEnd(11)} ${(bed.length / TARGET_RATE).toFixed(0)}s from DEMAND, ready`);
}

async function main() {
  const argv = process.argv.slice(2);
  const demandAt = argv.indexOf("--demand");

  if (demandAt !== -1) {
    const archive = argv[demandAt + 1];
    const name = argv[demandAt + 2] ?? "car";
    if (!archive) throw new Error("--demand needs the path to a DEMAND archive, e.g. TCAR_16k.zip");
    console.log("DEMAND (Thiemann, Ito & Vincent) — CC BY 4.0, Zenodo record 1227121\n");
    buildFromDemand(resolve(archive), name);
    return;
  }

  const names = argv.filter((a) => !a.startsWith("-"));
  console.log("MS-SNSD noise set (Microsoft) — MIT licence\n");
  for (const name of names.length ? names : ["car", "traffic", "babble"]) await buildBed(name);
  console.log("\nPrepared in bench/data/noise/. Scenes asking for real noise will use it.");
}

if (process.argv[1]?.endsWith("fetch-noise.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
