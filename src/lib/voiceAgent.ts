"use client";

import { bytesToBase64 } from "./audio";

export type ToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execution_mode?: "interactive" | "hold";
  timeout_seconds?: number;
  response_instructions?: { success?: string; error?: string };
};

export type SessionConfig = {
  system_prompt?: string;
  greeting?: string;
  tools?: ToolDef[];
  input?: {
    format?: { encoding: string };
    keyterms?: string[];
    transcription_mode?: "min_latency" | "balanced" | "max_accuracy";
    transcription_prompt?: string;
    language_codes?: string[];
    voice_focus?: "near-field" | "far-field";
    voice_focus_threshold?: number;
    turn_detection?: {
      vad_threshold?: number;
      min_silence?: number;
      max_silence?: number;
      interrupt_response?: boolean;
      interruption_delay?: number;
    };
  };
  output?: {
    voice?: string;
    format?: { encoding: string };
    volume?: number;
  };
};

export type VoiceAgentEvent =
  | { type: "session.ready"; session_id: string; expires_at?: number; config?: unknown }
  | { type: "session.updated"; config?: unknown }
  | { type: "session.ended"; session_duration_seconds?: number; audio_duration_seconds?: number }
  | { type: "input.speech.started" }
  | { type: "input.speech.stopped" }
  | { type: "transcript.user.delta"; item_id: string; text: string }
  | { type: "transcript.user"; item_id: string; text: string }
  | { type: "reply.started"; reply_id: string; item_id: string }
  | { type: "reply.audio"; data: string }
  | {
      type: "transcript.agent.delta";
      reply_id: string;
      item_id: string;
      delta: string;
      start_ms: number | null;
      end_ms: number | null;
    }
  | { type: "transcript.agent"; text: string; reply_id: string; item_id: string; interrupted: boolean }
  | { type: "reply.done"; reply_id: string; status: "completed" | "interrupted" }
  | { type: "tool.call"; call_id: string; name: string; arguments: Record<string, unknown> }
  | { type: "session.error"; code: string; message: string; param?: string }
  | { type: string; [key: string]: unknown };

type PendingResult = { call_id: string; result: string; is_error: boolean };

const WS_URL = "wss://agents.assemblyai.com/v1/ws";

/**
 * Voice Agent API client: one WebSocket carrying speech-to-text (Universal-3.5 Pro),
 * the LLM, tool calls and TTS. This is the "focused ear" — the conversation itself.
 */
export class VoiceAgentClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private lastEventType: string | null = null;
  private pending: PendingResult[] = [];
  private handler: (e: VoiceAgentEvent) => void = () => {};

  sessionId: string | null = null;

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isReady() {
    return this.ready;
  }

  onEvent(handler: (e: VoiceAgentEvent) => void) {
    this.handler = handler;
  }

  async connect(session: SessionConfig) {
    const res = await fetch("/api/voice-token", { cache: "no-store" });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error ?? "Could not mint a Voice Agent token");

    const url = new URL(WS_URL);
    url.searchParams.set("token", payload.token);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "session.update", session }));
        resolve();
      });

      ws.addEventListener("error", () => reject(new Error("Voice Agent WebSocket error")));

      ws.addEventListener("message", (event) => {
        let msg: VoiceAgentEvent;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        this.route(msg);
      });

      ws.addEventListener("close", () => {
        this.ready = false;
        this.handler({ type: "connection.closed" });
      });
    });
  }

  private route(msg: VoiceAgentEvent) {
    this.lastEventType = msg.type;

    if (msg.type === "session.ready") {
      this.ready = true;
      this.sessionId = (msg as { session_id: string }).session_id;
    }

    if (msg.type === "reply.done") {
      const status = (msg as { status?: string }).status;
      if (status === "interrupted") {
        // The reply that asked for these tool calls is gone; its results are stale.
        this.pending = [];
      } else {
        this.flushToolResults();
      }
    }

    this.handler(msg);
  }

  /** Streams a 50 ms PCM16 @24 kHz chunk to the agent. */
  sendAudio(buf: ArrayBuffer) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "input.audio", audio: bytesToBase64(buf) }));
  }

  /**
   * Tool results must land when `reply.done` is the latest event: earlier and the
   * agent is still mid transition phrase, later and a new turn has started.
   */
  queueToolResult(callId: string, result: unknown, isError = false) {
    this.pending.push({
      call_id: callId,
      result: typeof result === "string" ? result : JSON.stringify(result),
      is_error: isError,
    });
    this.flushToolResults();
  }

  private flushToolResults() {
    if (this.lastEventType !== "reply.done" || this.pending.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const item of this.pending) {
      this.ws.send(JSON.stringify({ type: "tool.result", ...item }));
    }
    this.pending = [];
  }

  /** Mutable mid-session: system_prompt, keyterms, tools, turn_detection, volume. */
  updateSession(session: SessionConfig) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session.update", session }));
  }

  /** Make the agent speak without waiting for the customer to say something. */
  createReply(instructions: string) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "reply.create", instructions }));
  }

  /** Seed context without anyone saying it out loud. */
  addMessage(role: "user" | "system", content: string) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "conversation.message", role, content }));
  }

  /** Clean teardown: a bare close() leaves a billable 30 s resume window. */
  end() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "session.end" }));
      setTimeout(() => this.ws?.close(), 300);
    } else {
      this.ws?.close();
    }
    this.ready = false;
  }
}
