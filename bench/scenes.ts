import type { ExpectedLine } from "../src/lib/scoring";

/**
 * Backseat Benchmark v0.1 — a virtual car, scripted down to who speaks when.
 *
 * Every scene carries ground truth: the cart that should exist at the end, who each
 * line belongs to, what must never appear, and whether the lane should have been
 * handed to a human. Conditions are declared as SNR against the speech in the scene,
 * so "engine +5 dB" means the same thing on every machine and every run.
 *
 * Phrasing follows Google's Taskmaster-2 food-ordering corpus (CC BY 4.0): real
 * customers say "actually, make that…", "with no cheese", "one for my son".
 */

export type Role = "driver" | "passenger" | "backseat" | "nextlane";

export type Cue =
  /** After the agent has finished its turn. */
  | { kind: "after_agent"; delayMs?: number }
  /** At a fixed point in the scene, regardless of the conversation. */
  | { kind: "at"; ms: number }
  /** Deliberately over the agent's reply. */
  | { kind: "interrupt"; afterReplyStartMs: number }
  /** Over the previous utterance — two people talking at once. */
  | { kind: "with_previous"; offsetMs: number };

export type Utterance = {
  role: Role;
  voice: string;
  text: string;
  cue: Cue;
  /** Relative level: the next lane is far away, the back seat is off-axis. */
  gain?: number;
  /** >1 shortens and raises the voice — a child rather than an adult. */
  pitch?: number;
};

export type Condition =
  | "clean"
  | "car_15db"
  | "car_5db"
  | "babble_5db"
  | "background_speaker"
  | "sequential_speakers"
  | "overlapping_speakers"
  | "short_utterance"
  | "far_field"
  | "code_switch"
  | "correction"
  | "interruption"
  | "absurd_quantity"
  | "ownership"
  | "permission";

export type Scene = {
  id: string;
  title: string;
  proves: string;
  conditions: Condition[];
  /** Recorded car, traffic or babble (falls back to synthetic rumble), as SNR against the speech. */
  noise?: { kind: "engine" | "car" | "traffic" | "babble"; snrDb: number };
  utterances: Utterance[];
  expect: {
    ticket: ExpectedLine[];
    mustNotContain?: string[];
    escalated?: boolean;
    /** Lines still waiting on the driver when the scene ends. */
    maxHeld?: number;
    /** Distinct voices the room ear should end up with. */
    minVoices?: number;
    /** Corrections the customer makes in this scene, for the correction-success metric. */
    corrections?: number;
  };
};

const DRIVER = "george";
const PASSENGER = "mary";
const KID = "jane";
const LANE = "charles";
const SPANISH = "lola";

const KID_VOICE = { gain: 0.85, pitch: 1.22 };

export const SCENES: Scene[] = [
  {
    id: "clean-order",
    title: "Plain order, quiet lane",
    proves: "the baseline works before anything is made hard",
    conditions: ["clean"],
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Can I get a double cheeseburger and a large fries.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      { role: "driver", voice: DRIVER, text: "That's everything, thanks.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: {
      ticket: [
        { item: "Double Lab Burger", qty: 1, owner: "driver" },
        { item: "Fries", qty: 1, size: "large", owner: "driver" },
      ],
      maxHeld: 0,
    },
  },
  {
    id: "engine-15db",
    title: "Order at +15 dB over a recorded car",
    proves: "ordinary road noise costs nothing",
    conditions: ["car_15db"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Yeah, let me get a bacon stack and a medium iced tea.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      { role: "driver", voice: DRIVER, text: "That's it.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: {
      ticket: [
        { item: "Bacon Stack", qty: 1, owner: "driver" },
        { item: "Iced Tea", qty: 1, size: "medium", owner: "driver" },
      ],
      maxHeld: 0,
    },
  },
  {
    id: "engine-5db",
    title: "Same order at +5 dB over a recorded car",
    proves: "far-field Voice Focus holds the transcript together where it gets hard",
    conditions: ["car_5db"],
    noise: { kind: "car", snrDb: 5 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Yeah, let me get a bacon stack and a medium iced tea.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      { role: "driver", voice: DRIVER, text: "That's it.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: {
      ticket: [
        { item: "Bacon Stack", qty: 1, owner: "driver" },
        { item: "Iced Tea", qty: 1, size: "medium", owner: "driver" },
      ],
      maxHeld: 0,
    },
  },
  {
    id: "babble-5db",
    title: "Conversation running under the order",
    proves: "competing speech is not menu input",
    conditions: ["babble_5db", "background_speaker"],
    noise: { kind: "babble", snrDb: 5 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "I'll have the crispy chicken sandwich and an apple pie.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      { role: "driver", voice: DRIVER, text: "That's all for me.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: {
      ticket: [
        { item: "Crispy Chicken Sandwich", qty: 1, owner: "driver" },
        { item: "Apple Pie", qty: 1, owner: "driver" },
      ],
      maxHeld: 0,
    },
  },
  {
    id: "backseat-declined",
    title: "Kid shouts for a shake, driver says no",
    proves: "a second voice never reaches the ticket on its own",
    conditions: ["sequential_speakers", "car_15db"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "I'll take a lab burger and a small coke.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "backseat",
        voice: KID,
        text: "And a chocolate shake! I want a chocolate shake!",
        cue: { kind: "after_agent", delayMs: 200 },
        ...KID_VOICE,
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "No, no shake. That's everything.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
    ],
    expect: {
      ticket: [
        { item: "Lab Burger", qty: 1, owner: "driver" },
        { item: "Cola", qty: 1, size: "small", owner: "driver" },
      ],
      mustNotContain: ["Milkshake"],
      maxHeld: 0,
      minVoices: 2,
    },
  },
  {
    id: "backseat-approved",
    title: "Kid shouts for nuggets, driver agrees",
    proves: "the held item is added on the driver's word and belongs to the child, not the driver",
    conditions: ["sequential_speakers", "ownership", "car_15db"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Just a crispy chicken sandwich for me.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "backseat",
        voice: KID,
        text: "Can I have chicken nuggets? Nuggets please!",
        cue: { kind: "after_agent", delayMs: 200 },
        ...KID_VOICE,
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "Yeah, go ahead and add the nuggets for him.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
      { role: "driver", voice: DRIVER, text: "That's all.", cue: { kind: "after_agent", delayMs: 400 } },
    ],
    expect: {
      ticket: [
        { item: "Crispy Chicken Sandwich", qty: 1, owner: "driver" },
        { item: "Chicken Nuggets", qty: 1, owner: "passenger" },
      ],
      maxHeld: 0,
      minVoices: 2,
    },
  },
  {
    id: "backseat-ignored",
    title: "Kid shouts, driver never answers",
    proves: "an unanswered request is never sold — consent has to be spoken",
    conditions: ["sequential_speakers", "car_15db"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      { role: "driver", voice: DRIVER, text: "One veggie lab, please.", cue: { kind: "after_agent", delayMs: 300 } },
      {
        role: "backseat",
        voice: KID,
        text: "And onion rings! Onion rings too!",
        cue: { kind: "after_agent", delayMs: 200 },
        ...KID_VOICE,
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "That's everything for me, thanks.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
    ],
    expect: {
      ticket: [{ item: "Veggie Lab", qty: 1, owner: "driver" }],
      mustNotContain: ["Onion Rings"],
      // Nobody answered, so the request stays held rather than sold. That is the
      // outcome being tested; whether the agent also closes the order is not.
      maxHeld: 1,
      minVoices: 2,
    },
  },
  {
    id: "next-lane-bleed",
    title: "The next lane orders into our microphone",
    proves: "a voice that never spoke to this agent cannot put food on this ticket",
    conditions: ["background_speaker", "far_field", "car_15db"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Morning, I'd like a veggie lab, please.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "nextlane",
        voice: LANE,
        text: "Give me two large fries and an apple pie.",
        cue: { kind: "at", ms: 9000 },
        gain: 0.3,
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "And that's everything for me.",
        cue: { kind: "after_agent", delayMs: 600 },
      },
    ],
    expect: {
      ticket: [{ item: "Veggie Lab", qty: 1, owner: "driver" }],
      mustNotContain: ["Fries", "Apple Pie"],
      // A request from the next lane may sit unanswered at the end; what matters is
      // that it never became food on this ticket.
      maxHeld: 2,
    },
  },
  {
    id: "hers-without-pickles",
    title: "Two burgers, one of them hers",
    proves: "a correction aimed at another person splits the line instead of changing both",
    conditions: ["ownership", "correction", "sequential_speakers"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Two lab burgers and a large fries.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "Hers without pickles, just one of them.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
      { role: "driver", voice: DRIVER, text: "That's everything.", cue: { kind: "after_agent", delayMs: 400 } },
    ],
    expect: {
      ticket: [
        { item: "Lab Burger", qty: 1, owner: "driver" },
        { item: "Lab Burger", qty: 1, modifiers: ["no pickles"] },
        { item: "Fries", qty: 1, size: "large", owner: "driver" },
      ],
      maxHeld: 0,
      corrections: 1,
    },
  },
  {
    id: "passenger-owns-their-fix",
    title: "Passenger changes their own sandwich",
    proves:
      "people may fix their own food without a confirmation loop — and it is where two similar voices still get swapped",
    conditions: ["ownership", "permission", "sequential_speakers"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      { role: "driver", voice: DRIVER, text: "A lab burger for me.", cue: { kind: "after_agent", delayMs: 300 } },
      {
        role: "passenger",
        voice: PASSENGER,
        text: "And a crispy chicken sandwich for me, please.",
        cue: { kind: "after_agent", delayMs: 300 },
        gain: 0.9,
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "Yes, add her chicken sandwich.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "passenger",
        voice: PASSENGER,
        text: "Make mine spicy, please.",
        cue: { kind: "after_agent", delayMs: 300 },
        gain: 0.9,
      },
      { role: "driver", voice: DRIVER, text: "That's everything.", cue: { kind: "after_agent", delayMs: 400 } },
    ],
    expect: {
      ticket: [
        { item: "Lab Burger", qty: 1, owner: "driver" },
        { item: "Crispy Chicken Sandwich", qty: 1, modifiers: ["spicy"], owner: "passenger" },
      ],
      maxHeld: 0,
      minVoices: 2,
      corrections: 1,
    },
  },
  {
    id: "overlapping-speakers",
    title: "Driver and passenger talk at once",
    proves: "overlapping speech does not merge two people into one order line",
    conditions: ["overlapping_speakers", "car_15db"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Can I get a double cheeseburger with no onions.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "passenger",
        voice: PASSENGER,
        text: "Onion rings for me as well.",
        cue: { kind: "with_previous", offsetMs: 900 },
        gain: 0.8,
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "Yes, add her onion rings. That's everything.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
    ],
    expect: {
      ticket: [
        { item: "Double Lab Burger", qty: 1, modifiers: ["no onions"], owner: "driver" },
        { item: "Onion Rings", qty: 1 },
      ],
      maxHeld: 0,
      minVoices: 2,
    },
  },
  {
    id: "short-passenger-utterance",
    title: "A one-word interjection",
    proves: "a voice too short to place is flagged, not silently trusted",
    conditions: ["short_utterance", "sequential_speakers"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      { role: "driver", voice: DRIVER, text: "One bacon stack, please.", cue: { kind: "after_agent", delayMs: 300 } },
      { role: "backseat", voice: KID, text: "Nuggets!", cue: { kind: "after_agent", delayMs: 150 }, ...KID_VOICE },
      {
        role: "driver",
        voice: DRIVER,
        text: "No nuggets. That's everything.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
    ],
    expect: {
      ticket: [{ item: "Bacon Stack", qty: 1, owner: "driver" }],
      mustNotContain: ["Chicken Nuggets"],
      maxHeld: 0,
    },
  },
  {
    id: "mid-sentence-correction",
    title: "Actually, make that three",
    proves: "a correction changes the line instead of stacking a new one",
    conditions: ["correction"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Two lab burgers please. Actually, make that three lab burgers.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      { role: "driver", voice: DRIVER, text: "Nothing else.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: { ticket: [{ item: "Lab Burger", qty: 3, owner: "driver" }], maxHeld: 0, corrections: 1 },
  },
  {
    id: "barge-in",
    title: "Talking over the read-back",
    proves: "semantic barge-in lands the correction the customer actually made",
    conditions: ["interruption", "correction"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "A lab burger and an onion rings.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "driver",
        voice: DRIVER,
        text: "Wait, no pickles on that burger.",
        cue: { kind: "interrupt", afterReplyStartMs: 500 },
      },
      { role: "driver", voice: DRIVER, text: "That's everything.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: {
      ticket: [
        { item: "Lab Burger", qty: 1, modifiers: ["no pickles"], owner: "driver" },
        { item: "Onion Rings", qty: 1, owner: "driver" },
      ],
      maxHeld: 0,
      corrections: 1,
    },
  },
  {
    id: "backchannel-not-interruption",
    title: "Uh-huh is not an interruption",
    proves: "back-channels do not cut the agent off",
    conditions: ["interruption"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Let me get the double lab and a medium coke.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      // "Mhm" comes back from the model as "milk" often enough to be its own finding;
      // this scene is about turn-taking, so it uses a back-channel that survives TTS.
      { role: "driver", voice: DRIVER, text: "Uh-huh. Right.", cue: { kind: "interrupt", afterReplyStartMs: 500 } },
      { role: "driver", voice: DRIVER, text: "That's it, thanks.", cue: { kind: "after_agent", delayMs: 500 } },
    ],
    expect: {
      ticket: [
        { item: "Double Lab Burger", qty: 1, owner: "driver" },
        { item: "Cola", qty: 1, size: "medium", owner: "driver" },
      ],
      maxHeld: 0,
    },
  },
  {
    id: "prank-nuggets",
    title: "Two hundred and sixty nuggets",
    proves: "the order that ended a real drive-thru pilot never reaches the kitchen",
    conditions: ["absurd_quantity"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "I want two hundred and sixty chicken nuggets.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
    ],
    expect: { ticket: [], mustNotContain: ["Chicken Nuggets"], escalated: true },
  },
  {
    id: "prank-waters",
    title: "Eighteen thousand cups of water",
    proves: "an absurd quantity becomes a human handover, not a kitchen ticket",
    conditions: ["absurd_quantity"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: DRIVER,
        text: "Can I get eighteen thousand cups of water please.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
    ],
    expect: { ticket: [], mustNotContain: ["Bottled Water"], escalated: true },
  },
  {
    id: "repeat-loop",
    title: "Saying it twice because the speaker is bad",
    proves: "a repeated item is a question, not a second burger",
    conditions: ["car_5db"],
    noise: { kind: "car", snrDb: 5 },
    utterances: [
      { role: "driver", voice: DRIVER, text: "One bacon stack.", cue: { kind: "after_agent", delayMs: 300 } },
      { role: "driver", voice: DRIVER, text: "One bacon stack.", cue: { kind: "after_agent", delayMs: 200 } },
      {
        role: "driver",
        voice: DRIVER,
        text: "Just the one. That's everything.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
    ],
    expect: { ticket: [{ item: "Bacon Stack", qty: 1, owner: "driver" }], maxHeld: 0 },
  },
  {
    id: "code-switch",
    title: "Spanish and English in one sentence",
    proves: "code-switching is understood without switching modes",
    conditions: ["code_switch"],
    noise: { kind: "car", snrDb: 15 },
    utterances: [
      {
        role: "driver",
        voice: SPANISH,
        text: "Quiero dos hamburguesas, and a large coke, por favor.",
        cue: { kind: "after_agent", delayMs: 300 },
      },
      {
        role: "driver",
        voice: SPANISH,
        text: "Eso es todo. That's everything.",
        cue: { kind: "after_agent", delayMs: 500 },
      },
    ],
    expect: {
      ticket: [
        { item: "Lab Burger", qty: 2, owner: "driver" },
        { item: "Cola", qty: 1, size: "large", owner: "driver" },
      ],
      maxHeld: 0,
    },
  },
  {
    id: "not-on-menu",
    title: "Something we do not sell",
    proves: "the agent does not invent a product",
    conditions: ["clean"],
    utterances: [
      { role: "driver", voice: DRIVER, text: "Do you have a lobster roll?", cue: { kind: "after_agent", delayMs: 300 } },
      {
        role: "driver",
        voice: DRIVER,
        text: "Okay, just a lab burger then. That's all.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
    ],
    expect: { ticket: [{ item: "Lab Burger", qty: 1, owner: "driver" }], maxHeld: 0 },
  },
  {
    id: "ambiguous-chicken",
    title: "Just 'chicken'",
    proves: "two plausible items produce a question, not a coin flip",
    conditions: ["clean"],
    utterances: [
      { role: "driver", voice: DRIVER, text: "Let me get the chicken.", cue: { kind: "after_agent", delayMs: 300 } },
      {
        role: "driver",
        voice: DRIVER,
        text: "The crispy chicken sandwich. That's everything.",
        cue: { kind: "after_agent", delayMs: 400 },
      },
    ],
    expect: { ticket: [{ item: "Crispy Chicken Sandwich", qty: 1, owner: "driver" }], maxHeld: 0 },
  },
];

export const sceneById = (id: string) => SCENES.find((s) => s.id === id);

/** A line of speech used as background chatter for the babble condition. */
export const BABBLE_LINE = {
  voice: LANE,
  text: "So then she said the meeting was moved to Thursday, which is fine, but nobody told the client about it, and now the whole schedule has shifted again.",
};
