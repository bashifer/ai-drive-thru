/** Minimal mono 16-bit PCM WAV reader/writer — no dependencies. */

export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.from(samples.buffer, samples.byteOffset, dataBytes);
  return Buffer.concat([header, body]);
}

export function decodeWav(buf: Buffer): { samples: Int16Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let channels = 1;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bitsPerSample = body.readUInt16LE(14);
    } else if (id === "data") {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error("WAV has no data chunk");
  if (bitsPerSample !== 16) throw new Error(`Only 16-bit WAV supported, got ${bitsPerSample}`);

  const interleaved = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  if (channels === 1) return { samples: Int16Array.from(interleaved), sampleRate };

  const mono = new Int16Array(Math.floor(interleaved.length / channels));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c];
    mono[i] = Math.round(sum / channels);
  }
  return { samples: mono, sampleRate };
}

/** Linear resample, good enough for speech. `rate` > 1 also raises pitch. */
export function resample(samples: Int16Array, from: number, to: number, rate = 1): Int16Array {
  const ratio = (from / to) * rate;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[idx + 1] ?? a;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac)));
  }
  return out;
}
