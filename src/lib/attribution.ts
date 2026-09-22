"use client";

import type { SttTurn, SttWord } from "./sttStream";

/**
 * Turns the diarization stream into an answer to one question: who asked for this?
 *
 * Words from Universal-3.5 Pro carry `speaker` once they are final; turns shorter
 * than ~1 s come back as "PENDING" because the model needs about a second of audio
 * for a reliable embedding. PENDING is not treated as a failure here — it is simply
 * "not the driver, confirm it", which is what a good order taker does anyway.
 */

/**
 * Three states, not two. Absence of evidence is not evidence of a back-seat voice:
 * an item is only held when the room ear can positively place it with a voice that
 * is not the driver's. Otherwise the focused ear is trusted and the line is flagged
 * as unverified rather than blocked.
 */
export type Verdict = "driver" | "other_voice" | "unverified";

export type Attribution = {
  speaker: string; // "A" | "B" | ... | "UNKNOWN"
  verdict: Verdict;
  matchedPhrase: boolean;
  evidence: string;
};

export type SpeakerStat = { speaker: string; ms: number; words: number; firstHeardAt: number };

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export type SpeakerRevision = {
  type: "SpeakerRevision";
  revisions: { turn_order: number; speaker_label: string; words?: SttWord[] }[];
};

export class RoomEar {
  /** Wall-clock ms at which the streaming session started (word.start is relative to it). */
  private startedAt = 0;
  /** `wall` is when the word was spoken, `arrivedAt` when its final turn reached us. */
  private words: (SttWord & { wall: number; turnOrder: number; arrivedAt: number })[] = [];
  private stats = new Map<string, SpeakerStat>();
  /** A turn someone is still in the middle of: the room ear has words for it, not yet final. */
  private openTurn: number | null = null;

  turns: { transcript: string; speaker: string; at: number }[] = [];
  /** Turns whose speaker the end-of-session pass corrected. */
  revisedTurns = 0;

  start(at = performance.now()) {
    this.startedAt = at;
    this.words = [];
    this.stats.clear();
    this.turns = [];
    this.revisedTurns = 0;
    this.openTurn = null;
  }

  get primarySpeaker(): string | null {
    let best: SpeakerStat | null = null;
    for (const s of this.stats.values()) {
      if (s.speaker === "PENDING" || s.speaker === "UNKNOWN") continue;
      // The driver is whoever engaged the agent first and holds the conversation.
      if (!best || s.firstHeardAt < best.firstHeardAt - 1500 || (s.ms > best.ms * 1.6 && s.firstHeardAt < best.firstHeardAt + 4000)) {
        best = s;
      }
    }
    return best?.speaker ?? null;
  }

  get speakerStats(): SpeakerStat[] {
    return Array.from(this.stats.values()).sort((a, b) => a.firstHeardAt - b.firstHeardAt);
  }

  ingest(turn: SttTurn, at = performance.now()) {
    if (!turn.end_of_turn) {
      if (turn.transcript?.trim()) this.openTurn = Math.max(this.openTurn ?? turn.turn_order, turn.turn_order);
      return;
    }
    // A final closes its own turn — not a later one somebody is still speaking.
    if (this.openTurn !== null && turn.turn_order >= this.openTurn) this.openTurn = null;

    const label = turn.speaker_label ?? "UNKNOWN";
    if (turn.transcript?.trim()) {
      this.turns.push({ transcript: turn.transcript, speaker: label, at });
      if (this.turns.length > 60) this.turns.shift();
    }

    for (const w of turn.words ?? []) {
      if (w.word_is_final === false) continue;
      const speaker = w.speaker && w.speaker !== "PENDING" ? w.speaker : label;
      this.words.push({ ...w, speaker, wall: this.startedAt + w.start, turnOrder: turn.turn_order, arrivedAt: at });
    }

    if (this.words.length > 900) this.words = this.words.slice(-600);
    this.rebuildStats();
  }

  /**
   * Whether the room ear has finished the customer turn the agent noticed at `since`:
   * a final turn has arrived since then, and nobody is still mid-sentence.
   *
   * Who asked for an item and whether the driver said yes are both read from these
   * words, so a tool call that acts on the turn should not run before they are here.
   * It goes by arrival, not by word timings: the agent's speech.started lags the first
   * word by over a second, so a short "that's all" can be over before `since`.
   */
  heardSince(since: number): boolean {
    return this.openTurn === null && this.words.some((w) => w.arrivedAt >= since);
  }

  private rebuildStats() {
    this.stats.clear();
    for (const word of this.words) {
      const speaker = word.speaker;
      if (!speaker || speaker === "PENDING" || speaker === "UNKNOWN") continue;
      const stat = this.stats.get(speaker) ?? { speaker, ms: 0, words: 0, firstHeardAt: word.wall };
      stat.ms += Math.max(0, word.end - word.start);
      stat.words += 1;
      stat.firstHeardAt = Math.min(stat.firstHeardAt, word.wall);
      this.stats.set(speaker, stat);
    }
  }

  /**
   * The end-of-session refinement pass, applied.
   *
   * Live labels are a best guess from the audio heard so far; when the session ends
   * the model looks at the whole conversation and sends back the turns it got wrong.
   * Re-running attribution against those labels is how an order finds out, after the
   * fact, that a line was booked to the wrong person — which is exactly the thing a
   * restaurant would otherwise only discover at the window.
   */
  applyRevisions(revision: SpeakerRevision): number {
    let touched = 0;
    for (const item of revision.revisions ?? []) {
      const byTime = new Map((item.words ?? []).map((w) => [w.start, w.speaker ?? item.speaker_label]));
      let changedHere = false;
      for (const word of this.words) {
        if (word.turnOrder !== item.turn_order) continue;
        const next = byTime.get(word.start) ?? item.speaker_label;
        if (next && next !== word.speaker) {
          word.speaker = next;
          changedHere = true;
        }
      }
      if (changedHere) touched++;
    }
    this.revisedTurns += touched;
    if (touched) this.rebuildStats();
    return touched;
  }

  /**
   * Attribute a phrase the agent just acted on ("chocolate shake") to a speaker,
   * looking only at what was said inside the current customer turn.
   */
  attribute(phrase: string, windowStart: number, windowEnd = performance.now()): Attribution {
    const primary = this.primarySpeaker;
    const inWindow = this.words.filter((w) => w.wall >= windowStart - 700 && w.wall <= windowEnd + 200);

    const tokens = normalize(phrase)
      .split(" ")
      .filter((t) => t.length > 2);

    const matched = inWindow.filter((w) => {
      const t = normalize(w.text);
      return tokens.some((tok) => t === tok || t.startsWith(tok) || tok.startsWith(t));
    });

    const pool = matched.length ? matched : inWindow;
    if (!pool.length) {
      // The room ear has nothing for this turn yet — say so instead of guessing.
      return { speaker: "UNKNOWN", verdict: "unverified", matchedPhrase: false, evidence: "" };
    }

    const tally = new Map<string, number>();
    for (const w of pool) {
      const key = w.speaker ?? "UNKNOWN";
      if (key === "PENDING" || key === "UNKNOWN") continue;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }

    const ranked = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);
    const evidence = pool
      .slice(-12)
      .map((w) => w.text)
      .join(" ");

    if (!ranked.length) {
      // Heard, but too short or too noisy to place with a voice.
      return { speaker: "UNKNOWN", verdict: "unverified", matchedPhrase: matched.length > 0, evidence };
    }

    const [speaker] = ranked[0];
    const verdict: Verdict = primary === null ? "unverified" : speaker === primary ? "driver" : "other_voice";

    return { speaker, verdict, matchedPhrase: matched.length > 0, evidence };
  }

  /**
   * Everything heard in a window, whoever said it.
   *
   * `attribute` narrows to the words that matched an item, which is right for "who
   * asked for this" and wrong for "did they say yes" — consent lives in the rest of
   * the sentence.
   */
  turnText(windowStart: number, windowEnd = performance.now()): string {
    return this.words
      .filter((w) => w.wall >= windowStart - 700 && w.wall <= windowEnd + 200)
      .map((w) => w.text)
      .join(" ");
  }

  /** Menu-ish phrases heard from someone other than the driver, for proactive asks. */
  recentSideRequests(windowStart: number): { speaker: string; text: string }[] {
    const primary = this.primarySpeaker;
    const out = new Map<string, string[]>();
    for (const w of this.words) {
      if (w.wall < windowStart) continue;
      const speaker = w.speaker ?? "UNKNOWN";
      if (!speaker || speaker === primary) continue;
      const list = out.get(speaker) ?? [];
      list.push(w.text);
      out.set(speaker, list);
    }
    return Array.from(out.entries()).map(([speaker, words]) => ({ speaker, text: words.join(" ") }));
  }
}

/** Display name for a diarization label. */
export function guestName(speaker: string, primary: string | null) {
  if (speaker === "UNKNOWN" || speaker === "PENDING") return "Unidentified voice";
  if (primary && speaker === primary) return "Driver";
  return `Guest ${speaker}`;
}
