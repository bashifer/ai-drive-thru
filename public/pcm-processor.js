// AudioWorklet: captures mic audio and emits two PCM16 streams from one pass.
//
//   agent -> 24 kHz PCM16 for the Voice Agent API (wss://agents.assemblyai.com/v1/ws)
//   stt   -> 16 kHz PCM16 for the diarization side-channel (wss://streaming.assemblyai.com/v3/ws)
//
// The AudioContext runs at the device rate (required for echo cancellation on
// Firefox, and Safari ignores a forced rate anyway), so resampling happens here.

class LinearResampler {
  constructor(ratio, chunkSamples) {
    this.ratio = ratio; // input samples consumed per output sample
    this.phase = 0;
    this.buf = new Int16Array(chunkSamples);
    this.n = 0;
  }

  push(input, emit) {
    let p = this.phase;
    while (p < input.length) {
      const i = Math.floor(p);
      const frac = p - i;
      const s0 = input[i];
      const s1 = i + 1 < input.length ? input[i + 1] : s0;
      const s = s0 + (s1 - s0) * frac;
      this.buf[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.n === this.buf.length) {
        emit(this.buf.slice().buffer);
        this.n = 0;
      }
      p += this.ratio;
    }
    // Carry the fractional position over to the next render quantum.
    this.phase = p - input.length;
  }
}

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    const inRate = opts.inputSampleRate || sampleRate;
    const agentRate = opts.agentSampleRate || 24000;
    const sttRate = opts.sttSampleRate || 16000;
    const chunkMs = opts.chunkMs || 50;

    this.agent = new LinearResampler(inRate / agentRate, Math.round((agentRate * chunkMs) / 1000));
    this.stt = new LinearResampler(inRate / sttRate, Math.round((sttRate * chunkMs) / 1000));
    this.muted = false;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "mute") this.muted = !!e.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.muted) return true;

    this.agent.push(input, (buf) => this.port.postMessage({ kind: "agent", buf }, [buf]));
    this.stt.push(input, (buf) => this.port.postMessage({ kind: "stt", buf }, [buf]));
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
