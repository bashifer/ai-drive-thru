import { OrderEngine, type OrderLine, type OrderSnapshot } from "./orderEngine";
import { describeLine } from "./scoring";
import { dispatchTool, type QueuedToolCall } from "./toolDispatch";

/**
 * The same conversation, booked into a cart that trusts every call.
 *
 * A/B mode runs this beside the real ticket. Every tool call the agent makes goes to
 * both carts; only Backseat's answers go back to the agent, so there is one
 * conversation and two bookkeepers. The shadow is the bench's `--baseline` cart — one
 * ear, every voice treated as the driver, no guards — so the gap between the two
 * receipts is exactly what attribution and the guards did on this call.
 *
 * One call needs a reading rather than a replay. `confirm_held_item` only exists
 * because Backseat held something back and asked the driver; the trusting cart booked
 * that item the moment it was named. A driver's "no" therefore becomes the remove_item
 * a single-ear agent would have made, and a "yes" changes nothing. That is the most
 * charitable reading of the naive cart, so the gap on screen is a lower bound, never
 * an exaggeration.
 */
export class ShadowCart {
  private engine = new OrderEngine({ guards: false, speakerAware: false });

  /**
   * Book one call. `declined` is what the same call took off Backseat's ticket from
   * the lines it was holding, which is how a "no" is recognised without guessing
   * which item it was about.
   */
  mirror(call: QueuedToolCall, declined: OrderLine[]) {
    if (call.name === "confirm_held_item") {
      for (const line of declined) this.engine.removeItem(line.name);
      return;
    }
    dispatchTool(this.engine, call.name, call.args, {
      room: null,
      turnStartedAt: call.turnStartedAt,
      assumeDriver: true,
    });
  }

  snapshot(): OrderSnapshot {
    return this.engine.snapshot();
  }

  setDaypart(daypart: "breakfast" | "allday") {
    this.engine.setDaypart(daypart);
  }

  reset() {
    this.engine.reset();
  }
}

/** Food on the trusting cart that Backseat did not book, and whether it is waiting on the driver. */
export type Gap = { tag: "held" | "absent"; units: number };

/**
 * What the trusting cart booked that Backseat did not: held for the driver, or never on
 * its ticket at all. Counted in units of what the kitchen reads — item, size, modifiers —
 * so "2 × Bacon Stack" and two lines of one are the same food, and the trusting cart's
 * blindness to whose food it is does not count against it.
 */
export function compareCarts(trusting: OrderSnapshot, real: OrderSnapshot) {
  const kind = (l: OrderLine) => describeLine({ item: l.name, qty: 1, size: l.size, modifiers: l.modifiers });
  const units = (lines: OrderLine[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(kind(line), (counts.get(kind(line)) ?? 0) + line.quantity);
    return counts;
  };
  const take = (counts: Map<string, number>, key: string, wanted: number) => {
    const got = Math.min(counts.get(key) ?? 0, wanted);
    counts.set(key, (counts.get(key) ?? 0) - got);
    return got;
  };

  const booked = units(real.lines.filter((l) => l.status === "confirmed"));
  const held = units(real.lines.filter((l) => l.status === "pending"));
  const gaps = new Map<string, Gap>();
  for (const line of trusting.lines) {
    const key = kind(line);
    const extra = line.quantity - take(booked, key, line.quantity);
    if (!extra) continue;
    gaps.set(line.lineId, { tag: take(held, key, extra) === extra ? "held" : "absent", units: extra });
  }

  return {
    gaps,
    extra: trusting.lines.flatMap((l) => {
      const gap = gaps.get(l.lineId);
      return gap ? [`${gap.units} × ${l.name}`] : [];
    }),
    money: +(trusting.total - real.total).toFixed(2),
  };
}
