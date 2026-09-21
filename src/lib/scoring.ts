import type { OrderLine } from "./orderEngine";

/**
 * Scoring a drive-thru order is not scoring a transcript.
 *
 * Word error rate says how pretty the transcript was; it does not say whether the
 * bag handed through the window matches what the car asked for. These metrics score
 * the cart — including who each line belongs to, which is the part a transcript
 * cannot express at all.
 */

export type OwnerRole = "driver" | "passenger" | "unassigned" | "any";

export type ExpectedLine = {
  item: string;
  qty: number;
  size?: string;
  modifiers?: string[];
  /** Whose food this should be. Omit when the scene does not care. */
  owner?: OwnerRole;
};

export type Score = {
  /** The whole cart is exactly right — the only metric a restaurant actually feels. */
  orderExactMatch: boolean;
  /** Share of expected slots (item, quantity, size, each modifier, owner) that landed. */
  slotAccuracy: number;
  slotsMatched: number;
  slotsTotal: number;
  /** Lines on the ticket nobody asked for. */
  falseAdds: number;
  /** Lines that were asked for and never arrived. */
  missing: number;
  /** Share of matched lines whose owner is the person the scene says it is. */
  ownerAccuracy: number | null;
  /** Share of confirmed lines the room ear could not place with a voice. */
  unknownSpeakerRate: number;
  notes: string[];
};

const clean = (s: string) => s.toLowerCase().trim();
const modsOf = (m?: string[]) => [...(m ?? [])].map(clean).sort();

export function describeLine(l: { item: string; qty: number; size?: string; modifiers?: string[] }) {
  return `${l.qty}×${l.item}${l.size ? `/${l.size}` : ""}${
    l.modifiers?.length ? `+${modsOf(l.modifiers).join("+")}` : ""
  }`;
}

export function describeActual(l: OrderLine) {
  return describeLine({ item: l.name, qty: l.quantity, size: l.size, modifiers: l.modifiers });
}

function ownerRole(line: OrderLine, driver: string | null): OwnerRole {
  if (line.owner === "UNASSIGNED") return "unassigned";
  // "DRIVER" is the placeholder for the person the agent is talking to before
  // diarization has a label for them.
  if (line.owner === "DRIVER" || (driver && line.owner === driver)) return "driver";
  return "passenger";
}

/**
 * Greedy match: an expected line pairs with the confirmed line that agrees on the
 * most slots, so a burger that is right except for its size scores as a near miss
 * rather than one false add plus one missing item.
 */
export function scoreOrder(
  confirmed: OrderLine[],
  expected: ExpectedLine[],
  driver: string | null,
): Score {
  const notes: string[] = [];
  const unmatched = [...confirmed];
  let slotsMatched = 0;
  let slotsTotal = 0;
  let ownerChecked = 0;
  let ownerRight = 0;
  let missing = 0;

  for (const want of expected) {
    const wantMods = modsOf(want.modifiers);
    const slots = 2 + (want.size ? 1 : 0) + wantMods.length + (want.owner && want.owner !== "any" ? 1 : 0);
    slotsTotal += slots;

    let best: { line: OrderLine; hits: number; idx: number } | null = null;
    unmatched.forEach((line, idx) => {
      if (clean(line.name) !== clean(want.item)) return;
      const gotMods = modsOf(line.modifiers);
      let hits = 1; // the item itself
      if (line.quantity === want.qty) hits++;
      if (want.size && clean(line.size ?? "") === clean(want.size)) hits++;
      for (const m of wantMods) if (gotMods.includes(m)) hits++;
      if (want.owner && want.owner !== "any" && ownerRole(line, driver) === want.owner) hits++;
      if (!best || hits > best.hits) best = { line, hits, idx };
    });

    if (!best) {
      missing++;
      notes.push(`missing ${describeLine(want)}`);
      continue;
    }

    const match = best as { line: OrderLine; hits: number; idx: number };
    slotsMatched += match.hits;
    unmatched.splice(match.idx, 1);

    if (want.owner && want.owner !== "any") {
      ownerChecked++;
      const got = ownerRole(match.line, driver);
      if (got === want.owner) ownerRight++;
      else notes.push(`${want.item}: owner ${got}, expected ${want.owner}`);
    }
    if (match.hits < slots) notes.push(`${describeLine(want)} → got ${describeActual(match.line)}`);
  }

  for (const extra of unmatched) notes.push(`false add ${describeActual(extra)}`);

  const unverified = confirmed.filter((l) => l.unverified).length;

  return {
    orderExactMatch: missing === 0 && unmatched.length === 0 && slotsMatched === slotsTotal,
    slotAccuracy: slotsTotal === 0 ? 1 : +(slotsMatched / slotsTotal).toFixed(3),
    slotsMatched,
    slotsTotal,
    falseAdds: unmatched.length,
    missing,
    ownerAccuracy: ownerChecked === 0 ? null : +(ownerRight / ownerChecked).toFixed(3),
    unknownSpeakerRate: confirmed.length === 0 ? 0 : +(unverified / confirmed.length).toFixed(3),
    notes,
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
