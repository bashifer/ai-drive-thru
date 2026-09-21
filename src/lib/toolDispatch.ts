import type { Attribution, RoomEar } from "./attribution";
import type { Size } from "./menu";
import type { ForWhom, OrderEngine, Outcome, Whose } from "./orderEngine";

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
 */
export class ToolRunner {
  private unacknowledged = new Map<string, { at: number; outcome: Outcome }>();

  constructor(
    private engine: OrderEngine,
    private opts: Omit<DispatchOptions, "turnStartedAt">,
  ) {}

  private static key = (call: QueuedToolCall) => `${call.name}:${JSON.stringify(call.args)}`;

  run(call: QueuedToolCall, resultReachesAgent = true): Outcome {
    const key = ToolRunner.key(call);
    const twin = this.unacknowledged.get(key);

    if (twin && Date.now() - twin.at < 15000) {
      this.unacknowledged.delete(key);
      return twin.outcome;
    }

    const outcome = dispatchTool(this.engine, call.name, call.args, {
      ...this.opts,
      turnStartedAt: call.turnStartedAt,
    });

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
