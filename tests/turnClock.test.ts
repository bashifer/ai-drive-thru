import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { RoomEar, TurnClock } from "../src/lib/attribution";
import type { SttTurn } from "../src/lib/sttStream";

/**
 * Where a customer's turn begins, which is where its words are looked for.
 *
 * The agent's `input.speech.started` is late — 0.6 to 1.5 s after the first word on the
 * bench and the recorded lane, and after the last word of a short "that's all" — and it
 * can hear one line as two turns. Anchored to it, attribution missed the kid's nuggets in
 * `backseat-approved` although the room ear had delivered them seconds earlier.
 */

const turn = (text: string, fromMs: number, toMs: number, speaker: string, order: number): SttTurn => {
  const tokens = text.split(" ");
  const step = (toMs - fromMs) / tokens.length;
  return {
    type: "Turn",
    turn_order: order,
    transcript: text,
    end_of_turn: true,
    speaker_label: speaker,
    words: tokens.map((t, i) => ({
      text: t,
      start: Math.round(fromMs + i * step),
      end: Math.round(fromMs + (i + 1) * step),
      word_is_final: true,
      speaker,
    })),
  };
};

describe("where a customer's turn begins", () => {
  test("before the agent noticed it", () => {
    const clock = new TurnClock();
    clock.replyDone(5_000);
    clock.speechStarted(10_000);
    assert.equal(clock.turnFrom, 8_000);
  });

  test("but never inside the agent's own reply", () => {
    const clock = new TurnClock();
    clock.replyDone(9_500);
    clock.speechStarted(10_000);
    assert.equal(clock.turnFrom, 9_500);
  });

  test("a line the agent heard as two turns is one turn", () => {
    const clock = new TurnClock();
    clock.replyDone(15_844);
    clock.speechStarted(17_542); // "Chicken nuggets?"
    clock.speechStarted(19_242); // "Nuggets, please."
    assert.equal(clock.turnFrom, 15_844);
  });

  test("the next turn begins after the agent's next reply", () => {
    const clock = new TurnClock();
    clock.replyDone(15_844);
    clock.speechStarted(17_542);
    clock.replyDone(22_574);
    clock.speechStarted(28_544);
    assert.equal(clock.turnFrom, 26_544);
  });

  test("the kid's nuggets are found where the kid said them (bench, 22 Sep)", () => {
    // backseat-approved, scene clock: the driver's order, then the kid's line, which the
    // agent heard as two turns starting at 17 542 and 19 242 ms.
    const room = new RoomEar();
    room.start(0);
    room.ingest(turn("Just a Crispy Chicken Sandwich for me.", 6_635, 8_132, "A", 0), 9_670);
    room.ingest(turn("Can I have chicken nuggets? Nuggets, please.", 16_468, 18_713, "B", 1), 20_215);

    const late = room.attribute("Chicken nuggets", 19_242, 22_574);
    assert.equal(late.speaker, "UNKNOWN", "anchored on the agent's speech.started, the words are missed");

    const clock = new TurnClock();
    clock.replyDone(15_844);
    clock.speechStarted(17_542);
    clock.speechStarted(19_242);
    const found = room.attribute("Chicken nuggets", clock.turnFrom, 22_574);
    assert.equal(found.speaker, "B");
    assert.equal(found.verdict, "other_voice");
  });
});
