import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { RoomEar } from "../src/lib/attribution";
import type { SttTurn } from "../src/lib/sttStream";
import { OrderEngine } from "../src/lib/orderEngine";
import { ToolGate, dispatchTool, type QueuedToolCall } from "../src/lib/toolDispatch";

/**
 * When a tool call runs.
 *
 * A held tool (`execution_mode: "hold"`) keeps the agent silent until our `tool.result`,
 * so the moment it runs is the moment the customer's wait ends: as soon as the room ear
 * has the words it acts on, never after a fixed wait. An interactive tool's result can
 * only go back once its reply is over, so a reply with one of those waits for that.
 */

/** Every tool held, so the room-ear rules can be tested on the calls that read it. */
const ALL = new Set(["add_item", "modify_item", "remove_item", "confirm_held_item", "finalize_order"]);

// The room ear's clock starts at 0 wall ms; the customer turn starts at 10 s.
const TURN = 10_000;

const turn = (text: string, fromMs: number, toMs: number, final = true, speaker = "A"): SttTurn => {
  const tokens = text.split(" ");
  const step = (toMs - fromMs) / tokens.length;
  return {
    type: "Turn",
    turn_order: 1,
    transcript: text,
    end_of_turn: final,
    speaker_label: final ? speaker : undefined,
    words: tokens.map((t, i) => ({
      text: t,
      start: Math.round(fromMs + i * step),
      end: Math.round(fromMs + (i + 1) * step),
      word_is_final: final,
      speaker: final ? speaker : undefined,
    })),
  };
};

const call = (name: string, args: Record<string, unknown> = {}, turnStartedAt = TURN): QueuedToolCall => ({
  callId: `call_${name}_${Math.random().toString(36).slice(2, 6)}`,
  name,
  args,
  turnStartedAt,
});

const room = () => {
  const r = new RoomEar();
  r.start(0);
  return r;
};

describe("when a tool call runs", () => {
  test("as soon as the room ear has the words of its turn", () => {
    const r = room();
    r.ingest(turn("a lab burger please", 9_500, 11_000), 11_400);
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("add_item", { item: "lab burger" }), 12_000);

    assert.equal(gate.due(12_050).length, 0, "calls from one reply are a beat apart; wait for the rest");
    assert.equal(gate.due(12_150).length, 1);
    assert.equal(gate.size, 0);
  });

  test("not before the room ear has heard the turn, unless it never does", () => {
    const r = room();
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("add_item", { item: "lab burger" }), 12_000);

    assert.equal(gate.due(12_400).length, 0, "nothing from the room ear yet");
    r.ingest(turn("a lab burger please", 9_500, 11_000), 12_500);
    assert.equal(gate.due(12_550).length, 1, "the words arrived: go");

    // The next turn, which the room ear never delivers.
    gate.add(call("add_item", { item: "fries" }, 18_000), 20_000);
    assert.equal(gate.due(21_000).length, 0);
    assert.equal(gate.due(21_500).length, 1, "a deadline: the lane never goes mute waiting for diarization");
  });

  test("the previous turn's words are not this turn's", () => {
    const r = room();
    // The driver's last line, finished and delivered before this turn began.
    r.ingest(turn("and a coke", 6_000, 7_000), 7_600);
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("confirm_held_item", { decision: "add" }), 12_000);
    assert.equal(gate.due(12_300).length, 0, "consent has to come from this turn's words");
  });

  test("a turn the room ear is still transcribing is waited for", () => {
    const r = room();
    r.ingest(turn("uh let me think", 9_500, 10_500), 11_000);
    // …and the sentence goes on: a partial with words in it is still open.
    r.ingest(turn("yes add it", 11_200, 12_000, false), 12_100);
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("confirm_held_item", { decision: "add" }), 12_200);

    assert.equal(gate.due(12_400).length, 0, "the yes is still in a partial");
    r.ingest(turn("yes add it", 11_200, 12_000), 12_600);
    assert.equal(gate.due(12_650).length, 1);
  });

  test("a short turn counts even though its words ended before the agent noticed it began", () => {
    // The agent's speech.started lags the first word by over a second (bench, 22 Sep):
    // "That's all." can be over before the turn officially starts.
    const r = room();
    r.ingest(turn("that's all", 8_200, 8_900), 10_800);
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("remove_item", { item: "fries" }), 11_000);
    assert.equal(gate.due(11_150).length, 1);
  });

  test("the last turn's final arriving late does not close the one still being transcribed", () => {
    const r = room();
    const partial = { ...turn("and a chocolate", 9_800, 10_400, false), turn_order: 2 };
    r.ingest(partial, 10_500);
    // The driver's turn before it, finalised a beat after the kid started shouting.
    r.ingest(turn("a lab burger", 8_000, 9_000), 10_600);
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("add_item", { item: "chocolate shake" }), 10_700);
    assert.equal(gate.due(10_900).length, 0, "the kid's turn is still open");
    r.ingest({ ...turn("and a chocolate shake", 9_800, 11_000, true, "B"), turn_order: 2 }, 11_200);
    assert.equal(gate.due(11_250).length, 1);
  });

  test("several calls from one reply go back together, in order", () => {
    const r = room();
    r.ingest(turn("a lab burger and a small coke", 9_500, 11_500), 11_900);
    const gate = new ToolGate({ room: r, held: ALL });
    gate.add(call("add_item", { item: "lab burger" }), 12_000);
    gate.add(call("add_item", { item: "coke" }), 12_060);

    assert.equal(gate.due(12_130).length, 0, "the second call just arrived");
    assert.deepEqual(
      gate.due(12_200).map((c) => c.args.item),
      ["lab burger", "coke"],
    );
  });

  test("calls that do not ask who spoke do not wait for the room ear", () => {
    const gate = new ToolGate({ room: room(), held: ALL });
    gate.add(call("finalize_order"), 12_000);
    assert.equal(gate.due(12_150).length, 1);
  });

  test("with no room ear — the single-ear baseline — nothing waits for one", () => {
    const gate = new ToolGate({ room: null, held: ALL });
    gate.add(call("add_item", { item: "lab burger" }), 12_000);
    assert.equal(gate.due(12_150).length, 1);
  });

  test("a reply with an interactive call in it waits for the reply to end", () => {
    const r = room();
    r.ingest(turn("and a coke that's all", 9_500, 11_000), 11_400);
    const gate = new ToolGate({ room: r, held: new Set(["finalize_order"]) });
    gate.add(call("add_item", { item: "coke" }), 12_000);
    gate.add(call("finalize_order"), 12_050);
    assert.equal(gate.due(20_000).length, 0, "its result may only go back at reply.done");
    assert.deepEqual(
      gate.drain().map((c) => c.name),
      ["add_item", "finalize_order"],
    );
  });

  test("the close looks again at a line booked before the room ear had its turn", () => {
    // Bench, 22 Sep (mid-sentence-correction): add_item ran before the room ear's turn
    // arrived, so the burgers went on unplaced and the close asked "are those yours?".
    // Dispatch times windows with performance.now(), so the room ear's clock starts 20 s ago.
    const t0 = performance.now() - 20_000;
    const r = new RoomEar();
    r.start(t0);
    const engine = new OrderEngine();
    dispatchTool(engine, "add_item", { item: "lab burger", quantity: 2 }, { room: r, turnStartedAt: t0 + 6_000 });
    assert.equal(engine.snapshot().lines[0].unverified, true);

    r.ingest(turn("2 lab burgers please", 7_400, 9_000), performance.now());
    const out = dispatchTool(engine, "finalize_order", {}, { room: r, turnStartedAt: t0 + 19_000 });
    assert.equal(out.status, "ok");
    assert.equal(engine.snapshot().lines[0].unverified, false);
  });

  test("everything still queued can be taken at once", () => {
    const gate = new ToolGate({ room: room(), held: ALL });
    gate.add(call("add_item", { item: "lab burger" }), 12_000);
    assert.equal(gate.drain().length, 1);
    assert.equal(gate.due(20_000).length, 0);
  });
});
