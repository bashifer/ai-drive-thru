/**
 * A spend guard for the hosted demo.
 *
 * The API key lives on the server, so anyone who opens the link spends the owner's
 * credits. A judge should always find a working demo, which means an enthusiastic
 * afternoon must not be able to empty the account before they arrive.
 *
 * The counter is per server instance and resets when the instance does — good enough
 * to bound a demo, and deliberately not a billing system.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const limit = Number(process.env.DEMO_SESSIONS_PER_DAY ?? 250);

let windowStartedAt = Date.now();
let used = 0;

export type SlotResult = { ok: true; remaining: number } | { ok: false; message: string };

export function takeSessionSlot(): SlotResult {
  if (Date.now() - windowStartedAt > DAY_MS) {
    windowStartedAt = Date.now();
    used = 0;
  }

  if (limit > 0 && used >= limit) {
    const hoursLeft = Math.max(1, Math.ceil((windowStartedAt + DAY_MS - Date.now()) / 3_600_000));
    return {
      ok: false,
      message: `The hosted demo has used its session budget for today — it resets in about ${hoursLeft}h. Clone the repo and run it with your own AssemblyAI key to keep going.`,
    };
  }

  used++;
  return { ok: true, remaining: limit > 0 ? limit - used : Number.POSITIVE_INFINITY };
}

export function sessionsUsedToday() {
  return { used, limit };
}
