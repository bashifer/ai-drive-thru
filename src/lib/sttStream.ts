"use client";

/**
 * The "room ear": Universal-3.5 Pro streaming with speaker_labels.
 *
 * The Voice Agent API runs the conversation but does not tell us *who* spoke.
 * This second stream listens to the same microphone with real-time diarization,
 * so every word carries a speaker, and the order engine can tell the driver from
 * the kid in the back seat (or a voice bleeding in from the next lane).
 *
 * No voice_focus here on purpose: the focused ear suppresses background voices,
 * this one is supposed to hear them.
 */

export type SttWord = {
  text: string;
  start: number; // ms from stream start
  end: number;
  confidence?: number;
  word_is_final?: boolean;
  speaker?: string; // "A" | "B" | ... | "PENDING", final words only
};

export type SttTurn = {
  type: "Turn";
  turn_order: number;
  transcript: string;
  end_of_turn: boolean;
  turn_is_formatted?: boolean;
  end_of_turn_confidence?: number;
  speaker_label?: string;
  words?: SttWord[];
};

export type SttEvent =
  | { type: "Begin"; id: string; expires_at: number }
  | { type: "SpeechStarted"; timestamp: number; confidence?: number }
  | SttTurn
  | { type: "SpeakerRevision"; [key: string]: unknown }
  | { type: "Termination"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

const WS_URL = "wss://streaming.assemblyai.com/v3/ws";

export type SttOptions = {
  keyterms?: string[];
  agentContext?: string;
  maxSpeakers?: number;
};

export class SttDiarizationClient {
  private ws: WebSocket | null = null;
  private handler: (e: SttEvent) => void = () => {};
  private opened = false;

  sessionId: string | null = null;

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onEvent(handler: (e: SttEvent) => void) {
    this.handler = handler;
  }

  async connect(opts: SttOptions = {}) {
    const res = await fetch("/api/stt-token", { cache: "no-store" });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error ?? "Could not mint a streaming token");

    const url = new URL(WS_URL);
    url.searchParams.set("token", payload.token);
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set("speech_model", "universal-3-5-pro");
    url.searchParams.set("speaker_labels", "true");
    url.searchParams.set("max_speakers", String(opts.maxSpeakers ?? 3));
    url.searchParams.set("format_turns", "true");
    if (opts.keyterms?.length) {
      url.searchParams.set("keyterms_prompt", JSON.stringify(opts.keyterms.slice(0, 100)));
    }
    if (opts.agentContext) {
      url.searchParams.set("agent_context", opts.agentContext);
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.opened = true;
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("Streaming STT WebSocket error")));
      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let msg: SttEvent;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "Begin") this.sessionId = (msg as { id: string }).id;
        this.handler(msg);
      });
      ws.addEventListener("close", () => {
        this.opened = false;
        this.handler({ type: "connection.closed" });
      });
    });
  }

  /** Raw PCM16 @16 kHz as a binary frame — no JSON, no base64. */
  sendAudio(buf: ArrayBuffer) {
    if (!this.opened || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(buf);
  }

  /**
   * Feed the agent's last spoken reply back to the model. Universal-3.5 Pro uses
   * both sides of the dialog when transcribing the next turn, which is what makes
   * short answers ("large", "no pickles", "yeah") land correctly.
   */
  setAgentContext(text: string) {
    if (this.ws?.readyState !== WebSocket.OPEN || !text.trim()) return;
    this.ws.send(JSON.stringify({ type: "UpdateConfiguration", agent_context: text.slice(0, 1700) }));
  }

  setKeyterms(keyterms: string[]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: "UpdateConfiguration", keyterms_prompt: keyterms.slice(0, 100) }),
    );
  }

  /**
   * Terminate and wait for the tail.
   *
   * The end-of-session refinement pass — the one that corrects speaker labels it got
   * wrong live — arrives *after* Terminate and before Termination. Closing the socket
   * straight away throws away both that and the last transcript.
   */
  async close(waitMs = 2500): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.ws?.close();
      this.opened = false;
      return;
    }

    const socket = this.ws;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data === "string" && event.data.includes('"Termination"')) done();
      };
      const timer = setTimeout(done, waitMs);
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ type: "Terminate" }));
    });

    socket.close();
    this.opened = false;
  }
}
