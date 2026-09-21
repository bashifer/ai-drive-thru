"use client";

/**
 * Browser audio plumbing for Backseat.
 *
 * One capture graph feeds two ears:
 *   - 24 kHz PCM16 -> Voice Agent API (the conversation)
 *   - 16 kHz PCM16 -> Streaming STT with speaker_labels (the room)
 *
 * Injected scenario clips (engine noise, a kid in the back seat, the next lane)
 * are mixed into the same bus, so a judge alone at a laptop can reproduce every
 * demo moment. They are mixed *after* the browser's echo canceller, which is why
 * a clip played through the speakers still reaches the models as clean audio.
 */

export type PcmKind = "agent" | "stt";
export type ChunkHandler = (kind: PcmKind, buf: ArrayBuffer) => void;

export const AGENT_SAMPLE_RATE = 24000;
export const STT_SAMPLE_RATE = 16000;

export type InjectedClip = {
  id: string;
  label: string;
  url: string;
  gain?: number;
  loop?: boolean;
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private captureBus: GainNode | null = null;
  private playbackGain: GainNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();
  private clipCache = new Map<string, AudioBuffer>();
  private playHead = 0;
  private onChunk: ChunkHandler | null = null;
  /** True when the lane is running on injected audio only. */
  micDenied = false;

  get running() {
    return this.ctx !== null;
  }

  get contextSampleRate() {
    return this.ctx?.sampleRate ?? 0;
  }

  /** True while agent speech is still scheduled to play. */
  get speaking() {
    return this.ctx !== null && this.playHead > this.ctx.currentTime + 0.02;
  }

  async start(onChunk: ChunkHandler, opts: { microphone?: boolean } = {}) {
    if (this.ctx) return;
    this.onChunk = onChunk;
    this.micDenied = false;

    // Default rate: forcing 24 kHz breaks echo cancellation on Firefox and is
    // silently ignored by Safari. The worklet resamples instead.
    const ctx = new AudioContext();
    await ctx.resume();
    await ctx.audioWorklet.addModule("/pcm-processor.js");

    // A judge who declines the microphone can still run the scripted scenarios: the
    // clips are mixed into the same bus, so the lane works on injected audio alone.
    let stream: MediaStream | null = null;
    if (opts.microphone !== false) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: false, // Voice Focus does this server-side, stacking hurts accuracy
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch {
        this.micDenied = true;
      }
    } else {
      this.micDenied = true;
    }

    const captureBus = ctx.createGain();
    captureBus.gain.value = 1;

    const worklet = new AudioWorkletNode(ctx, "pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        inputSampleRate: ctx.sampleRate,
        agentSampleRate: AGENT_SAMPLE_RATE,
        sttSampleRate: STT_SAMPLE_RATE,
        chunkMs: 50,
      },
    });

    worklet.port.onmessage = (e: MessageEvent) => {
      const { kind, buf } = e.data as { kind: PcmKind; buf: ArrayBuffer };
      this.onChunk?.(kind, buf);
    };

    // Keep the worklet pulled by the graph without routing mic audio to speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;

    if (stream) ctx.createMediaStreamSource(stream).connect(captureBus);
    captureBus.connect(worklet);
    worklet.connect(sink).connect(ctx.destination);

    const playbackGain = ctx.createGain();
    playbackGain.gain.value = 1;
    playbackGain.connect(ctx.destination);

    this.ctx = ctx;
    this.stream = stream;
    this.worklet = worklet;
    this.captureBus = captureBus;
    this.playbackGain = playbackGain;
    this.playHead = ctx.currentTime;
  }

  /** Queue a base64 PCM16 @24 kHz chunk from the agent. */
  playPcm24(base64: string) {
    const ctx = this.ctx;
    if (!ctx || !this.playbackGain) return;

    const bytes = base64ToBytes(base64);
    const samples = bytes.byteLength >> 1;
    if (samples === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const float = new Float32Array(samples);
    for (let i = 0; i < samples; i++) float[i] = view.getInt16(i * 2, true) / 32768;

    const buffer = ctx.createBuffer(1, samples, AGENT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackGain);

    const startAt = Math.max(this.playHead, ctx.currentTime + 0.02);
    src.start(startAt);
    this.playHead = startAt + buffer.duration;

    this.activeSources.add(src);
    src.onended = () => this.activeSources.delete(src);
  }

  /** Barge-in: drop everything the customer has not heard yet. */
  flushPlayback() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    if (this.ctx) this.playHead = this.ctx.currentTime;
  }

  setMuted(muted: boolean) {
    this.worklet?.port.postMessage({ type: "mute", value: muted });
  }

  private async loadClip(url: string) {
    const cached = this.clipCache.get(url);
    if (cached) return cached;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Clip ${url} failed: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await this.ctx!.decodeAudioData(arr);
    this.clipCache.set(url, buf);
    return buf;
  }

  /** Fetch and decode a clip ahead of time, so it starts on the beat when it is played. */
  async preload(url: string) {
    if (this.ctx) await this.loadClip(url);
  }

  /** Mix a scenario clip into the mic bus (and the speakers) once. */
  async playClip(clip: InjectedClip) {
    const ctx = this.ctx;
    if (!ctx || !this.playbackGain || !this.captureBus) return;
    const buffer = await this.loadClip(clip.url);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = clip.gain ?? 1;
    src.connect(gain);
    gain.connect(this.captureBus); // what the models hear
    gain.connect(this.playbackGain); // what the room hears
    src.start();
    return new Promise<void>((resolve) => {
      src.onended = () => resolve();
    });
  }

  /** Start/stop a looping background clip (engine noise, radio). */
  async toggleLoop(clip: InjectedClip) {
    const ctx = this.ctx;
    if (!ctx || !this.playbackGain || !this.captureBus) return false;

    const existing = this.loops.get(clip.id);
    if (existing) {
      try {
        existing.src.stop();
      } catch {
        /* already stopped */
      }
      this.loops.delete(clip.id);
      return false;
    }

    const buffer = await this.loadClip(clip.url);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = clip.gain ?? 0.5;
    src.connect(gain);
    gain.connect(this.captureBus);
    gain.connect(this.playbackGain);
    src.start();
    this.loops.set(clip.id, { src, gain });
    return true;
  }

  /**
   * Synthetic background noise (no asset needed): filtered brown noise reads as
   * engine rumble through a drive-thru speaker, which is exactly what far-field
   * Voice Focus is for.
   */
  toggleNoise(id: string, gain = 0.18): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.captureBus || !this.playbackGain) return false;

    const existing = this.loops.get(id);
    if (existing) {
      try {
        existing.src.stop();
      } catch {
        /* already stopped */
      }
      this.loops.delete(id);
      return false;
    }

    const seconds = 4;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown-ish
      data[i] = last * 3.5;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 480;

    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;

    src.connect(lp).connect(gainNode);
    gainNode.connect(this.captureBus);
    gainNode.connect(this.playbackGain);
    src.start();
    this.loops.set(id, { src, gain: gainNode });
    return true;
  }

  async stop() {
    this.flushPlayback();
    for (const { src } of this.loops.values()) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.loops.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worklet?.disconnect();
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.worklet = null;
    this.captureBus = null;
    this.playbackGain = null;
    this.onChunk = null;
  }
}

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
