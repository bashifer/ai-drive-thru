import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Attribution } from "../src/lib/attribution";
import { GUARDS, OrderEngine } from "../src/lib/orderEngine";

/**
 * Transcript-level suite: the agent's tool calls go straight into the order engine,
 * no audio and no API. Phrasing is modelled on Google's Taskmaster-2 food-ordering
 * corpus (CC BY 4.0, 1,050 real ordering dialogues) — "actually, make that two",
 * "with no cheese", "ranch instead of marinara" — plus the failure modes that put
 * drive-thru voice AI in the news.
 */

const driver = (evidence = ""): Attribution => ({
  speaker: "A",
  verdict: "driver",
  matchedPhrase: true,
  evidence,
});

const backSeat = (evidence = ""): Attribution => ({
  speaker: "B",
  verdict: "other_voice",
  matchedPhrase: true,
  evidence,
});

const unknownVoice = (): Attribution => ({
  speaker: "UNKNOWN",
  verdict: "unverified",
  matchedPhrase: false,
  evidence: "",
});

const confirmed = (e: OrderEngine) => e.snapshot().lines.filter((l) => l.status === "confirmed");
const held = (e: OrderEngine) => e.snapshot().lines.filter((l) => l.status === "pending");
const names = (e: OrderEngine) => confirmed(e).map((l) => `${l.quantity}×${l.name}`);

describe("ordinary orders", () => {
  test("resolves what the customer actually said, not a menu name", () => {
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "double cheeseburger", quantity: 1, attribution: driver() });
    assert.equal(out.status, "ok");
    assert.deepEqual(names(e), ["1×Double Lab Burger"]);
  });

  test("sizes change the price, not just the label", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "fries", quantity: 1, size: "large", attribution: driver() });
    const [line] = confirmed(e);
    assert.equal(line.size, "large");
    assert.ok(line.unitPrice > 2.79, "large fries should cost more than small");
  });

  test("keeps only modifiers the item supports", () => {
    const e = new OrderEngine();
    e.addItem({
      spoken: "lab burger",
      quantity: 1,
      modifiers: ["no pickles", "extra sprinkles"],
      attribution: driver(),
    });
    assert.deepEqual(confirmed(e)[0].modifiers, ["no pickles"]);
  });

  test("a spanish item name in an english sentence still lands", () => {
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "papas fritas", quantity: 1, attribution: driver() });
    assert.equal(out.status, "ok");
    assert.deepEqual(names(e), ["1×Fries"]);
  });
});

describe("corrections, the way people actually phrase them", () => {
  test("'actually, make that two' changes the line instead of adding one", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.modifyItem({ spoken: "burger", quantity: 2, attribution: driver() });
    assert.deepEqual(names(e), ["2×Lab Burger"]);
  });

  test("'make it a large' upgrades the existing drink", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "coke", quantity: 1, size: "small", attribution: driver() });
    e.modifyItem({ spoken: "coke", size: "large", attribution: driver() });
    assert.equal(confirmed(e).length, 1);
    assert.equal(confirmed(e)[0].size, "large");
  });

  test("'no cheese on one of those' adds the modifier to the line on the ticket", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.modifyItem({ spoken: "lab burger", add_modifiers: ["no cheese"], attribution: driver() });
    assert.deepEqual(confirmed(e)[0].modifiers, ["no cheese"]);
  });

  test("cancelling an item takes it off", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "apple pie", quantity: 1, attribution: driver() });
    e.removeItem("pie");
    assert.equal(confirmed(e).length, 0);
  });

  test("changing an item that was never ordered asks instead of inventing a line", () => {
    const e = new OrderEngine();
    const out = e.modifyItem({ spoken: "onion rings", size: "large", attribution: driver() });
    assert.equal(out.status, "not_found");
    assert.equal(confirmed(e).length, 0);
  });
});

describe("the car is not one person", () => {
  test("a back-seat request is held, never silently added", () => {
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "chocolate shake", quantity: 1, attribution: backSeat("i want a shake") });
    assert.equal(out.status, "needs_confirmation");
    assert.equal(confirmed(e).length, 0);
    assert.equal(held(e).length, 1);
  });

  test("the driver's yes promotes the held item", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "chocolate shake", quantity: 1, attribution: backSeat() });
    const out = e.resolvePending("shake", "add");
    assert.equal(out.status, "ok");
    assert.deepEqual(names(e), ["1×Milkshake"]);
  });

  test("consent has to be spoken — moving on is not a yes", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "chocolate shake", quantity: 1, attribution: backSeat() });
    const out = e.resolvePending("shake", "add", "That's everything for me, thanks.");
    assert.equal(out.status, "needs_confirmation");
    assert.equal(confirmed(e).length, 0, "still off the ticket");

    const yes = e.resolvePending("shake", "add", "Yeah, go ahead.");
    assert.equal(yes.status, "ok");
    assert.deepEqual(names(e), ["1×Milkshake"]);
  });

  test("a turn the room ear has not heard yet is not a yes either", () => {
    // Bench, 21 Sep: the next lane's fries were held, the driver said "that's
    // everything", the agent called confirm_held_item(add) — and with no words from the
    // room ear yet, the empty turn skipped the consent check and sold them.
    const e = new OrderEngine();
    e.addItem({ spoken: "large fries", quantity: 2, size: "large", attribution: backSeat("two large fries") });
    const out = e.resolvePending("fries", "add", "");
    assert.equal(out.status, "needs_confirmation");
    assert.equal(confirmed(e).length, 0, "still off the ticket");

    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    assert.equal(e.resolvePending("bacon stack", "add", "").status, "needs_confirmation", "nor a second one");
  });

  test("the driver's no drops it without a trace on the ticket", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "chocolate shake", quantity: 1, attribution: backSeat() });
    e.resolvePending("shake", "discard");
    assert.equal(e.snapshot().lines.length, 0);
  });

  test("a voice the room ear could not place is trusted, but marked", () => {
    // Absence of evidence is not evidence of a back-seat voice: blocking here would
    // stall every order the diarization stream has not caught up with yet.
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "large fries", quantity: 1, attribution: unknownVoice() });
    assert.equal(out.status, "ok");
    assert.equal(confirmed(e).length, 1);
    assert.equal(confirmed(e)[0].unverified, true);
  });

  test("an item placed with the driver's voice is not marked", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "large fries", quantity: 1, attribution: driver("large fries") });
    assert.equal(confirmed(e)[0].unverified, false);
  });

  test("the ticket keeps who asked, so the bag can be split", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "nuggets", quantity: 1, attribution: backSeat() });
    e.resolvePending("nuggets", "add");
    const owners = new Set(confirmed(e).map((l) => l.owner));
    assert.deepEqual([...owners].sort(), ["A", "B"]);
  });
});

describe("one order, several people", () => {
  /**
   * The case the whole product exists for: four voices, one cart, and an item that
   * belongs to a person who is not the one speaking about it.
   */
  const carFullOfPeople = () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "two cheeseburgers", quantity: 2, attribution: driver() });
    e.addItem({ spoken: "large fries", quantity: 1, size: "large", attribution: driver() });
    return e;
  };

  test("a passenger's own item is held, then owned by them once the driver agrees", () => {
    const e = carFullOfPeople();
    e.addItem({ spoken: "cola", quantity: 1, attribution: backSeat("coke for me"), forWhom: "speaker" });
    assert.equal(held(e).length, 1);

    e.resolvePending("cola", "add");
    const cola = confirmed(e).find((l) => l.name === "Cola")!;
    assert.equal(cola.owner, "B", "the drink belongs to the passenger who asked");
    assert.equal(cola.requestedBy, "B");
  });

  test("the driver can order for someone else", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "milkshake", quantity: 1, attribution: driver(), forWhom: "other" });
    assert.equal(confirmed(e)[0].owner, "UNASSIGNED");
    assert.equal(confirmed(e)[0].requestedBy, "A");
  });

  test("'hers without pickles' splits the line instead of changing both burgers", () => {
    const e = carFullOfPeople();
    const out = e.modifyItem({
      spoken: "cheeseburger",
      add_modifiers: ["no pickles"],
      whose: "theirs",
      units: 1,
      attribution: driver(),
    });

    assert.equal(out.status, "ok");
    const burgers = confirmed(e).filter((l) => l.name === "Lab Burger");
    assert.equal(burgers.length, 2, "one line became two");
    assert.equal(
      burgers.filter((l) => l.modifiers.includes("no pickles")).length,
      1,
      "only one burger loses the pickles",
    );
    assert.equal(
      burgers.reduce((n, l) => n + l.quantity, 0),
      2,
      "still two burgers in total",
    );
  });

  test("'just one of them' scopes the change instead of shrinking the line", () => {
    // The model usually says this twice: units=1 and quantity=1. Only one of those
    // is a request to make a line of two into a line of one, and it is neither.
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 2, attribution: driver() });
    e.modifyItem({
      spoken: "lab burger",
      quantity: 1,
      units: 1,
      add_modifiers: ["no pickles"],
      whose: "theirs",
      attribution: driver(),
    });

    const burgers = confirmed(e).filter((l) => l.name === "Lab Burger");
    assert.equal(
      burgers.reduce((n, l) => n + l.quantity, 0),
      2,
      "both burgers survive",
    );
    assert.equal(burgers.filter((l) => l.modifiers.includes("no pickles")).length, 1);
  });

  test("a passenger may fix their own food without asking the driver", () => {
    const e = carFullOfPeople();
    e.addItem({ spoken: "crispy chicken", quantity: 1, attribution: backSeat(), forWhom: "speaker" });
    e.resolvePending("crispy chicken", "add");

    const out = e.modifyItem({ spoken: "crispy chicken", add_modifiers: ["spicy"], attribution: backSeat() });
    assert.equal(out.status, "ok");
    assert.ok(confirmed(e).find((l) => l.name === "Crispy Chicken Sandwich")!.modifiers.includes("spicy"));
  });

  test("a correction too short to place with a voice is the driver's, not a stranger's", () => {
    // "Make it small" is under a second of speech, and the room ear often has no label
    // for it yet. Reading that as a passenger bounced the driver's own correction back
    // to them as a permission question.
    const e = carFullOfPeople();
    const out = e.modifyItem({ spoken: "large fries", size: "small", attribution: unknownVoice() });
    assert.equal(out.status, "ok");
    assert.equal(confirmed(e).find((l) => l.name === "Fries")!.size, "small");
  });

  test("a passenger may not quietly change the driver's food", () => {
    const e = carFullOfPeople();
    const out = e.modifyItem({ spoken: "large fries", size: "small", attribution: backSeat(), whose: "driver" });
    assert.equal(out.status, "needs_confirmation");
    assert.equal(confirmed(e).find((l) => l.name === "Fries")!.size, "large", "the driver's fries are untouched");
  });

  test("the read-back is per person once more than one has ordered", () => {
    const e = carFullOfPeople();
    e.addItem({ spoken: "cola", quantity: 1, attribution: backSeat(), forWhom: "speaker" });
    e.resolvePending("cola", "add");

    const text = e.summary().text;
    assert.match(text, /Driver:/);
    assert.match(text, /Guest B:/);
  });
});

describe("guards against the failures that made the news", () => {
  test("260 nuggets never reaches the kitchen", () => {
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "nuggets", quantity: 260, attribution: driver() });
    assert.equal(out.status, "escalated");
    assert.equal(confirmed(e).length, 0);
    assert.equal(e.snapshot().escalated, true);
  });

  test("18,000 waters hands the lane to a human", () => {
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "water", quantity: 18000, attribution: driver() });
    assert.equal(out.status, "escalated");
    assert.equal(e.snapshot().escalated, true);
  });

  test("a handover does not invite the next item", () => {
    // Bench, 22 Sep: "A team member is coming on the line. What else can I help with?"
    for (const out of [
      new OrderEngine().addItem({ spoken: "nuggets", quantity: 260, attribution: driver() }),
      new OrderEngine().escalate("customer asked for a manager"),
    ]) {
      assert.equal(out.status, "escalated");
      assert.match(out.message, /do not ask what else/i);
    }
  });

  test("a merely large quantity is confirmed, not refused", () => {
    const e = new OrderEngine();
    const qty = GUARDS.confirmQuantity + 1;
    const out = e.addItem({ spoken: "nuggets", quantity: qty, attribution: driver() });
    assert.equal(out.status, "needs_confirmation");
    assert.equal(held(e).length, 1);
    e.resolvePending("nuggets", "add");
    assert.deepEqual(names(e), [`${qty}×Chicken Nuggets`]);
  });

  test("the same item twice in seconds is a question, not a second burger", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    const out = e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    assert.equal(out.status, "needs_confirmation");
    assert.equal(confirmed(e).length, 1);
  });

  test("a customer who does want a second one gets it", () => {
    // The repeat question used to be a dead end: nothing was held, so a yes found
    // nothing to confirm, and the add_item it was told to make hit the guard again.
    const e = new OrderEngine();
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    const out = e.resolvePending("bacon stack", "add", "Yes, two please.");
    assert.equal(out.status, "ok");
    assert.deepEqual(names(e), ["2×Bacon Stack"]);
  });

  test("'just the one' keeps the first and says so", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    const out = e.resolvePending("bacon stack", "discard");
    assert.equal(out.status, "ok");
    assert.match(out.message, /one Bacon Stack/);
    assert.deepEqual(names(e), ["1×Bacon Stack"]);
  });

  test("moving on is not a yes to a second one either", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    const out = e.resolvePending("bacon stack", "add", "That's everything.");
    assert.equal(out.status, "needs_confirmation");
    assert.deepEqual(names(e), ["1×Bacon Stack"]);
  });

  test("the repeat question closes once the order moves on", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "bacon stack", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "large fries", quantity: 1, size: "large", attribution: driver() });
    assert.equal(e.resolvePending(undefined, "add", "Yes").status, "not_found");
    assert.deepEqual(names(e), ["1×Bacon Stack", "1×Fries"]);
  });

  test("another voice asking for the same thing is a request, not a repeat", () => {
    // "And a burger for me!" from the back seat right after the driver's burger is not
    // the driver saying it twice. Asking "a second one?" would put the kid's burger on
    // the driver's line.
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    const out = e.addItem({ spoken: "lab burger", quantity: 1, attribution: backSeat("a burger for me") });
    assert.equal(out.status, "needs_confirmation");
    assert.match(out.message, /another voice/);
    assert.equal(held(e)[0]?.owner, "B");
  });

  test("a held back-seat request and a repeat question are settled by name", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "chocolate shake", quantity: 1, attribution: backSeat() });

    e.resolvePending("shake", "add", "Yes, the shake too.");
    assert.deepEqual(names(e).sort(), ["1×Lab Burger", "1×Milkshake"]);
    e.resolvePending("lab burger", "add", "And yes, two burgers.");
    assert.deepEqual(names(e).sort(), ["1×Milkshake", "2×Lab Burger"]);
  });

  test("a modification into an absurd quantity is caught too", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "nuggets", quantity: 1, attribution: driver() });
    const out = e.modifyItem({ spoken: "nuggets", quantity: 500, attribution: driver() });
    assert.equal(out.status, "escalated");
  });
});

describe("refusing to guess", () => {
  test("an item that is not on the menu is not invented", () => {
    const e = new OrderEngine();
    const out = e.addItem({ spoken: "lobster roll", quantity: 1, attribution: driver() });
    assert.equal(out.status, "not_found");
    assert.equal(e.snapshot().lines.length, 0);
  });

  test("breakfast hours do not sell burgers", () => {
    const e = new OrderEngine();
    e.setDaypart("breakfast");
    const out = e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    assert.equal(out.status, "not_found");
  });

  test("the menu lookup only returns what exists", () => {
    const e = new OrderEngine();
    const out = e.menuFor("desserts");
    assert.match(out.message, /Milkshake/);
    assert.doesNotMatch(out.message, /Burger/);
  });
});

describe("closing the order", () => {
  test("an item nobody confirmed is dropped at the total, not sold", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "shake", quantity: 1, attribution: backSeat() });
    const out = e.finalize();
    assert.equal(out.status, "ok");
    assert.match(out.message, /Milkshake/, "the agent has to say what was left off");
    assert.deepEqual(names(e), ["1×Lab Burger"]);
    assert.equal(e.snapshot().lines.length, 1, "the held line is gone, not lingering");
  });

  test("the kitchen ticket records when it was sent and what was left off", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "shake", quantity: 1, attribution: backSeat() });
    assert.equal(e.snapshot().sentAt, null, "nothing has gone to the kitchen yet");

    e.finalize();
    const snap = e.snapshot();
    assert.ok(snap.sentAt !== null && snap.sentAt > 0);
    assert.deepEqual(snap.notSent, [{ name: "Milkshake", quantity: 1 }]);

    e.reset();
    assert.equal(e.snapshot().sentAt, null);
    assert.deepEqual(e.snapshot().notSent, []);
  });

  test("totals include tax and only confirmed lines", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 2, attribution: driver() });
    e.addItem({ spoken: "shake", quantity: 1, attribution: backSeat() });
    const snap = e.snapshot();
    assert.equal(snap.subtotal, +(5.49 * 2).toFixed(2));
    assert.ok(snap.total > snap.subtotal, "tax should be added");
  });

  test("an empty ticket cannot be finalized", () => {
    const e = new OrderEngine();
    assert.equal(e.finalize().status, "rejected");
  });

  test("a clean order closes", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "crispy chicken", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "large fries", quantity: 1, size: "large", attribution: driver() });
    const out = e.finalize();
    assert.equal(out.status, "ok");
    assert.equal(e.snapshot().finalized, true);
  });

  test("the close carries the ticket to say back, so closing is one call", () => {
    // Every tool call is a silent wait for the car. Closing used to be read_back_order,
    // then finalize_order: two of them after "that's everything".
    const e = new OrderEngine();
    e.addItem({ spoken: "double cheeseburger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "large fries", quantity: 1, size: "large", attribution: driver() });
    const out = e.finalize();
    assert.match(out.message, /Double Lab Burger/);
    assert.match(out.message, /large Fries/);
  });

  test("closing asks once about food nobody could place with a voice, then closes", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "lab burger", quantity: 1, attribution: driver() });
    e.addItem({ spoken: "nuggets", quantity: 1, attribution: unknownVoice() });

    const ask = e.finalize();
    assert.equal(ask.status, "needs_confirmation");
    assert.match(ask.message, /Chicken Nuggets/);
    assert.equal(e.snapshot().finalized, false, "nothing goes to the kitchen while that question is open");

    const out = e.finalize();
    assert.equal(out.status, "ok", "asked once: the next call closes");
    assert.equal(e.snapshot().finalized, true);
  });

  test("a line added after that question is asked about too", () => {
    const e = new OrderEngine();
    e.addItem({ spoken: "nuggets", quantity: 1, attribution: unknownVoice() });
    assert.equal(e.finalize().status, "needs_confirmation");
    e.addItem({ spoken: "small coke", quantity: 1, size: "small", attribution: unknownVoice() });

    const again = e.finalize();
    assert.equal(again.status, "needs_confirmation");
    assert.match(again.message, /Cola/);
    assert.doesNotMatch(again.message, /Nuggets/, "the nuggets were already asked about");
  });
});
