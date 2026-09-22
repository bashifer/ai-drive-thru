import type { Attribution, RoomEar } from "./attribution";
import type { Size } from "./menu";
import type { ForWhom, OrderEngine, Outcome, Whose } from "./orderEngine";
import type { ShadowCart } from "./shadowCart";

/**
 * One place where a `tool.call` from the agent turns into a change on the ticket.
 * The browser app and the offline bench both go through here, so a scene run tests
 * the code that actually ships.
 */

export type DispatchOptions = {
  /** Diarization bookkeeping; null means nobody is listening for who spoke. */
  room: RoomEar | null;
  /** Start of the customer turn the agent is acting on. */
  turnStartedAt: number;
  /** Baseline mode: treat every voice as the driver, the way a single-ear agent does. */
  assumeDriver?: boolean;
};

const AS_DRIVER: Attribution = { speaker: "A", verdict: "driver", matchedPhrase: false, evidence: "" };

export type QueuedToolCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  turnStartedAt: number;
};

/** Calls that read who spoke or what they said, and so wait for the room ear. */
const LISTENS = new Set(["add_item", "modify_item", "remove_item", "confirm_held_item"]);

export type GateOptions = {
  /** Diarization bookkeeping; null means nobody is listening for who spoke. */
  room: RoomEar | null;
  /** Tools declared `execution_mode: "hold"` (`HELD_TOOLS` in agentConfig). */
  held: ReadonlySet<string>;
  /** Longest a call waits for the room ear before it runs on whatever is there. */
  maxWaitMs?: number;
  /** One reply's calls arrive tens of milliseconds apart; their results go back together. */
  settleMs?: number;
};

/**
 * When a tool call may run.
 *
 * An interactive tool's reply stays open ~2.3 s after the call for a transition phrase
 * this agent does not say, and its result may only go back once `reply.done` is the
 * latest event — so a reply with any interactive call in it runs at `reply.done`
 * (`drain`). That slot is also when the room ear catches up with who said what.
 *
 * A held tool keeps the agent silent until our result and answers ~50 ms after it, so
 * it runs as early as is safe: once the room ear has finished the turn, if the call
 * reads it — on the recorded lane the room ear's turn beat the tool call on all eight
 * customer turns — and never later than `maxWaitMs`, after which it runs on what is
 * there and the engine's fail-safes apply (an unplaced voice is the driver's, no words
 * is no yes).
 */
export class ToolGate {
  private calls: (QueuedToolCall & { at: number })[] = [];
  private maxWaitMs: number;
  private settleMs: number;

  constructor(private opts: GateOptions) {
    this.maxWaitMs = opts.maxWaitMs ?? 1500;
    this.settleMs = opts.settleMs ?? 120;
  }

  get size() {
    return this.calls.length;
  }

  add(call: QueuedToolCall, at: number) {
    this.calls.push({ ...call, at });
  }

  /** The calls to run now, in the order they came, or none yet. */
  due(at: number): QueuedToolCall[] {
    if (!this.calls.length || this.calls.some((c) => !this.opts.held.has(c.name))) return [];
    const first = this.calls[0];
    const last = this.calls[this.calls.length - 1];
    const settled = at - last.at >= this.settleMs;
    const room = this.opts.room;
    const heard =
      !room || !this.calls.some((c) => LISTENS.has(c.name)) || room.heardSince(first.turnStartedAt);
    if ((settled && heard) || at - first.at >= this.maxWaitMs) return this.drain();
    return [];
  }

  /** Everything still waiting, now: the reply they belong to is over. */
  drain(): QueuedToolCall[] {
    return this.calls
      .splice(0)
      .map(({ callId, name, args, turnStartedAt }) => ({ callId, name, args, turnStartedAt }));
  }
}

/**
 * Runs the agent's tool calls against the ticket, and remembers the ones whose
 * result never reached the agent.
 *
 * When a customer barges in, the reply that requested a tool call ends as
 * `interrupted` and its results must not be sent. The request itself was real
 * though — they did ask for that burger — so it is still applied to the ticket.
 * The agent, having had no answer, usually asks for the same thing again on the
 * next turn; that repeat is the same work, not a second burger, so it returns the
 * original outcome instead of tripping the repeat guard.
 *
 * With a shadow cart attached, every call that reaches the ticket reaches the shadow
 * too, and a repeat that is skipped here is skipped there: both carts see the same work.
 */
export class ToolRunner {
  private unacknowledged = new Map<string, { at: number; outcome: Outcome }>();

  constructor(
    private engine: OrderEngine,
    private opts: Omit<DispatchOptions, "turnStartedAt">,
    /** A/B mode: the same calls, also booked into a cart that trusts every one of them. */
    private shadow?: ShadowCart,
  ) {}

  private static key = (call: QueuedToolCall) => `${call.name}:${JSON.stringify(call.args)}`;

  run(call: QueuedToolCall, resultReachesAgent = true): Outcome {
    const key = ToolRunner.key(call);
    const twin = this.unacknowledged.get(key);

    if (twin && Date.now() - twin.at < 15000) {
      this.unacknowledged.delete(key);
      return twin.outcome;
    }

    const held = this.shadow ? this.engine.snapshot().lines.filter((l) => l.status === "pending") : [];

    const outcome = dispatchTool(this.engine, call.name, call.args, {
      ...this.opts,
      turnStartedAt: call.turnStartedAt,
    });

    if (this.shadow) {
      const kept = new Set(this.engine.snapshot().lines.map((l) => l.lineId));
      this.shadow.mirror(call, held.filter((l) => !kept.has(l.lineId)));
    }

    if (!resultReachesAgent) this.unacknowledged.set(key, { at: Date.now(), outcome });
    return outcome;
  }
}

export function dispatchTool(
  engine: OrderEngine,
  name: string,
  args: Record<string, unknown>,
  opts: DispatchOptions,
): Outcome {
  const spoken = typeof args.item === "string" ? args.item : "";
  const attribution: Attribution | undefined = opts.assumeDriver
    ? AS_DRIVER
    : spoken && opts.room
      ? opts.room.attribute(spoken, opts.turnStartedAt)
      : undefined;

  const quantity = typeof args.quantity === "number" ? args.quantity : undefined;
  const size = args.size as Size | undefined;
  const strings = (v: unknown) => (Array.isArray(v) ? (v as string[]) : undefined);

  // The agent speaks in people, not in diarization labels.
  const forWhom = (v: unknown): ForWhom | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.toLowerCase();
    if (s.includes("driver")) return "driver";
    if (s.includes("someone") || s.includes("another") || s.includes("else")) return "other";
    if (s.includes("me") || s.includes("them") || s.includes("speaker")) return "speaker";
    return undefined;
  };

  const whose = (v: unknown): Whose | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.toLowerCase();
    if (s.includes("driver")) return "driver";
    if (s.includes("their") || s.includes("her") || s.includes("his") || s.includes("other")) return "theirs";
    if (s.includes("mine") || s.includes("my") || s.includes("own")) return "mine";
    return undefined;
  };

  switch (name) {
    case "add_item":
      return engine.addItem({
        spoken,
        quantity,
        size,
        modifiers: strings(args.modifiers),
        attribution,
        forWhom: forWhom(args.for_whom),
        window: { from: opts.turnStartedAt, to: performance.now() },
      });

    case "modify_item":
      return engine.modifyItem({
        spoken,
        quantity,
        size,
        // Models reach for `modifiers` about as often as `add_modifiers`; accept both
        // rather than silently applying nothing.
        add_modifiers: strings(args.add_modifiers) ?? strings(args.modifiers),
        remove_modifiers: strings(args.remove_modifiers),
        attribution,
        whose: whose(args.whose),
        units: typeof args.units === "number" ? args.units : undefined,
      });

    case "remove_item":
      return engine.removeItem(spoken);

    case "confirm_held_item":
      return engine.resolvePending(
        spoken || undefined,
        args.decision === "discard" ? "discard" : "add",
        // The whole turn, not just the words that matched the item: consent lives in
        // "yeah, go ahead", which shares no words with "chicken nuggets".
        opts.room?.turnText(opts.turnStartedAt),
      );

    case "get_menu":
      return engine.menuFor(typeof args.category === "string" ? args.category : undefined);

    case "read_back_order": {
      const s = engine.summary();
      return {
        status: "ok",
        message: `Ticket: ${s.text}. Total $${s.total.toFixed(2)}.${
          s.pending.length ? ` Still unconfirmed: ${s.pending.join(", ")}.` : ""
        }${
          s.unverified.length
            ? ` Heard but not placed with a voice: ${s.unverified.join(
                ", ",
              )} — name those when you read back and ask if they belong on the order.`
            : ""
        }`,
      };
    }

    case "finalize_order":
      return engine.finalize();

    case "call_crew_member":
      return engine.escalate(typeof args.reason === "string" ? args.reason : "customer request");

    default:
      return { status: "rejected", message: `Unknown tool ${name}.` };
  }
}
