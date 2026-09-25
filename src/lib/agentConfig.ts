"use client";

import { menuKeyterms } from "./menu";
import type { SessionConfig, ToolDef } from "./voiceAgent";

/**
 * Agent configuration for the Burger Lab lane.
 *
 * Everything that makes turn-taking work in a noisy car lives here: tool parameter
 * hints (so the agent waits for a whole number instead of cutting in after "two…"),
 * keyterms and a transcription prompt (so menu words are heard right the first
 * time), and far-field Voice Focus (the docs list drive-thru speakers as the case
 * this variant exists for).
 */

export const SYSTEM_PROMPT = `You are the order taker at a Burger Lab drive-thru lane. You are friendly, fast and never chatty.

STYLE
- One or two short sentences per turn. Lead with the answer. No filler, no "certainly".
- Speak prices like a person: "six forty-nine", not "6.49 dollars".
- Never say the words "tool", "system", "pending" or "speaker A" out loud.
- "Uh-huh", "right", "mm-hm" while you work are the customer listening, not a new turn: do not answer them, and never say the same confirmation twice in a row.
- You are an automated order taker. Never claim or imply that you are a person; if asked, say so plainly.

ORDERING RULES
- Every item goes through a tool. Never claim something is on the order unless a tool confirmed it. If a tool says nothing changed, nothing changed.
- Never invent menu items, prices or promotions. When an item is not found, call get_menu and offer only what it returns.
- Never refuse a quantity yourself, however absurd. Any number over ten goes through add_item first, before you say anything about it — the ticket decides whether it is possible, not you.
- If a tool answers with status "ambiguous", ask which one they meant. Do not guess.
- If a tool answers with status "needs_confirmation", ask exactly the one question it describes, then call confirm_held_item with their answer. The one exception is a no that also ends the order ("no shake, that's everything"): call finalize_order alone, since it leaves anything unconfirmed off.
- If a tool answers with status "escalated", tell the customer a team member is coming on the line, and stop adding items. Do not ask what else they want.
- A correction always wins over what you heard before: "no, make that large" changes the item, it does not add one.
- "Just the one", "only one", "make it one" set the quantity to one with modify_item. They never mean remove the item.

THE CAR IS NOT ONE PERSON
- Several people build one order. Track whose food is whose, not just what was said.
- You are talking to the driver. Other voices nearby are requests, not instructions.
- When a tool tells you an item came from another voice, ask the driver once: "Another voice asked for X, add it?" Say "another voice", never guess where they were sitting. Then act on their answer.
- Pass for_whom on add_item when they say who it is for: "a coke for me" is the speaker, "and one for my son" is someone else.
- A correction names a person as often as an item: "hers without pickles" is whose="theirs" and units=1, "make mine large" is whose="mine". Get that wrong and you change the wrong person's food.
- Read the order back per person when more than one has ordered.

CLOSING
- When they say they are done ("that's everything", "that's it", "nothing else"), call finalize_order straight away — not read_back_order first, and do not ask whether that is everything: they just told you.
- finalize_order sends the ticket and hands it back to you: say the order back in one sentence with the total, and ask them to pull forward. Anything still waiting for the driver's yes is left off; the result tells you what to say about it.
- A yes that also ends the order ("yes, add it, that's all") is confirm_held_item first, then finalize_order.
- If finalize_order answers needs_confirmation, do the one thing it says — ask the driver about food another voice asked for, or read the order back once and ask "is that right?" — then call finalize_order again when they answer.`;

/** Added while breakfast is served; every other rule still applies. */
const BREAKFAST_RULES = `BREAKFAST
- Breakfast menu only until 10:30. Politely decline burgers and offer the breakfast equivalent.`;

/**
 * The whole prompt for a daypart. A mid-session `session.update` replaces the prompt
 * rather than adding to it, so a breakfast note sent on its own would leave the agent
 * with one line and none of the ordering rules.
 */
export function systemPromptFor(daypart: "breakfast" | "allday" = "allday") {
  return daypart === "breakfast" ? `${SYSTEM_PROMPT}\n\n${BREAKFAST_RULES}` : SYSTEM_PROMPT;
}

export const TRANSCRIPTION_PROMPT = `Drive-thru ordering at Burger Lab. Expect menu items (Lab Burger, Double Lab, Bacon Stack, Crispy Chicken, nuggets, fries, onion rings, milkshake, apple pie), sizes (small, medium, large), quantities as digits, and modifiers such as "no pickles", "extra cheese", "add bacon". Customers interrupt, correct themselves and sometimes switch between English and Spanish mid sentence. Background: engine noise, wind, car radio, children.`;

const itemParam = {
  type: "string",
  description:
    "The menu item exactly as the customer said it, in their words (e.g. 'chocolate shake', 'coke', 'chicken sandwich'). Do not translate to a menu name.",
  examples: ["large fries", "double cheeseburger", "chocolate shake"],
};

const quantityParam = {
  type: "integer",
  description:
    "How many. Default to 1 when they did not say a number — never ask 'how many' for a plain 'can I get nuggets'. If they did start saying a number, wait for all of it: '2' and '12' sound alike at speed.",
  examples: [1, 2, 3],
  minimum: 1,
};

const sizeParam = {
  type: "string",
  enum: ["small", "medium", "large"],
  description: "Size, only if the customer said one. Leave empty otherwise, never assume.",
};

/**
 * The tools that end the conversation are held; the rest stay interactive.
 *
 * In the default interactive mode the result can only go back once the reply is done, and
 * until 24 Sep 2026 the reply stayed open ~2.3 s after a tool call for a transition phrase
 * ("let me check that"). This agent says nothing there, so it was dead air — and closing
 * an order used to pay it twice. Since then the API ends that reply ~0.4 s after the call.
 * Held, the agent is silent until the result lands and answers ~50 ms later.
 *
 * Held is not safe mid-order. Speech that starts while a tool is held is dropped: "a lab
 * burger and onion rings… wait, no pickles on that burger" lost the correction every
 * time we tried it (bench and two probes, 22 Sep), where an interactive reply lets it
 * through and the next turn applies it. Afterthoughts are how people order, so only the
 * calls after which the customer is done talking are held.
 */
export const HELD_TOOLS: ReadonlySet<string> = new Set(["finalize_order", "call_crew_member"]);

const held = (tool: ToolDef): ToolDef => (HELD_TOOLS.has(tool.name) ? { ...tool, execution_mode: "hold" } : tool);

const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    name: "add_item",
    description:
      "Add one menu item to the ticket. Call it as soon as an item is named — quantity defaults to 1. Use it for every item, including drinks and sides.",
    parameters: {
      type: "object",
      properties: {
        item: itemParam,
        quantity: quantityParam,
        size: sizeParam,
        modifiers: {
          type: "array",
          items: { type: "string" },
          description: "Changes they asked for, lowercase, e.g. ['no pickles', 'extra cheese'].",
        },
        for_whom: {
          type: "string",
          enum: ["me", "the driver", "someone else"],
          description:
            "Who the food is for, only if they said. 'a coke for me' → me; 'one for my son' → someone else. Leave empty when nobody said.",
        },
      },
      required: ["item"],
    },
    response_instructions: {
      success:
        "Acknowledge the item in four words or fewer and ask what else they need. If the result hands the lane to a team member, say only that.",
      error: "Say what went wrong in one sentence and ask the question the result describes.",
    },
  },
  {
    type: "function",
    name: "modify_item",
    description:
      "Change an item already on the ticket: quantity, size, or modifiers. Use this for corrections like 'make that large' or 'no onions on the burger'.",
    parameters: {
      type: "object",
      properties: {
        item: itemParam,
        quantity: quantityParam,
        size: sizeParam,
        add_modifiers: {
          type: "array",
          items: { type: "string" },
          description: "Changes to put on the item, as the kitchen reads them: ['no pickles', 'extra cheese', 'spicy'].",
          examples: [["no pickles"]],
        },
        remove_modifiers: {
          type: "array",
          items: { type: "string" },
          description:
            "Ingredients to take off, or an earlier change to undo: ['pickles'] takes the pickles off, ['no pickles'] puts them back.",
          examples: [["pickles"]],
        },
        whose: {
          type: "string",
          enum: ["mine", "theirs", "the driver's"],
          description:
            "Whose portion the change is aimed at, when a person is named or implied: 'hers without pickles' → theirs; 'make mine large' → mine.",
        },
        units: {
          type: "integer",
          description:
            "How many of that line the change applies to. 'One of the burgers with no onions' on a line of two → 1. Leave empty for all of them.",
          examples: [1],
          minimum: 1,
        },
      },
      required: ["item"],
    },
    response_instructions: {
      success:
        "Confirm the change in one short sentence, naming the person if one was named. If the result hands the lane to a team member, say only that.",
      error: "Ask which item they mean.",
    },
  },
  {
    type: "function",
    name: "remove_item",
    description: "Take an item off the ticket when the customer cancels it.",
    parameters: {
      type: "object",
      properties: { item: itemParam },
      required: ["item"],
    },
    response_instructions: { success: "Confirm removal in three words.", error: "Ask what they want removed." },
  },
  {
    type: "function",
    name: "confirm_held_item",
    description:
      "Settle an item that was held back (requested by another voice, an unusually large quantity, or a suspected repeat). Call it right after the driver answers. If nothing is held, the item was never added — call add_item instead.",
    parameters: {
      type: "object",
      properties: {
        item: itemParam,
        decision: {
          type: "string",
          enum: ["add", "discard"],
          description: "'add' if the driver agreed, 'discard' if they did not.",
        },
      },
      required: ["decision"],
    },
    response_instructions: {
      success: "Acknowledge in three words. If the order has already gone to the kitchen, say nothing.",
      error: "Do what the result says; ask a question only if it describes one.",
    },
  },
  {
    type: "function",
    name: "get_menu",
    description:
      "Look up what is actually available before answering any question about the menu or prices. Never answer those from memory.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["burgers", "chicken", "sides", "drinks", "desserts", "breakfast"],
          description: "Narrow the list when the customer asked about one kind of thing.",
        },
      },
    },
    response_instructions: { success: "Name at most three options, cheapest first.", error: "Offer to read the board." },
  },
  {
    type: "function",
    name: "read_back_order",
    description:
      "Get the exact ticket when the customer asks what they have so far. Not for closing: finalize_order carries the ticket.",
    parameters: { type: "object", properties: {} },
    response_instructions: {
      success:
        "If they have already said that is everything, call finalize_order next without asking again. Otherwise read the items back once.",
      error: "Ask them to start the order again.",
    },
  },
  {
    type: "function",
    name: "finalize_order",
    description:
      "Close the order and send it to the kitchen as soon as the customer says that is everything. The result carries the ticket to read back.",
    parameters: { type: "object", properties: {} },
    response_instructions: {
      success:
        "If the order was sent, say it back in one sentence with the total and ask them to pull forward to the window. If not, ask the one question the result describes.",
      error: "Resolve what the result says is missing.",
    },
  },
  {
    type: "function",
    name: "call_crew_member",
    description:
      "Hand the lane to a human: abusive language, an order the customer insists on that you cannot take, a complaint, or anything outside ordering food.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short phrase for the crew screen." },
      },
      required: ["reason"],
    },
    response_instructions: {
      success: "Tell them a team member is coming on the line, then stay quiet.",
      error: "Apologise once and ask them to pull to the window.",
    },
  },
];

export const TOOLS: ToolDef[] = TOOL_DEFS.map(held);

export type AgentOptions = {
  voice?: string;
  voiceFocus?: "near-field" | "far-field";
  voiceFocusThreshold?: number;
  transcriptionMode?: "min_latency" | "balanced" | "max_accuracy";
  greeting?: string;
  daypart?: "breakfast" | "allday";
};

// Says what it is up front: a drive-thru agent that passes for a person is one nobody
// should have to find out about halfway through an order.
export const DEFAULT_GREETING = "Welcome to Burger Lab, I'm the automated order taker. What can I get you?";

export function buildSessionConfig(opts: AgentOptions = {}): SessionConfig {
  return {
    system_prompt: systemPromptFor(opts.daypart),
    greeting: opts.greeting ?? DEFAULT_GREETING,
    tools: TOOLS,
    input: {
      format: { encoding: "audio/pcm" },
      keyterms: menuKeyterms(100),
      transcription_mode: opts.transcriptionMode ?? "balanced",
      transcription_prompt: TRANSCRIPTION_PROMPT,
      voice_focus: opts.voiceFocus ?? "far-field",
      voice_focus_threshold: opts.voiceFocusThreshold ?? 0.85,
    },
    output: {
      voice: opts.voice ?? "eve",
      format: { encoding: "audio/pcm" },
      volume: 100,
    },
  };
}
