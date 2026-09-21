"use client";

import { useCallback, useRef, useState } from "react";
import { AudioEngine, type InjectedClip } from "./audio";
import { RoomEar, guestName, type SpeakerRevision } from "./attribution";
import { buildSessionConfig, DEFAULT_GREETING, systemPromptFor, type AgentOptions } from "./agentConfig";
import { menuKeyterms, resolveMenuItem } from "./menu";
import { OrderEngine, type OrderSnapshot, type Outcome } from "./orderEngine";
import { clipUrl, type Scenario, type ScenarioCue } from "./scenarios";
import { describeActual, scoreOrder, type Score } from "./scoring";
import { ShadowCart } from "./shadowCart";
import { ToolRunner, type QueuedToolCall } from "./toolDispatch";
import { SttDiarizationClient, type SttEvent, type SttTurn } from "./sttStream";
import { VoiceAgentClient, type VoiceAgentEvent } from "./voiceAgent";

export type Status = "idle" | "starting" | "live" | "stopping" | "error";

export type TranscriptEntry = {
  id: string;
  role: "customer" | "agent" | "system";
  text: string;
  at: number;
  speaker?: string;
  interrupted?: boolean;
  /** The customer turn a line came from (performance.now ms), to name the voice once the room ear can. */
  heardFrom?: number;
  heardTo?: number;
};

export type XRayEvent = {
  id: string;
  at: number;
  ear: "agent" | "room" | "engine";
  label: string;
  detail?: string;
  tone?: "normal" | "good" | "warn";
};

export type Metrics = {
  replyLatencyMs: number | null;
  bestLatencyMs: number | null;
  bargeIns: number;
  toolCalls: number;
  heldItems: number;
};

type QueuedCall = QueuedToolCall;

export type ScenarioRun = {
  scenarioId: string;
  title: string;
  status: "running" | "pass" | "fail";
  step: number;
  steps: number;
  ticket: string[];
  expected: string[];
  notes: string[];
  score?: Score;
  /** The same calls, scored in the cart that trusts all of them. */
  shadow?: { pass: boolean; ticket: string[]; notes: string[] };
};

/** Score a finished cart against the ticket a scenario expects, as the bench does. */
function judge(snap: OrderSnapshot, expect: Scenario["expect"]) {
  const confirmed = snap.lines.filter((l) => l.status === "confirmed");
  const score = scoreOrder(confirmed, expect.ticket, snap.driver);
  const notes = [...score.notes];

  for (const forbidden of expect.mustNotContain ?? []) {
    if (confirmed.some((l) => l.name === forbidden)) notes.push(`must not contain ${forbidden}`);
  }
  if (expect.escalated !== undefined && snap.escalated !== expect.escalated) {
    notes.push(`escalated: got ${snap.escalated}, expected ${expect.escalated}`);
  }
  return { pass: notes.length === 0, notes, score, ticket: confirmed.map(describeActual) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const uid = (p: string) => `${p}_${++seq}`;

const EMPTY_ORDER: OrderSnapshot = {
  lines: [],
  flags: [],
  subtotal: 0,
  tax: 0,
  total: 0,
  daypart: "allday",
  escalated: false,
  finalized: false,
  driver: null,
};

export function useBackseat() {
  const audioRef = useRef<AudioEngine | null>(null);
  const agentRef = useRef<VoiceAgentClient | null>(null);
  const sttRef = useRef<SttDiarizationClient | null>(null);
  const roomRef = useRef<RoomEar>(new RoomEar());
  const orderRef = useRef<OrderEngine>(new OrderEngine());
  /** A/B: the same tool calls, booked into a cart with no attribution and no guards. */
  const shadowRef = useRef<ShadowCart>(new ShadowCart());

  const turnStartedAt = useRef<number>(0);
  const speechStoppedAt = useRef<number | null>(null);
  const awaitingAudio = useRef(false);
  const agentSpeaking = useRef(false);
  const askedAbout = useRef<Set<string>>(new Set());
  const sideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedCalls = useRef<QueuedCall[]>([]);
  const toolRunner = useRef<ToolRunner | null>(null);
  /** A scripted line has been played and the agent has not taken its turn yet. */
  const awaitingAgentTurn = useRef(false);
  const scenarioRunning = useRef(false);
  /** The open sessions have heard a customer, so the next scripted car needs new ones. */
  const sessionUsed = useRef(false);
  const laneOpts = useRef<AgentOptions>({});
  const daypartRef = useRef<"breakfast" | "allday">("allday");

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderSnapshot>(EMPTY_ORDER);
  const [shadowOrder, setShadowOrder] = useState<OrderSnapshot>(EMPTY_ORDER);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [partial, setPartial] = useState("");
  const [events, setEvents] = useState<XRayEvent[]>([]);
  const [speakers, setSpeakers] = useState<{ speaker: string; label: string; ms: number }[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);
  const [scenarioRun, setScenarioRun] = useState<ScenarioRun | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({
    replyLatencyMs: null,
    bestLatencyMs: null,
    bargeIns: 0,
    toolCalls: 0,
    heldItems: 0,
  });

  const pushEvent = useCallback((e: Omit<XRayEvent, "id" | "at">) => {
    setEvents((prev) => [{ ...e, id: uid("ev"), at: Date.now() }, ...prev].slice(0, 80));
  }, []);

  const pushLine = useCallback((entry: Omit<TranscriptEntry, "id" | "at">) => {
    setTranscript((prev) => [...prev, { ...entry, id: uid("t"), at: Date.now() }].slice(-60));
  }, []);

  const syncOrder = useCallback(() => {
    const snap = orderRef.current.snapshot();
    setOrder(snap);
    setShadowOrder(shadowRef.current.snapshot());
    setMetrics((m) => ({ ...m, heldItems: snap.lines.filter((l) => l.status === "pending").length }));
  }, []);

  const syncSpeakers = useCallback(() => {
    const room = roomRef.current;
    const p = room.primarySpeaker;
    setPrimary(p);
    setSpeakers(
      room.speakerStats.map((s) => ({ speaker: s.speaker, label: guestName(s.speaker, p), ms: Math.round(s.ms) })),
    );
  }, []);

  /**
   * A transcript line is written the moment the focused ear hears the turn, about a
   * second before the room ear knows whose voice it was. Fill the name in when it
   * does — and, after the end-of-session pass, correct the ones it got wrong.
   */
  const relabelTranscript = useCallback((all: boolean) => {
    const room = roomRef.current;
    setTranscript((lines) => {
      let changed = false;
      const next = lines.map((line) => {
        if (line.role !== "customer" || line.heardFrom === undefined) return line;
        if (!all && line.speaker && line.speaker !== "UNKNOWN") return line;
        const who = room.attribute(line.text, line.heardFrom, line.heardTo);
        if (who.speaker === "UNKNOWN" || who.speaker === line.speaker) return line;
        changed = true;
        return { ...line, speaker: who.speaker };
      });
      return changed ? next : lines;
    });
  }, []);

  /**
   * Tool calls are executed when the agent's transition phrase is done, not the
   * instant they arrive. Diarization finalises a turn about a second behind the
   * agent's own end-of-turn, and this is exactly the window the protocol already
   * gives us before a `tool.result` may be sent.
   */
  const runTool = useCallback((call: QueuedCall, resultReachesAgent: boolean): Outcome => {
    if (call.name === "add_item" && typeof call.args.item === "string") {
      askedAbout.current.add(call.args.item.toLowerCase());
    }
    const runner = (toolRunner.current ??= new ToolRunner(
      orderRef.current,
      { room: roomRef.current },
      shadowRef.current,
    ));
    return runner.run(call, resultReachesAgent);
  }, []);

  /**
   * The focused ear may not hear a back-seat voice at all — far-field Voice Focus is
   * doing its job. The room ear still does, so we let the agent raise it itself.
   */
  const checkSideRequests = useCallback(() => {
    const room = roomRef.current;
    const agent = agentRef.current;
    if (!agent?.isReady || agentSpeaking.current) return;

    for (const { speaker, text } of room.recentSideRequests(turnStartedAt.current - 1500)) {
      const match = resolveMenuItem(text)[0];
      if (!match || match.score < 0.75) continue;
      const key = `${speaker}:${match.item.id}`;
      if (askedAbout.current.has(key) || askedAbout.current.has(match.item.name.toLowerCase())) continue;
      askedAbout.current.add(key);

      pushEvent({
        ear: "room",
        label: "side request heard",
        detail: `voice ${speaker}: "${text.slice(-60)}" → ${match.item.name}`,
        tone: "warn",
      });
      agent.createReply(
        `Someone in the car other than the driver just asked for ${match.item.name}. Ask the driver, in one short question, whether to add it. Do not add anything yet.`,
      );
      return;
    }
  }, [pushEvent]);

  /**
   * The end-of-session pass corrects speaker labels the model got wrong live. Re-running
   * attribution against it is how an order finds out, after the fact, that a line was
   * booked to the wrong person — the thing a restaurant would otherwise discover at the
   * window, or not at all.
   */
  const applyRevision = useCallback(
    (revision: SpeakerRevision) => {
      const room = roomRef.current;
      const touched = room.applyRevisions(revision);
      if (!touched) return;

      const changes = orderRef.current.reattribute((line) =>
        line.heardTo ? room.attribute(line.evidence || line.name, line.heardFrom, line.heardTo) : null,
      );
      syncOrder();
      syncSpeakers();
      relabelTranscript(true);

      pushEvent({
        ear: "room",
        label: `speaker revision: ${touched} turn(s) corrected`,
        detail: changes.length
          ? changes.map((c) => `${c.line.name}: ${c.from} → ${c.to}`).join("; ")
          : "no order line changed hands",
        tone: changes.length ? "warn" : "good",
      });
    },
    [pushEvent, relabelTranscript, syncOrder, syncSpeakers],
  );

  const handleAgentEvent = useCallback(
    (e: VoiceAgentEvent) => {
      const agent = agentRef.current;
      const audio = audioRef.current;

      switch (e.type) {
        case "session.ready":
          pushEvent({ ear: "agent", label: "session.ready", detail: (e as { session_id: string }).session_id, tone: "good" });
          break;

        case "input.speech.started":
          turnStartedAt.current = performance.now();
          awaitingAudio.current = false;
          // Snappiest barge-in: drop queued speech the moment the customer talks.
          if (agentSpeaking.current) audio?.flushPlayback();
          pushEvent({ ear: "agent", label: "speech started" });
          break;

        case "input.speech.stopped":
          speechStoppedAt.current = performance.now();
          awaitingAudio.current = true;
          pushEvent({ ear: "agent", label: "speech stopped (semantic end of turn)" });
          break;

        case "transcript.user.delta":
          setPartial((e as { text: string }).text);
          break;

        case "transcript.user": {
          const text = (e as { text: string }).text;
          sessionUsed.current = true;
          setPartial("");
          const heardTo = performance.now();
          const who = roomRef.current.attribute(text, turnStartedAt.current, heardTo);
          pushLine({ role: "customer", text, speaker: who.speaker, heardFrom: turnStartedAt.current, heardTo });
          if (sideTimer.current) clearTimeout(sideTimer.current);
          sideTimer.current = setTimeout(checkSideRequests, 1800);
          break;
        }

        case "reply.started":
          agentSpeaking.current = true;
          awaitingAgentTurn.current = false;
          break;

        case "reply.audio": {
          audio?.playPcm24((e as { data: string }).data);
          if (awaitingAudio.current && speechStoppedAt.current) {
            const ms = Math.round(performance.now() - speechStoppedAt.current);
            awaitingAudio.current = false;
            setMetrics((m) => ({
              ...m,
              replyLatencyMs: ms,
              bestLatencyMs: m.bestLatencyMs === null ? ms : Math.min(m.bestLatencyMs, ms),
            }));
            pushEvent({ ear: "agent", label: "first audio out", detail: `${ms} ms after end of turn`, tone: "good" });
          }
          break;
        }

        case "transcript.agent": {
          const { text, interrupted } = e as { text: string; interrupted: boolean };
          pushLine({ role: "agent", text, interrupted });
          // Feed the agent's half of the dialog to the room ear: Universal-3.5 Pro
          // transcribes short answers far better when it knows the question.
          sttRef.current?.setAgentContext(text);
          break;
        }

        case "reply.done": {
          agentSpeaking.current = false;
          const interrupted = (e as { status: string }).status === "interrupted";
          if (interrupted) {
            audio?.flushPlayback();
            setMetrics((m) => ({ ...m, bargeIns: m.bargeIns + 1 }));
            pushEvent({ ear: "agent", label: "barge-in", detail: "customer talked over the agent", tone: "warn" });
          }

          const calls = queuedCalls.current;
          queuedCalls.current = [];
          for (const call of calls) {
            // Interrupted replies still get their work done; only the answer is withheld.
            const outcome = runTool(call, !interrupted);
            pushEvent({
              ear: "engine",
              label: `${call.name} → ${outcome.status}${interrupted ? " (reply interrupted)" : ""}`,
              detail: outcome.message.slice(0, 120),
              tone: outcome.status === "ok" ? "good" : outcome.status === "not_found" ? "normal" : "warn",
            });
            if (!interrupted) agent?.queueToolResult(call.callId, outcome, outcome.status === "rejected");
          }
          if (calls.length) syncOrder();
          break;
        }

        case "tool.call": {
          const { call_id, name, arguments: args } = e as {
            call_id: string;
            name: string;
            arguments: Record<string, unknown>;
          };
          sessionUsed.current = true;
          queuedCalls.current.push({
            callId: call_id,
            name,
            args: args ?? {},
            turnStartedAt: turnStartedAt.current,
          });
          setMetrics((m) => ({ ...m, toolCalls: m.toolCalls + 1 }));
          break;
        }

        case "session.error":
          pushEvent({
            ear: "agent",
            label: `error: ${(e as { code: string }).code}`,
            detail: (e as { message: string }).message,
            tone: "warn",
          });
          break;

        case "connection.closed":
          pushEvent({ ear: "agent", label: "connection closed" });
          break;
      }
    },
    [checkSideRequests, pushEvent, pushLine, runTool, syncOrder],
  );

  const handleRoomEvent = useCallback(
    (evt: SttEvent) => {
      if (evt.type === "SpeakerRevision") {
        applyRevision(evt as unknown as SpeakerRevision);
        return;
      }
      if (evt.type !== "Turn") return;

      const turn = evt as SttTurn;
      roomRef.current.ingest(turn);
      if (!turn.end_of_turn) return;

      syncSpeakers();
      relabelTranscript(false);
      if (turn.speaker_label && turn.transcript) {
        pushEvent({ ear: "room", label: `voice ${turn.speaker_label}`, detail: turn.transcript.slice(0, 90) });
      }
    },
    [applyRevision, pushEvent, relabelTranscript, syncSpeakers],
  );

  /** An empty ticket on both carts, with nothing left over from earlier calls. */
  const resetTicket = useCallback(() => {
    orderRef.current.reset();
    shadowRef.current.reset();
    askedAbout.current.clear();
    queuedCalls.current = [];
    toolRunner.current = null;
    syncOrder();
  }, [syncOrder]);

  /** Everything that belongs to one car: its ticket, its turns, its voices, its transcript. */
  const clearCar = useCallback(() => {
    resetTicket();
    if (sideTimer.current) clearTimeout(sideTimer.current);
    turnStartedAt.current = performance.now();
    speechStoppedAt.current = null;
    awaitingAudio.current = false;
    agentSpeaking.current = false;
    roomRef.current.start();
    setTranscript([]);
    setPartial("");
    syncSpeakers();
  }, [resetTicket, syncSpeakers]);

  /** End both sessions now. Anything they still send is ignored from here on. */
  const releaseEars = useCallback(() => {
    const agent = agentRef.current;
    const stt = sttRef.current;
    agentRef.current = null;
    sttRef.current = null;
    agent?.end();
    // No refinement pass: the car that is leaving has already been scored.
    void stt?.close(0);
  }, []);

  /** A lane that cannot open a session is closed, with the reason on screen. */
  const failLane = useCallback(
    async (message: string) => {
      releaseEars();
      await audioRef.current?.stop();
      audioRef.current = null;
      setError(message);
      setStatus("error");
    },
    [releaseEars],
  );

  /**
   * Open both ears for one car: a Voice Agent session for the conversation and a
   * streaming session for who is speaking. Events from a session that has since been
   * replaced are dropped, so a car that has left cannot touch the next one's ticket.
   */
  const openEars = useCallback(
    async (opts: AgentOptions) => {
      const agent = new VoiceAgentClient();
      const stt = new SttDiarizationClient();
      agentRef.current = agent;
      sttRef.current = stt;
      sessionUsed.current = false;
      // The greeting is the agent's turn; nothing scripted talks over it.
      awaitingAgentTurn.current = true;

      agent.onEvent((e) => {
        if (agentRef.current === agent) handleAgentEvent(e);
      });
      stt.onEvent((e) => {
        if (sttRef.current === stt) handleRoomEvent(e);
      });

      await Promise.all([
        agent.connect(buildSessionConfig({ ...opts, daypart: daypartRef.current })),
        stt
          .connect({
            keyterms: menuKeyterms(100),
            agentContext: opts.greeting ?? DEFAULT_GREETING,
            maxSpeakers: 3,
          })
          // Word timings count from the stream's first audio, which flows as soon as
          // this socket is open — not when the other ear has finished connecting.
          .then(() => roomRef.current.start()),
      ]);

      pushEvent({ ear: "room", label: "diarization stream open", detail: "universal-3-5-pro, speaker_labels", tone: "good" });
    },
    [handleAgentEvent, handleRoomEvent, pushEvent],
  );

  /**
   * The next car at the speaker. A session that has taken an order remembers it —
   * "I've already got a lab burger on there" — so each car gets new sessions on both
   * ears, while the microphone and the speakers stay as they are.
   */
  const nextCar = useCallback(async () => {
    releaseEars();
    audioRef.current?.flushPlayback();
    clearCar();
    pushEvent({ ear: "agent", label: "next car", detail: "new sessions on both ears; the last conversation left with the last car" });
    await openEars(laneOpts.current);
  }, [clearCar, openEars, pushEvent, releaseEars]);

  /**
   * Run one scripted car through the live lane and score what lands on the ticket.
   *
   * The clips are mixed into the microphone bus, so this exercises the same path a
   * real customer does — speech in, tool calls, cart out — and then compares the cart
   * to the scenario's expected one. It is the offline bench, in the page.
   */
  const runScenario = useCallback(
    async (scenario: Scenario) => {
      const audio = audioRef.current;
      if (!audio || scenarioRunning.current) return;
      scenarioRunning.current = true;

      const expected = scenario.expect.ticket.map((e) => `${e.qty}×${e.item}`);
      setScenarioRun({
        scenarioId: scenario.id,
        title: scenario.title,
        status: "running",
        step: 0,
        steps: scenario.steps.length,
        ticket: [],
        expected,
        notes: [],
      });

      // Every scripted car is a new customer, as it is on the bench.
      try {
        if (sessionUsed.current) await nextCar();
        else resetTicket();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setScenarioRun((r) => (r ? { ...r, status: "fail", notes: [`no session for this car: ${message}`] } : r));
        scenarioRunning.current = false;
        await failLane(message);
        return;
      }
      pushEvent({ ear: "room", label: `regression: ${scenario.title}`, detail: scenario.proves });

      const startedAt = performance.now();
      const idle = () => !agentSpeaking.current && !audio.speaking;

      const waitForCue = async (cue: ScenarioCue) => {
        if (cue.kind === "at") {
          while (performance.now() - startedAt < cue.ms) await sleep(100);
          return;
        }
        const deadline = performance.now() + 16000;
        // Give the agent its turn before talking over it.
        while (awaitingAgentTurn.current && performance.now() < deadline) await sleep(120);
        while (performance.now() < deadline) {
          if (!idle()) {
            await sleep(120);
            continue;
          }
          await sleep(cue.delayMs ?? 400);
          if (idle()) return;
        }
      };

      try {
        if (scenario.engineNoise) audio.toggleNoise("scenario", scenario.engineNoise);

        for (const [index, step] of scenario.steps.entries()) {
          await waitForCue(step.cue);
          setScenarioRun((r) => (r ? { ...r, step: index + 1 } : r));
          await audio.playClip({
            id: `${scenario.id}-${index}`,
            label: step.role,
            url: clipUrl(scenario.id, index),
            gain: step.gain,
          });
          if (step.cue.kind !== "at") awaitingAgentTurn.current = true;
        }

        // Let the agent finish whatever it is doing before reading the ticket.
        const settleBy = performance.now() + 12000;
        while (performance.now() < settleBy && (awaitingAgentTurn.current || !idle())) await sleep(150);
        await sleep(1200);

        const verdict = judge(orderRef.current.snapshot(), scenario.expect);
        const naive = judge(shadowRef.current.snapshot(), scenario.expect);

        setScenarioRun({
          scenarioId: scenario.id,
          title: scenario.title,
          status: verdict.pass ? "pass" : "fail",
          step: scenario.steps.length,
          steps: scenario.steps.length,
          ticket: verdict.ticket,
          expected,
          notes: verdict.notes,
          score: verdict.score,
          shadow: { pass: naive.pass, ticket: naive.ticket, notes: naive.notes },
        });
        pushEvent({
          ear: "engine",
          label: `regression ${verdict.pass ? "PASS" : "FAIL"}: ${scenario.title}`,
          detail: `${verdict.notes.join("; ") || "cart matches the expected ticket"} · trusting cart ${
            naive.pass ? "PASS" : "FAIL"
          }`,
          tone: verdict.pass ? "good" : "warn",
        });
      } finally {
        if (scenario.engineNoise) audio.toggleNoise("scenario");
        awaitingAgentTurn.current = false;
        scenarioRunning.current = false;
      }
    },
    [failLane, nextCar, pushEvent, resetTicket],
  );

  const start = useCallback(
    async (opts: AgentOptions = {}) => {
      if (status === "live" || status === "starting") return;
      setStatus("starting");
      setError(null);
      setEvents([]);
      laneOpts.current = opts;
      clearCar();

      try {
        const audio = new AudioEngine();
        audioRef.current = audio;

        // Start capture inside the user gesture, then open both ears. Audio goes to
        // whichever sessions are current, so the next car can get new ones mid-lane.
        await audio.start((kind, buf) => {
          if (kind === "agent") agentRef.current?.sendAudio(buf);
          else sttRef.current?.sendAudio(buf);
        });
        setMicDenied(audio.micDenied);
        if (audio.micDenied) {
          pushEvent({
            ear: "room",
            label: "no microphone",
            detail: "running on injected audio — the regression tests still work",
            tone: "warn",
          });
        }

        await openEars(opts);
        setStatus("live");
      } catch (err) {
        await failLane(err instanceof Error ? err.message : String(err));
      }
    },
    [clearCar, failLane, openEars, pushEvent, status],
  );

  const stop = useCallback(async () => {
    setStatus("stopping");
    agentRef.current?.end();
    // Wait for the refinement pass before tearing the socket down.
    await sttRef.current?.close();
    await audioRef.current?.stop();
    agentRef.current = null;
    sttRef.current = null;
    audioRef.current = null;
    setStatus("idle");
    setPartial("");
  }, []);

  const playClip = useCallback(
    async (clip: InjectedClip) => {
      pushEvent({ ear: "room", label: `injected: ${clip.label}` });
      await audioRef.current?.playClip(clip);
    },
    [pushEvent],
  );

  const toggleLoop = useCallback(
    async (clip: InjectedClip) => {
      const on = await audioRef.current?.toggleLoop(clip);
      pushEvent({ ear: "room", label: `${clip.label} ${on ? "on" : "off"}` });
      return !!on;
    },
    [pushEvent],
  );

  const toggleNoise = useCallback(
    (id: string, gain?: number) => {
      const on = audioRef.current?.toggleNoise(id, gain) ?? false;
      pushEvent({ ear: "room", label: `${id} noise ${on ? "on" : "off"}`, detail: on ? "far-field Voice Focus active" : undefined });
      return on;
    },
    [pushEvent],
  );

  const setDaypart = useCallback(
    (daypart: "breakfast" | "allday") => {
      daypartRef.current = daypart;
      orderRef.current.setDaypart(daypart);
      shadowRef.current.setDaypart(daypart);
      syncOrder();
      // Keyterms and the prompt are mutable mid-session: the lane switches menus
      // without dropping the call. The prompt goes whole, because an update replaces it.
      agentRef.current?.updateSession({
        input: { keyterms: menuKeyterms(100) },
        system_prompt: systemPromptFor(daypart),
      });
      pushEvent({ ear: "agent", label: `menu switched to ${daypart}`, detail: "session.update, no reconnect" });
    },
    [pushEvent, syncOrder],
  );

  return {
    status,
    error,
    order,
    shadowOrder,
    transcript,
    partial,
    events,
    speakers,
    primary,
    metrics,
    scenarioRun,
    runScenario,
    micDenied,
    start,
    stop,
    playClip,
    toggleLoop,
    toggleNoise,
    setDaypart,
  };
}
