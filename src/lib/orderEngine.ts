"use client";

import type { Attribution } from "./attribution";
import {
  MENU,
  TAX_RATE,
  canonicalModifier,
  isBackChannel,
  saysYes,
  modifiersInPhrase,
  priceOf,
  resolveMenuItem,
  type MenuItem,
  type Size,
} from "./menu";

/**
 * A drive-thru order is not a transcript with a total at the bottom. It is a
 * multi-party conversation in which several people build one cart: the driver
 * orders, a passenger adds something for themselves, a child shouts, and the
 * driver then corrects an item that belongs to someone else.
 *
 * So the engine tracks two different things per line:
 *   owner       — whose food this is
 *   requestedBy — which voice asked for it
 *
 * They are usually the same and sometimes not ("and hers without pickles"). Every
 * mutation carries both, which is what makes a split bag, a permission rule and an
 * audit trail possible at all. The model proposes; this code decides.
 *
 * The guards exist because of how drive-thru voice AI failed in public: 260 nuggets
 * on one ticket, a prank order for 18,000 waters, and items picked up from the next
 * lane or the back seat.
 */

export const GUARDS = {
  /** Above this a quantity has to be confirmed out loud. */
  confirmQuantity: 6,
  /** Above this the agent stops and hands the lane to a human. */
  escalateQuantity: 20,
  /** Above this an order total is treated as abnormal. */
  escalateTotal: 150,
  /** An item repeated back-to-back within this window is the customer repeating themselves. */
  repeatWindowMs: 60000,
};

export const UNASSIGNED = "UNASSIGNED";
/**
 * The person the agent is talking to, before diarization has a name for them.
 * A line heard with no voice evidence belongs here: the conversation is with the
 * driver by default, and "we could not place this voice" is not a reason to hand
 * someone else's food to a stranger.
 */
export const DRIVER = "DRIVER";

/** A label the room ear could not attach to anyone: too short, too noisy, or not heard yet. */
const unplaced = (speaker: string) => speaker === UNASSIGNED || speaker === "UNKNOWN" || speaker === "PENDING";

export type LineStatus = "confirmed" | "pending";

/** Who an item is for, as the customer would express it. */
export type ForWhom = "speaker" | "driver" | "other";

/** Whose item a correction is aimed at: "mine", "hers", "the driver's". */
export type Whose = "mine" | "theirs" | "driver";

export type OrderLine = {
  lineId: string;
  itemId: string;
  name: string;
  quantity: number;
  size?: Size;
  modifiers: string[];
  unitPrice: number;
  status: LineStatus;
  /** Whose food this is. */
  owner: string;
  /** Which voice asked for it. */
  requestedBy: string;
  /** Heard by the focused ear, but the room ear could not place it with a voice. */
  unverified: boolean;
  addedAt: number;
  /** The slice of the conversation this line was attributed from, for a second look later. */
  heardFrom: number;
  heardTo: number;
  evidence: string;
};

export type OrderFlag = {
  id: string;
  kind: "quantity" | "repeat" | "side_voice" | "total" | "escalation" | "ambiguous" | "permission";
  message: string;
  at: number;
};

export type OrderSnapshot = {
  lines: OrderLine[];
  flags: OrderFlag[];
  subtotal: number;
  tax: number;
  total: number;
  daypart: "breakfast" | "allday";
  escalated: boolean;
  finalized: boolean;
  /** When the ticket went to the kitchen (Date.now()), once the order is closed. */
  sentAt: number | null;
  /** Held lines nobody confirmed: left off the kitchen ticket when the order closed. */
  notSent: { name: string; quantity: number }[];
  driver: string | null;
};

export type Outcome = {
  status: "ok" | "needs_confirmation" | "ambiguous" | "rejected" | "not_found" | "escalated";
  message: string;
  line?: Pick<OrderLine, "name" | "quantity" | "size" | "modifiers" | "status" | "owner" | "requestedBy">;
  options?: string[];
  order_total?: number;
};

export type EngineOptions = {
  /** Quantity, repeat and total guards. Off = the naive agent the news wrote about. */
  guards?: boolean;
  /** Attribute and gate by voice. Off = single-ear behaviour, everyone is the driver. */
  speakerAware?: boolean;
};

export type AddArgs = {
  spoken: string;
  quantity?: number;
  size?: Size;
  modifiers?: string[];
  attribution?: Attribution;
  forWhom?: ForWhom;
  /** Conversation window the attribution came from (performance.now ms). */
  window?: { from: number; to: number };
};

export type ModifyArgs = {
  spoken: string;
  quantity?: number;
  size?: Size;
  add_modifiers?: string[];
  remove_modifiers?: string[];
  attribution?: Attribution;
  /** Which person's item the correction is aimed at. */
  whose?: Whose;
  /** How many units of a multi-unit line the correction applies to. */
  units?: number;
};

let lineCounter = 0;
const newLineId = () => `line_${++lineCounter}`;

/**
 * Display name for whoever a line belongs to. Uses the engine's own notion of the
 * driver, which is what ownership is decided against, not the room ear's latest guess.
 */
export function ownerLabel(owner: string, driver: string | null): string {
  if (owner === UNASSIGNED) return "Unassigned";
  if (owner === DRIVER || (driver !== null && owner === driver)) return "Driver";
  return `Guest ${owner}`;
}

export class OrderEngine {
  private lines: OrderLine[] = [];
  private flags: OrderFlag[] = [];
  private daypart: "breakfast" | "allday" = "allday";
  private escalated = false;
  private finalized = false;
  private sentAt: number | null = null;
  private notSent: { name: string; quantity: number }[] = [];
  private guards: boolean;
  private speakerAware: boolean;
  /** The voice the agent is in conversation with. */
  private driver: string | null = null;
  /** Whether the room ear has actually confirmed that voice as the primary one. */
  private driverConfident = false;
  /** An item said twice in a row that the agent is asking about: "did you want a second one?" */
  private repeatQuestion: { itemId: string; name: string; at: number } | null = null;
  /** Lines nobody could place with a voice that the agent has already asked about before closing. */
  private askedBeforeClosing = new Set<string>();

  constructor(opts: EngineOptions = {}) {
    this.guards = opts.guards ?? true;
    this.speakerAware = opts.speakerAware ?? true;
  }

  snapshot(): OrderSnapshot {
    const subtotal = this.lines
      .filter((l) => l.status === "confirmed")
      .reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    const tax = +(subtotal * TAX_RATE).toFixed(2);
    return {
      lines: [...this.lines],
      flags: [...this.flags],
      subtotal: +subtotal.toFixed(2),
      tax,
      total: +(subtotal + tax).toFixed(2),
      daypart: this.daypart,
      escalated: this.escalated,
      finalized: this.finalized,
      sentAt: this.sentAt,
      notSent: [...this.notSent],
      driver: this.driver,
    };
  }

  setDaypart(daypart: "breakfast" | "allday") {
    this.daypart = daypart;
  }

  reset() {
    this.lines = [];
    this.flags = [];
    this.escalated = false;
    this.finalized = false;
    this.sentAt = null;
    this.notSent = [];
    this.driver = null;
    this.driverConfident = false;
    this.repeatQuestion = null;
    this.askedBeforeClosing.clear();
  }

  private flag(kind: OrderFlag["kind"], message: string) {
    this.flags.unshift({
      id: `flag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      kind,
      message,
      at: Date.now(),
    });
    this.flags = this.flags.slice(0, 12);
  }

  private find(spoken: string): { item?: MenuItem; options?: string[] } {
    const matches = resolveMenuItem(spoken, this.daypart);
    if (!matches.length) return {};
    // Two candidates are a real question only when they are almost equally likely;
    // "small garlic fry" beats plain "fries" clearly enough to act on.
    if (matches.length > 1 && matches[1].score > matches[0].score - 0.08) {
      return { item: matches[0].item, options: matches.slice(0, 3).map((m) => m.item.name) };
    }
    return { item: matches[0].item };
  }

  /**
   * The first identified voice to talk to the agent is the driver.
   *
   * Waiting for the room ear to be *sure* first is too slow: diarization needs a
   * second of audio, and by then the first two items are already on the ticket with
   * nobody to own them. A voice the room ear has positively placed with someone else
   * is the one case that cannot be the driver.
   */
  private noteSpeaker(attribution?: Attribution) {
    const speaker = attribution?.speaker;
    if (!speaker || unplaced(speaker)) return;

    const confirmed = attribution?.verdict === "driver";

    if (this.driver === null) {
      if (attribution?.verdict === "other_voice") return;
      this.adoptDriver(speaker, confirmed);
      return;
    }

    // The first voice heard is only a guess. Once the room ear names a primary
    // speaker, a guess made on thin evidence gives way — otherwise one early
    // mislabel swaps the driver and a passenger for the rest of the order.
    if (!this.driverConfident && confirmed && speaker !== this.driver) {
      this.adoptDriver(speaker, true);
    }
  }

  private adoptDriver(speaker: string, confident: boolean) {
    const previous = this.driver;
    this.driver = speaker;
    this.driverConfident = confident;
    for (const line of this.lines) {
      if (line.owner === DRIVER || (previous && line.owner === previous)) line.owner = speaker;
      if (line.requestedBy === DRIVER || (previous && line.requestedBy === previous)) line.requestedBy = speaker;
    }
  }

  private isDriver(speaker: string) {
    return speaker === DRIVER || (this.driver !== null && speaker === this.driver);
  }

  private ownerFor(speaker: string, forWhom: ForWhom | undefined): string {
    if (forWhom === "driver") return this.driver ?? DRIVER;
    if (forWhom === "other") return UNASSIGNED;
    return unplaced(speaker) ? (this.driver ?? DRIVER) : speaker;
  }

  addItem(args: AddArgs): Outcome {
    this.noteSpeaker(args.attribution);

    const quantity = Math.max(1, Math.round(args.quantity ?? 1));
    const { item, options } = this.find(args.spoken);

    if (!item) {
      return {
        status: "not_found",
        message: `"${args.spoken}" is not on the Burger Lab menu. Do not invent it. Call get_menu and offer only what it returns.`,
      };
    }

    // "Uh-huh" is a customer letting you finish, not a customer ordering milk.
    const evidence = args.attribution?.evidence ?? "";
    if (evidence && isBackChannel(evidence)) {
      this.flag("ambiguous", `Ignored "${item.name}" — the customer only said "${evidence.trim()}"`);
      return {
        status: "rejected",
        message: `The only words heard there were "${evidence.trim()}" — that is the customer agreeing, not ordering. Nothing was added. Carry on.`,
      };
    }

    if (options) {
      this.flag("ambiguous", `Heard "${args.spoken}" — could be ${options.join(" or ")}`);
      return {
        status: "ambiguous",
        message: `"${args.spoken}" matches more than one item. Ask which one, do not pick for them.`,
        options,
      };
    }

    if (this.guards && quantity > GUARDS.escalateQuantity) {
      this.escalated = true;
      this.flag("escalation", `Refused ${quantity} × ${item.name} — handed to crew`);
      return {
        status: "escalated",
        message: `${quantity} × ${item.name} is beyond what this lane takes by voice. Tell the customer a team member will handle an order that size, and stop taking new items.`,
      };
    }

    const speaker = args.attribution?.speaker ?? UNASSIGNED;
    const verdict = args.attribution?.verdict ?? "unverified";
    // Only a positive identification of another voice holds an item back.
    const sideVoice = this.speakerAware && verdict === "other_voice";

    // Repeat-loop guard: the failure mode behind "260 nuggets".
    //
    // What makes a repeat is conversational, not temporal: the same item asked for
    // again with nothing ordered in between, and no number attached. A drive-thru
    // speaker is bad enough that people say things twice, and the gap between the
    // two tries is however long the agent took to answer. It is one person saying it
    // twice: the same item from another voice is that person's request.
    const last = this.lines[this.lines.length - 1];
    const backToBack =
      this.guards &&
      !sideVoice &&
      last?.itemId === item.id &&
      last.status === "confirmed" &&
      quantity === 1 &&
      Date.now() - last.addedAt < GUARDS.repeatWindowMs;
    if (backToBack) {
      this.repeatQuestion = { itemId: item.id, name: item.name, at: Date.now() };
      this.flag("repeat", `"${item.name}" asked for twice in a row — asked instead of stacking`);
      return {
        status: "needs_confirmation",
        message: `${item.name} is already on the ticket. Ask whether they want a second one or were repeating themselves. If they say one is enough — "just the one" — call confirm_held_item with discard. If they do want another, call confirm_held_item with add, not add_item. Never call remove_item here: the first one stays.`,
      };
    }

    const requestedBy = unplaced(speaker) ? (this.driver ?? DRIVER) : speaker;
    const needsQuantityCheck = this.guards && quantity > GUARDS.confirmQuantity;

    const line: OrderLine = {
      lineId: newLineId(),
      itemId: item.id,
      name: item.name,
      quantity,
      size: args.size,
      modifiers: Array.from(
        new Set([
          ...(args.modifiers ?? []).map((m) => canonicalModifier(item, m)).filter((m): m is string => m !== null),
          // "a large diet coke" carries its own modifier in the item name.
          ...modifiersInPhrase(item, args.spoken),
        ]),
      ),
      unitPrice: priceOf(item, args.size),
      status: sideVoice || needsQuantityCheck ? "pending" : "confirmed",
      owner: this.ownerFor(speaker, args.forWhom),
      requestedBy,
      unverified: verdict === "unverified",
      addedAt: Date.now(),
      heardFrom: args.window?.from ?? 0,
      heardTo: args.window?.to ?? 0,
      evidence: args.attribution?.evidence ?? args.spoken,
    };
    this.lines.push(line);
    // The driver has moved on, so "a second one?" is no longer the open question. A
    // shout from the back seat is not an answer to it.
    if (!sideVoice) this.repeatQuestion = null;

    if (needsQuantityCheck) {
      this.flag("quantity", `${quantity} × ${item.name} held for confirmation`);
      return {
        status: "needs_confirmation",
        message: `${quantity} × ${item.name} is a large quantity. Repeat the number back and ask them to confirm before it is added.`,
        line,
      };
    }

    if (sideVoice) {
      this.flag("side_voice", `"${item.name}" came from a voice that is not the driver`);
      return {
        status: "needs_confirmation",
        message: `${item.name} came from another voice, not the person you are talking to. Ask the driver whether to add it — say "another voice", do not guess where they were sitting. It stays off the ticket until they say yes.`,
        line,
      };
    }

    const total = this.snapshot().total;
    if (this.guards && total > GUARDS.escalateTotal) {
      this.escalated = true;
      this.flag("total", `Order total $${total.toFixed(2)} over the voice limit`);
      return {
        status: "escalated",
        message: `The order total passed $${GUARDS.escalateTotal}. Tell the customer a team member will take it from here.`,
        order_total: total,
      };
    }

    return {
      status: "ok",
      message: `Added ${quantity} × ${item.name}${args.size ? ` (${args.size})` : ""}. Order total $${total.toFixed(2)}.`,
      line,
      order_total: total,
    };
  }

  /**
   * Approve or drop a line that was held back (another voice, big quantity, repeat).
   *
   * An "add" needs the driver to have actually said yes. "That's everything for me,
   * thanks" is a customer moving on, and reading it as consent is how a back-seat
   * request ends up on a stranger's bill.
   */
  resolvePending(spoken: string | undefined, decision: "add" | "discard", evidence?: string): Outcome {
    const pending = this.lines.filter((l) => l.status === "pending");
    const named = spoken ? this.find(spoken).item : undefined;

    // "Did you want a second one?" is a question about a line already on the ticket,
    // not about a held one. It is answered here — otherwise a customer who does want
    // two is told to add it, and the add is asked about all over again.
    const question = this.openRepeatQuestion();
    const aboutRepeat =
      question &&
      (named
        ? named.id === question.itemId && !pending.some((l) => l.itemId === named.id)
        : !pending.some((l) => l.addedAt > question.at));
    if (question && aboutRepeat) return this.answerRepeat(question, decision, evidence);

    if (!pending.length) {
      return {
        status: "not_found",
        message:
          "Nothing is waiting for confirmation. If the customer just agreed to an item that was talked about but never added, call add_item for it now.",
      };
    }

    let target = pending[pending.length - 1];
    if (named) {
      const match = [...pending].reverse().find((l) => l.itemId === named.id);
      if (match) target = match;
    }

    if (decision === "discard") {
      this.lines = this.lines.filter((l) => l.lineId !== target.lineId);
      return { status: "ok", message: `Dropped ${target.name}. It never reached the ticket.` };
    }

    const noYes = this.noSpokenYes(evidence);
    if (noYes) {
      this.flag("side_voice", `No spoken yes for ${target.name} — still held`);
      return {
        status: "needs_confirmation",
        message: `${noYes}, so ${target.name} is still off the ticket. Ask the driver one plain question — "add the ${target.name}?" — and only call this again when they answer.`,
      };
    }

    target.status = "confirmed";
    const total = this.snapshot().total;
    return {
      status: "ok",
      message: `Confirmed ${target.quantity} × ${target.name}. Order total $${total.toFixed(2)}.`,
      order_total: total,
    };
  }

  /**
   * Consent is a yes somebody said. `evidence` is the whole turn from the room ear:
   * undefined means there is no room ear to ask (unit tests, the single-ear baseline),
   * and an empty turn means it has not heard the driver yet — which is not a yes. Reading
   * silence as consent is how the next lane's fries were sold in the 21 Sep bench run.
   */
  private noSpokenYes(evidence: string | undefined): string | null {
    if (!this.speakerAware || evidence === undefined || saysYes(evidence)) return null;
    return evidence.trim() ? `Nothing in "${evidence.trim()}" was a yes` : "No yes was heard from the driver";
  }

  private openRepeatQuestion() {
    const question = this.repeatQuestion;
    if (question && Date.now() - question.at < GUARDS.repeatWindowMs) return question;
    this.repeatQuestion = null;
    return null;
  }

  /** "Just the one" keeps the line as it is; "yes, two" makes it two — on a spoken yes. */
  private answerRepeat(
    question: { itemId: string; name: string },
    decision: "add" | "discard",
    evidence?: string,
  ): Outcome {
    if (decision === "discard") {
      this.repeatQuestion = null;
      return { status: "ok", message: `Kept one ${question.name}; nothing was added.` };
    }

    const noYes = this.noSpokenYes(evidence);
    if (noYes) {
      return {
        status: "needs_confirmation",
        message: `${noYes}, so there is still one ${question.name}. Ask once — "a second ${question.name}?" — and only call this again when they answer.`,
      };
    }

    this.repeatQuestion = null;
    const line = [...this.lines].reverse().find((l) => l.itemId === question.itemId && l.status === "confirmed");
    if (!line) {
      return { status: "not_found", message: `${question.name} is no longer on the ticket. Ask whether they want one.` };
    }
    line.quantity += 1;
    const total = this.snapshot().total;
    return {
      status: "ok",
      message: `Now ${line.quantity} × ${line.name}. Order total $${total.toFixed(2)}.`,
      order_total: total,
    };
  }

  /**
   * Pick the line a correction is aimed at. "Mine" and "hers" are the difference
   * between fixing your own burger and fixing someone else's.
   */
  private targetLine(itemId: string, speaker: string, whose?: Whose): OrderLine | undefined {
    const candidates = this.lines.filter((l) => l.itemId === itemId);
    if (!candidates.length) return undefined;

    const byOwner = (pred: (l: OrderLine) => boolean) => [...candidates].reverse().find(pred);

    if (whose === "mine") return byOwner((l) => l.owner === speaker) ?? byOwner(() => true);
    if (whose === "driver") return byOwner((l) => l.owner === this.driver) ?? byOwner(() => true);
    if (whose === "theirs") return byOwner((l) => l.owner !== speaker) ?? byOwner(() => true);
    return byOwner(() => true);
  }

  /**
   * "No pickles" is a modifier the kitchen understands; "take the pickles off" is how
   * people say it, and how a model calls the tool. Same change, opposite framing — so
   * both are normalised here instead of silently doing nothing.
   */
  private plannedModifiers(item: MenuItem, current: string[], args: ModifyArgs): string[] {
    const next = [...current];

    const addModifier = (raw: string) => {
      const m = canonicalModifier(item, raw);
      if (m && !next.includes(m)) next.push(m);
    };
    const has = (m: string) => canonicalModifier(item, m) !== null;
    const dropModifier = (m: string) => {
      const i = next.indexOf(m);
      if (i !== -1) next.splice(i, 1);
    };

    for (const raw of args.add_modifiers ?? []) {
      const m = raw.toLowerCase().trim().replace(/^without\s+/, "no ");
      if (m.startsWith("no ")) addModifier(m);
      // "add the pickles back" undoes a previous "no pickles"
      else if (next.includes(`no ${m}`)) dropModifier(`no ${m}`);
      else addModifier(m);
    }

    for (const raw of args.remove_modifiers ?? []) {
      const m = raw.toLowerCase().trim().replace(/^without\s+/, "no ");
      if (next.includes(m)) dropModifier(m);
      // "remove pickles" on a burger that offers "no pickles" means adding that modifier
      else if (has(`no ${m}`)) addModifier(`no ${m}`);
      else if (m.startsWith("no ")) dropModifier(m);
    }

    return next;
  }

  modifyItem(args: ModifyArgs): Outcome {
    this.noteSpeaker(args.attribution);

    const { item } = this.find(args.spoken);
    if (!item) return { status: "not_found", message: `No "${args.spoken}" on this order to change.` };
    // "Just the one" said as a correction answers "a second one?" just the same.
    if (this.repeatQuestion?.itemId === item.id) this.repeatQuestion = null;

    // A correction too short to place is the person the agent is talking to, exactly as
    // it is when an item is added: only a positively identified other voice is a passenger.
    const heard = args.attribution?.speaker ?? UNASSIGNED;
    const speaker = unplaced(heard) ? (this.driver ?? DRIVER) : heard;
    const line = this.targetLine(item.id, speaker, args.whose);
    if (!line) {
      return {
        status: "not_found",
        message: `${item.name} is not on the ticket yet. Ask whether they want to add it.`,
      };
    }

    // Who may change what: the driver owns the lane, everyone else owns their own food.
    const speakerIsDriver = !this.speakerAware || this.driver === null || this.isDriver(speaker);
    const ownsIt = line.owner === speaker || line.owner === UNASSIGNED;
    if (!speakerIsDriver && !ownsIt) {
      this.flag("permission", `A passenger tried to change someone else's ${line.name}`);
      return {
        status: "needs_confirmation",
        message: `That change came from a voice that does not own the ${line.name}. Ask the driver whether to apply it before anything changes.`,
        line,
      };
    }

    // Work out the whole change before touching anything: a correction that turns out
    // to be a no-op must not leave a split line behind.
    //
    // "Hers without pickles, just one of them" reaches us as units=1 and often
    // quantity=1 as well — the model describing the subset twice, not asking for a
    // line of two to become a line of one. Scope wins over quantity.
    const scoped =
      args.units !== undefined && Math.max(1, Math.round(args.units)) < line.quantity;
    const restatesScope =
      scoped && args.quantity !== undefined && Math.round(args.quantity) <= Math.round(args.units ?? 0);
    const quantity =
      args.quantity !== undefined && !restatesScope ? Math.max(1, Math.round(args.quantity)) : undefined;

    if (this.guards && quantity !== undefined && quantity > GUARDS.escalateQuantity) {
      this.escalated = true;
      this.flag("escalation", `Refused change to ${quantity} × ${line.name}`);
      return {
        status: "escalated",
        message: `${quantity} of anything is beyond voice ordering. Hand the lane to a team member.`,
      };
    }

    const modifiers = this.plannedModifiers(item, line.modifiers, args);
    const sameModifiers = JSON.stringify([...modifiers].sort()) === JSON.stringify([...line.modifiers].sort());
    const sameSize = !args.size || args.size === line.size;
    const sameQuantity = quantity === undefined || quantity === line.quantity;

    // "Hers without pickles" applies to one of the two burgers, not both.
    const units = Math.max(1, Math.round(args.units ?? line.quantity));
    const partial = units < line.quantity && quantity === undefined;

    // The agent must never tell a customer about a change the ticket did not take.
    if (sameModifiers && sameSize && sameQuantity) {
      return {
        status: "rejected",
        message: `Nothing changed on the ${line.name}. Do not tell the customer it did. Say what you can change — quantity, size, or a listed modifier — and ask again.`,
        line,
      };
    }

    const target = partial ? this.splitLine(line, units, args.whose === "theirs" ? UNASSIGNED : speaker) : line;

    if (quantity !== undefined) target.quantity = quantity;
    if (args.size) {
      target.size = args.size;
      target.unitPrice = priceOf(item, args.size);
    }
    target.modifiers = modifiers;

    const total = this.snapshot().total;
    return {
      status: "ok",
      message: `Updated ${target.name}: ${target.quantity} ×${target.size ? ` ${target.size}` : ""}${
        target.modifiers.length ? `, ${target.modifiers.join(", ")}` : ""
      }${partial ? " (that one only)" : ""}. Order total $${total.toFixed(2)}.`,
      line: target,
      order_total: total,
    };
  }

  /** Split `units` off a multi-unit line so one person's change does not hit everyone's food. */
  private splitLine(line: OrderLine, units: number, owner: string): OrderLine {
    line.quantity -= units;
    const copy: OrderLine = {
      ...line,
      lineId: newLineId(),
      quantity: units,
      modifiers: [...line.modifiers],
      owner,
      addedAt: Date.now(),
    };
    this.lines.splice(this.lines.indexOf(line) + 1, 0, copy);
    return copy;
  }

  /**
   * Second look at who asked for a line, once better speaker labels exist.
   * Returns the lines whose owner changed, so the crew — and the driver — can be told.
   */
  reattribute(look: (line: OrderLine) => Attribution | null): { line: OrderLine; from: string; to: string }[] {
    const changes: { line: OrderLine; from: string; to: string }[] = [];

    // The refinement pass can also be the first time anyone knows which voice was
    // the driver; adopting it here keeps every line's owner meaningful.
    for (const line of this.lines) {
      const fresh = look(line);
      if (fresh) this.noteSpeaker(fresh);
    }

    for (const line of this.lines) {
      const fresh = look(line);
      if (!fresh || fresh.verdict === "unverified") continue;
      const wasUnverified = line.unverified;
      line.unverified = false;
      if (fresh.speaker === line.requestedBy) continue;

      const from = line.owner;
      line.requestedBy = fresh.speaker;
      // Only move ownership when the line was never explicitly assigned to someone else.
      if (line.owner === from && (wasUnverified || line.owner === UNASSIGNED)) line.owner = fresh.speaker;
      if (line.owner !== from) changes.push({ line, from, to: line.owner });
    }
    return changes;
  }

  removeItem(spoken: string): Outcome {
    const { item } = this.find(spoken);
    if (!item) return { status: "not_found", message: `No "${spoken}" on this order.` };
    if (this.repeatQuestion?.itemId === item.id) this.repeatQuestion = null;

    // When a copy of the same item is waiting on the driver, that is the one they mean
    // to drop — taking the confirmed one away instead empties a ticket they wanted.
    const pendingIdx = this.lines.findIndex((l) => l.itemId === item.id && l.status === "pending");
    const idx = pendingIdx !== -1 ? pendingIdx : [...this.lines].map((l) => l.itemId).lastIndexOf(item.id);
    if (idx === -1) return { status: "not_found", message: `${item.name} is not on the ticket.` };
    const [removed] = this.lines.splice(idx, 1);
    const total = this.snapshot().total;
    return { status: "ok", message: `Removed ${removed.name}. Order total $${total.toFixed(2)}.`, order_total: total };
  }

  /** Display name for a guest: the driver, or whoever else is in the car. */
  guestLabel(owner: string): string {
    return ownerLabel(owner, this.driver);
  }

  /** The ticket grouped the way the bag is packed. */
  splitTicket(): { owner: string; label: string; lines: OrderLine[] }[] {
    const groups = new Map<string, OrderLine[]>();
    for (const line of this.lines) {
      const list = groups.get(line.owner) ?? [];
      list.push(line);
      groups.set(line.owner, list);
    }
    return Array.from(groups.entries()).map(([owner, lines]) => ({
      owner,
      label: this.guestLabel(owner),
      lines,
    }));
  }

  /** What the agent should read back, per person. */
  summary(): { text: string; pending: string[]; unverified: string[]; total: number } {
    const snap = this.snapshot();
    const parts: string[] = [];

    for (const group of this.splitTicket()) {
      const confirmed = group.lines.filter((l) => l.status === "confirmed");
      if (!confirmed.length) continue;
      const items = confirmed
        .map(
          (l) =>
            `${l.quantity} ${l.size ? `${l.size} ` : ""}${l.name}${
              l.modifiers.length ? ` (${l.modifiers.join(", ")})` : ""
            }`,
        )
        .join(", ");
      parts.push(this.splitTicket().length > 1 ? `${group.label}: ${items}` : items);
    }

    return {
      text: parts.join("; ") || "nothing yet",
      pending: snap.lines.filter((l) => l.status === "pending").map((l) => `${l.quantity} × ${l.name}`),
      unverified: snap.lines
        .filter((l) => l.status === "confirmed" && l.unverified)
        .map((l) => `${l.quantity} × ${l.name}`),
      total: snap.total,
    };
  }

  /**
   * Close the order: one call, carrying the ticket the agent reads back.
   *
   * Each tool call is a wait the car sits through in silence, so closing does not take
   * a separate read-back first. The one thing the read-back used to catch is asked here
   * instead: food the room ear never placed with a voice is named once before the
   * ticket goes, and the next call closes.
   */
  finalize(): Outcome {
    const snap = this.snapshot();
    if (!snap.lines.some((l) => l.status === "confirmed")) {
      return { status: "rejected", message: "There is nothing confirmed on the ticket yet." };
    }

    const unplacedLines = snap.lines.filter(
      (l) => l.status === "confirmed" && l.unverified && !this.askedBeforeClosing.has(l.lineId),
    );
    if (unplacedLines.length) {
      for (const l of unplacedLines) this.askedBeforeClosing.add(l.lineId);
      const named = unplacedLines.map((l) => `${l.quantity} × ${l.name}`).join(", ");
      const one = unplacedLines.length === 1;
      return {
        status: "needs_confirmation",
        message: `Not sent yet: ${named} ${one ? "was" : "were"} heard but not placed with a voice. Ask once whether ${
          one ? "it belongs" : "they belong"
        } on the order ("and the ${unplacedLines[0].name} — is that yours?"). If they say no, call remove_item; then call finalize_order again.`,
      };
    }

    // Anything the driver never confirmed is dropped here rather than blocking the
    // lane. Food nobody agreed to is not food anybody pays for.
    const dropped = snap.lines.filter((l) => l.status === "pending");
    if (dropped.length) {
      this.lines = this.lines.filter((l) => l.status !== "pending");
      for (const l of dropped) this.flag("side_voice", `Dropped unconfirmed ${l.quantity} × ${l.name}`);
      this.notSent.push(...dropped.map((l) => ({ name: l.name, quantity: l.quantity })));
    }

    this.finalized = true;
    this.sentAt ??= Date.now();
    const settled = this.snapshot();
    const ticket = this.summary().text;
    if (dropped.length) {
      return {
        status: "ok",
        message: `Order sent without ${dropped
          .map((l) => l.name)
          .join(" or ")} — nobody confirmed ${dropped.length > 1 ? "those" : "that"}. Ticket: ${ticket}. Total $${settled.total.toFixed(
          2,
        )}. Say what was left off in one short clause, give the total, and ask them to pull forward.`,
        order_total: settled.total,
      };
    }

    return {
      status: "ok",
      message: `Order sent. Ticket: ${ticket}. Total $${settled.total.toFixed(2)}. Say it back in one sentence with the total and ask them to pull forward to the window.`,
      order_total: settled.total,
    };
  }

  escalate(reason: string): Outcome {
    this.escalated = true;
    this.flag("escalation", reason);
    return {
      status: "escalated",
      message: `A team member has been pulled in (${reason}). Tell the customer someone is coming on the line and stop taking items.`,
    };
  }

  menuFor(category?: string): Outcome {
    const items = MENU.filter(
      (m) =>
        (!category || m.category === category) &&
        (this.daypart === "breakfast" ? m.daypart !== undefined || m.category === "drinks" : m.daypart === undefined),
    );
    return {
      status: "ok",
      message: items.map((m) => `${m.name} $${m.price.toFixed(2)}`).join("; "),
    };
  }
}
