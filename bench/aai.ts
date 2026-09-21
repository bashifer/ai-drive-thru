import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

/** Shared AssemblyAI plumbing for the bench (Node side, API key stays local). */

export function apiKey(): string {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY;
  try {
    const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith("ASSEMBLYAI_API_KEY="));
    const key = line?.slice("ASSEMBLYAI_API_KEY=".length).trim();
    if (key) return key;
  } catch {
    /* fall through */
  }
  throw new Error("ASSEMBLYAI_API_KEY not found (env or .env.local)");
}

async function mintToken(base: string, expiresIn = 300): Promise<string> {
  const key = apiKey();
  const url = new URL(base);
  url.searchParams.set("expires_in_seconds", String(expiresIn));

  for (const auth of [`Bearer ${key}`, key]) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (res.ok) return ((await res.json()) as { token: string }).token;
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Token request failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
  throw new Error("Token request unauthorized — check ASSEMBLYAI_API_KEY");
}

export const voiceAgentToken = () => mintToken("https://agents.assemblyai.com/v1/token");
export const streamingToken = () => mintToken("https://streaming.assemblyai.com/v3/token");

export function openSocket(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

export async function connectVoiceAgent(): Promise<WebSocket> {
  const token = await voiceAgentToken();
  return openSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(token)}`);
}

export async function connectStreaming(params: Record<string, string>): Promise<WebSocket> {
  const token = await streamingToken();
  const url = new URL("wss://streaming.assemblyai.com/v3/ws");
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return openSocket(url.toString());
}

export const int16ToBase64 = (samples: Int16Array) =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).toString("base64");

export const base64ToInt16 = (b64: string) => {
  const buf = Buffer.from(b64, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
};
