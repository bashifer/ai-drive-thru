import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Attribution, RoomEar } from "../src/lib/attribution";
import { OrderEngine, type OrderSnapshot } from "../src/lib/orderEngine";
import { describeActual } from "../src/lib/scoring";
import { ShadowCart } from "../src/lib/shadowCart";
import { ToolRunner } from "../src/lib/toolDispatch";

/**
 * A/B mode without audio. The call sequences are the ones real sessions produced in
 * the committed bench run (bench/results/backseat.json, `trace`), played into
 * Backseat's ticket and the trusting shadow cart side by side.
 */

const DRIVER_VOICE: Attribution = { speaker: "A", verdict: "driver", matchedPhrase: true, evidence: "" };
const KID_VOICE: Attribution = { speaker: "B", verdict: "other_voice", matchedPhrase: true, evidence: "" };

/** A lane with the room ear reduced to the two questions dispatch asks it. */
function lane() {
  let heard = DRIVER_VOICE;
  let turn = "";
  const room = { attribute: () => heard, turnText: () => turn } as unknown as RoomEar;

  const real = new OrderEngine();
  const shadow = new ShadowCart();
  const runner = new ToolRunner(real, { room }, shadow);
  let n = 0;

  return {
    real,
    shadow,
    /** Who spoke this turn, and what they said. */
    say(voice: Attribution, words: string) {
      heard = { ...voice, evidence: words };
      turn = words;
    },
    call(name: string, args: Record<string, unknown> = {}, resultReachesAgent = true) {
      return runner.run({ callId: `call_${++n}`, name, args, turnStartedAt: 0 }, resultReachesAgent);
    },
  };
}

const ticket = (snap: OrderSnapshot) =>
  snap.lines
    .filter((l) => l.status === "confirmed")
    .map(describeActual)
    .sort();

describe("the same calls, two carts", () => {
  test("260 nuggets: Backseat hands the lane to a person, the trusting cart books every one", () => {
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "I want two hundred and sixty chicken nuggets.");
    const out = call("add_item", { item: "chicken nuggets", quantity: 260 });

    assert.equal(out.status, "escalated");
    assert.deepEqual(ticket(real.snapshot()), []);
    assert.equal(real.snapshot().escalated, true);

    assert.deepEqual(ticket(shadow.snapshot()), ["260×Chicken Nuggets"]);
    assert.equal(shadow.snapshot().escalated, false);
    assert.ok(shadow.snapshot().total > 1000, "over a thousand dollars of nuggets");
  });

  test("a back-seat request is food on the left and a question on the right", () => {
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "I'll take a lab burger and a small coke.");
    call("add_item", { item: "lab burger" });
    call("add_item", { item: "coke", size: "small" });
    say(KID_VOICE, "And a chocolate shake! I want a chocolate shake!");
    call("add_item", { item: "chocolate shake" });

    assert.equal(real.snapshot().lines.find((l) => l.name === "Milkshake")?.status, "pending");
    assert.deepEqual(ticket(shadow.snapshot()), ["1×Cola/small", "1×Lab Burger", "1×Milkshake"]);
  });

  test("the driver's no takes a held request off the trusting cart too", () => {
    // The charitable reading: a single-ear agent would have heard "no shake" and
    // removed it. Leaving it on would make the naive cart look worse than it is.
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "I'll take a lab burger and a small coke.");
    call("add_item", { item: "lab burger" });
    call("add_item", { item: "coke", size: "small" });
    say(KID_VOICE, "And a chocolate shake! I want a chocolate shake!");
    call("add_item", { item: "chocolate shake" });
    say(DRIVER_VOICE, "No, no shake. That's everything.");
    call("confirm_held_item", { decision: "discard", item: "chocolate shake" });

    assert.deepEqual(ticket(real.snapshot()), ["1×Cola/small", "1×Lab Burger"]);
    assert.deepEqual(ticket(shadow.snapshot()), ticket(real.snapshot()));
  });

  test("a request nobody answered is sold by the trusting cart and dropped by Backseat", () => {
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "One veggie lab, please.");
    call("add_item", { item: "Veggie Lab", quantity: 1 });
    say(KID_VOICE, "And onion rings! Onion rings too!");
    call("add_item", { item: "onion rings", quantity: 1 });
    say(DRIVER_VOICE, "That's everything for me, thanks.");
    const consent = call("confirm_held_item", { decision: "add", item: "onion rings" });
    call("finalize_order");

    assert.equal(consent.status, "needs_confirmation", "moving on is not a yes");
    assert.deepEqual(ticket(real.snapshot()), ["1×Veggie Lab"]);
    assert.deepEqual(ticket(shadow.snapshot()), ["1×Onion Rings", "1×Veggie Lab"]);
  });

  test("the driver's yes does not book a held request twice on the trusting cart", () => {
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "Just a crispy chicken sandwich for me.");
    call("add_item", { item: "Crispy Chicken Sandwich", for_whom: "me" });
    say(KID_VOICE, "Can I have chicken nuggets? Nuggets please!");
    call("add_item", { item: "chicken nuggets" });
    say(DRIVER_VOICE, "Yeah, go ahead and add the nuggets for him.");
    call("confirm_held_item", { decision: "add", item: "chicken nuggets" });

    const expected = ["1×Chicken Nuggets", "1×Crispy Chicken Sandwich"];
    assert.deepEqual(ticket(real.snapshot()), expected);
    assert.deepEqual(ticket(shadow.snapshot()), expected);
    // Same food, different bags: only one cart knows the nuggets are the kid's.
    assert.equal(real.snapshot().lines.find((l) => l.name === "Chicken Nuggets")?.owner, "B");
    assert.equal(shadow.snapshot().lines.find((l) => l.name === "Chicken Nuggets")?.owner, "A");
  });

  test("a call repeated after a barge-in is the same work on both carts", () => {
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "A lab burger.");
    call("add_item", { item: "lab burger" }, false);
    call("add_item", { item: "lab burger" });

    assert.deepEqual(ticket(real.snapshot()), ["1×Lab Burger"]);
    assert.deepEqual(ticket(shadow.snapshot()), ["1×Lab Burger"]);
  });

  test("where nothing is hard the two carts agree, split lines included", () => {
    const { real, shadow, say, call } = lane();
    say(DRIVER_VOICE, "Two lab burgers and a large fries.");
    call("add_item", { item: "lab burgers", quantity: 2 });
    call("add_item", { item: "fries", size: "large" });
    say(DRIVER_VOICE, "Hers without pickles, just one of them.");
    call("modify_item", { item: "lab burgers", quantity: 1, remove_modifiers: ["pickles"], units: 1, whose: "theirs" });

    const expected = ["1×Fries/large", "1×Lab Burger", "1×Lab Burger+no pickles"];
    assert.deepEqual(ticket(real.snapshot()), expected);
    assert.deepEqual(ticket(shadow.snapshot()), expected);
  });
});
