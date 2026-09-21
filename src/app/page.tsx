"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { guestName } from "@/lib/attribution";
import { DRIVER, UNASSIGNED, ownerLabel, type OrderLine, type OrderSnapshot } from "@/lib/orderEngine";
import { describeActual } from "@/lib/scoring";
import { useBackseat, type ScenarioRun, type XRayEvent } from "@/lib/useBackseat";

import { SCENARIOS } from "@/lib/scenarios";

export default function Home() {
  const backseat = useBackseat();
  const { status, order, transcript, partial, events, speakers, primary, metrics } = backseat;
  const [engineNoise, setEngineNoise] = useState(false);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [auditing, setAuditing] = useState(false);
  // A/B: the same tool calls, also booked into a cart with no attribution and no guards.
  const [ab, setAb] = useState(true);
  const live = status === "live";

  // A model that had no part in building the ticket checks it against the lane audio.
  const runAudit = async () => {
    setAuditing(true);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript: transcript.map((t) => ({ role: t.role, text: t.text })),
          ticket: order.lines.map((l) => ({
            item: l.name,
            quantity: l.quantity,
            size: l.size,
            modifiers: l.modifiers,
            status: l.status,
            owner: l.owner,
            requestedBy: l.requestedBy,
          })),
        }),
      });
      setAudit(await res.json());
    } catch {
      setAudit({ verdict: "unknown", summary: "The audit call did not go through." });
    } finally {
      setAuditing(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#07090d] text-slate-100">
      <header className="border-b border-white/10 bg-gradient-to-r from-[#0b1220] to-[#0d1526]">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Backseat</h1>
            <p className="text-sm text-slate-400">one order, several people talking</p>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <StatusDot status={status} />
            {!live ? (
              <button
                onClick={() => backseat.start()}
                disabled={status === "starting"}
                className="rounded-lg bg-amber-400 px-5 py-2 text-sm font-semibold text-black transition hover:bg-amber-300 disabled:opacity-50"
              >
                {status === "starting" ? "Opening lane…" : "Pull up to the speaker"}
              </button>
            ) : (
              <button
                onClick={() => backseat.stop()}
                className="rounded-lg border border-white/20 px-5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
              >
                End call
              </button>
            )}
          </div>
        </div>

        {backseat.micDenied && !backseat.error && (
          <div className="border-t border-amber-400/20 bg-amber-400/5 px-6 py-2 text-sm text-amber-200/90">
            No microphone — the lane is running on injected audio. The regression tests below still work.
          </div>
        )}

        {backseat.error && (
          <div className="border-t border-red-500/30 bg-red-500/10 px-6 py-2 text-sm text-red-200">
            {backseat.error}
          </div>
        )}
      </header>

      <div
        className={`mx-auto grid max-w-[1500px] gap-4 p-4 ${
          ab
            ? "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)]"
            : "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.95fr)]"
        }`}
      >
        <OrderBoard
          order={order}
          shadow={ab ? backseat.shadowOrder : null}
          onToggleAb={() => setAb((on) => !on)}
          audit={audit}
          auditing={auditing}
          canAudit={transcript.length > 1}
          onAudit={runAudit}
        />
        <section className="flex flex-col gap-4">
          <TranscriptPane transcript={transcript} partial={partial} primary={primary} />
          <RegressionPanel
            live={live}
            ab={ab}
            run={backseat.scenarioRun}
            onRun={backseat.runScenario}
            engineNoise={engineNoise}
            onToggleNoise={() => setEngineNoise(backseat.toggleNoise("engine", 0.22))}
            onDaypart={backseat.setDaypart}
          />
        </section>
        <XRayPane events={events} speakers={speakers} primary={primary} metrics={metrics} />
      </div>
    </main>
  );
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { text: string; cls: string }> = {
    idle: { text: "lane closed", cls: "bg-slate-500" },
    starting: { text: "connecting", cls: "bg-amber-400 animate-pulse" },
    live: { text: "lane live", cls: "bg-emerald-400 animate-pulse" },
    stopping: { text: "closing", cls: "bg-amber-400" },
    error: { text: "error", cls: "bg-red-500" },
  };
  const s = map[status] ?? map.idle;
  return (
    <span className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-400">
      <span className={`h-2 w-2 rounded-full ${s.cls}`} />
      {s.text}
    </span>
  );
}

type Audit = {
  verdict: string;
  accuracy?: number;
  summary?: string;
  findings?: { severity: string; what: string; evidence: string }[];
};

function OrderBoard({
  order,
  shadow,
  onToggleAb,
  audit,
  auditing,
  canAudit,
  onAudit,
}: {
  order: OrderSnapshot;
  /** The cart that trusts every call — present when A/B mode is on. */
  shadow: OrderSnapshot | null;
  onToggleAb: () => void;
  audit: Audit | null;
  auditing: boolean;
  canAudit: boolean;
  onAudit: () => void;
}) {
  const gap = shadow ? compareCarts(shadow, order) : null;

  return (
    <section className="flex flex-col rounded-2xl border border-white/10 bg-[#0b0f17]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-300">Order confirmation board</h2>
        <div className="flex items-center gap-2">
          {!shadow && order.escalated && <CrewCalled />}
          <button
            onClick={onToggleAb}
            aria-pressed={shadow !== null}
            title="Book the same tool calls into a second cart that has no attribution and no guards"
            className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
              shadow ? "border-rose-400/50 bg-rose-400/10 text-rose-200" : "border-white/15 text-slate-300 hover:bg-white/5"
            }`}
          >
            A/B {shadow ? "on" : "off"}
          </button>
        </div>
      </div>

      {shadow && gap && (
        <div className="border-b border-white/10 px-5 py-2 text-xs">
          <p className="text-slate-400">
            Same tool calls, two carts. Only Backseat answers the agent; the cart on the left books every call it is
            given.
          </p>
          {gap.lines.length > 0 && (
            <p className="mt-1 font-medium text-rose-300">
              Difference: {gap.lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")}
              {gap.money > 0 && ` · $${money(gap.money)}`}
            </p>
          )}
        </div>
      )}

      <div className={`grid gap-5 px-5 py-4 ${shadow ? "sm:grid-cols-2" : ""}`}>
        {shadow && gap && (
          <Receipt
            heading={
              <ReceiptHeading
                title="Single ear, no guards"
                note="books every call it is given"
                titleClass="text-rose-300"
                escalated={shadow.escalated}
              />
            }
            snapshot={shadow}
            totalClass={gap.money > 0 ? "text-rose-300" : "text-slate-200"}
          >
            <TrustingLines lines={shadow.lines} tags={gap.tags} />
          </Receipt>
        )}
        <Receipt
          heading={
            shadow ? (
              <ReceiptHeading
                title="Backseat"
                note="two ears, guards on"
                titleClass="text-emerald-300"
                escalated={order.escalated}
              />
            ) : undefined
          }
          snapshot={order}
          totalClass="text-amber-300"
        >
          <BackseatLines order={order} />
        </Receipt>
      </div>

      {(order.flags.length > 0 || audit || canAudit) && (
        <div className="border-t border-white/10 px-5 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">Crew view</h3>
            {canAudit && (
              <button
                onClick={onAudit}
                disabled={auditing}
                className="rounded-md border border-white/15 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
              >
                {auditing ? "auditing…" : "audit this order"}
              </button>
            )}
          </div>
          <ul className="space-y-1 text-xs text-amber-200/90">
            {order.flags.slice(0, 4).map((f) => (
              <li key={f.id}>• {f.message}</li>
            ))}
          </ul>
          {audit && (
            <div className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    audit.verdict === "clean" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-200"
                  }`}
                >
                  {audit.verdict}
                </span>
                {typeof audit.accuracy === "number" && (
                  <span className="text-slate-400">order accuracy {audit.accuracy}%</span>
                )}
              </div>
              <p className="text-slate-300">{audit.summary}</p>
              {audit.findings?.map((f, i) => (
                <p key={i} className="mt-1 text-slate-400">
                  • {f.what} <span className="text-slate-600">“{f.evidence}”</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

    </section>
  );
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Which lines of the trusting cart Backseat did not book: held for the driver, or never
 * on its ticket at all. Lines are matched on what the kitchen reads — item, quantity,
 * size, modifiers — because the trusting cart has no idea whose food anything is.
 */
function compareCarts(trusting: OrderSnapshot, real: OrderSnapshot) {
  const tally = (lines: OrderLine[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(describeActual(line), (counts.get(describeActual(line)) ?? 0) + 1);
    return counts;
  };
  const take = (counts: Map<string, number>, key: string) => {
    const n = counts.get(key) ?? 0;
    if (n > 0) counts.set(key, n - 1);
    return n > 0;
  };

  const booked = tally(real.lines.filter((l) => l.status === "confirmed"));
  const held = tally(real.lines.filter((l) => l.status === "pending"));
  const tags = new Map<string, "held" | "absent">();
  for (const line of trusting.lines) {
    const key = describeActual(line);
    if (take(booked, key)) continue;
    tags.set(line.lineId, take(held, key) ? "held" : "absent");
  }

  return {
    tags,
    lines: trusting.lines.filter((l) => tags.has(l.lineId)),
    money: +(trusting.total - real.total).toFixed(2),
  };
}

function Receipt({
  heading,
  snapshot,
  totalClass,
  children,
}: {
  heading?: ReactNode;
  snapshot: OrderSnapshot;
  totalClass: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      {heading}
      <div className="flex-1 space-y-5">{children}</div>
      <div className="mt-4 border-t border-white/10 pt-3">
        <Row label="Subtotal" value={snapshot.subtotal} />
        <Row label="Tax" value={snapshot.tax} />
        <div className="mt-2 flex items-baseline justify-between text-xl font-semibold">
          <span>Total</span>
          <span className={`tabular-nums ${totalClass}`}>${money(snapshot.total)}</span>
        </div>
      </div>
    </div>
  );
}

function ReceiptHeading({
  title,
  note,
  titleClass,
  escalated,
}: {
  title: string;
  note: string;
  titleClass: string;
  escalated: boolean;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div>
        <div className={`text-xs font-semibold uppercase tracking-widest ${titleClass}`}>{title}</div>
        <div className="text-[11px] text-slate-500">{note}</div>
      </div>
      {escalated && <CrewCalled />}
    </div>
  );
}

function CrewCalled() {
  return (
    <span className="shrink-0 rounded-full bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-200">crew called</span>
  );
}

function LineText({ line }: { line: OrderLine }) {
  return (
    <>
      <div className="font-medium">
        <span className="text-slate-400">{line.quantity} ×</span> {line.size ? `${line.size} ` : ""}
        {line.name}
      </div>
      {line.modifiers.length > 0 && <div className="text-xs text-slate-400">{line.modifiers.join(", ")}</div>}
    </>
  );
}

function LinePrice({ line }: { line: OrderLine }) {
  return <span className="shrink-0 tabular-nums text-slate-300">${money(line.unitPrice * line.quantity)}</span>;
}

/** Backseat's ticket, grouped the way the bag is packed. */
function BackseatLines({ order }: { order: OrderSnapshot }) {
  if (order.lines.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Nothing on the ticket. Lines appear only after a tool call, grouped by whose food they are.
      </p>
    );
  }

  const groups = new Map<string, OrderLine[]>();
  for (const line of order.lines) {
    const list = groups.get(line.owner) ?? [];
    list.push(line);
    groups.set(line.owner, list);
  }

  return (
    <>
      {Array.from(groups.entries()).map(([owner, lines]) => (
        <div key={owner}>
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                owner === DRIVER || owner === order.driver
                  ? "bg-emerald-400/15 text-emerald-300"
                  : owner === UNASSIGNED
                    ? "bg-slate-400/15 text-slate-300"
                    : "bg-sky-400/15 text-sky-300"
              }`}
            >
              {ownerLabel(owner, order.driver)}
            </span>
          </div>
          <ul className="space-y-1.5">
            {lines.map((line) => (
              <li
                key={line.lineId}
                className={`flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 ${
                  line.status === "pending" ? "border border-amber-400/30 bg-amber-400/5" : "bg-white/[0.03]"
                }`}
              >
                <div>
                  <LineText line={line} />
                  {line.status === "pending" && (
                    <div className="mt-0.5 text-xs text-amber-300">held — waiting for the driver to confirm</div>
                  )}
                  {line.status === "confirmed" && line.unverified && (
                    <div className="mt-0.5 text-xs text-slate-500">heard, but no voice match yet</div>
                  )}
                </div>
                <LinePrice line={line} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The trusting cart: one customer, every call booked, nothing held. */
function TrustingLines({ lines, tags }: { lines: OrderLine[]; tags: Map<string, "held" | "absent"> }) {
  if (lines.length === 0) return <p className="text-sm text-slate-500">Nothing booked.</p>;

  return (
    <ul className="space-y-1.5">
      {lines.map((line) => {
        const tag = tags.get(line.lineId);
        return (
          <li
            key={line.lineId}
            className={`flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 ${
              tag === "absent"
                ? "border border-rose-400/40 bg-rose-400/10"
                : tag === "held"
                  ? "border border-amber-400/30 bg-amber-400/5"
                  : "bg-white/[0.03]"
            }`}
          >
            <div>
              <LineText line={line} />
              {tag === "absent" && <div className="mt-0.5 text-xs text-rose-300">not on Backseat&apos;s ticket</div>}
              {tag === "held" && (
                <div className="mt-0.5 text-xs text-amber-300">Backseat is holding this for the driver</div>
              )}
            </div>
            <LinePrice line={line} />
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between text-sm text-slate-400">
      <span>{label}</span>
      <span className="tabular-nums">${money(value)}</span>
    </div>
  );
}

function TranscriptPane({
  transcript,
  partial,
  primary,
}: {
  transcript: ReturnType<typeof useBackseat>["transcript"];
  partial: string;
  primary: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, partial]);

  return (
    <section className="flex min-h-[340px] flex-1 flex-col rounded-2xl border border-white/10 bg-[#0b0f17]">
      <h2 className="border-b border-white/10 px-5 py-3 text-sm font-semibold uppercase tracking-widest text-slate-300">
        Lane audio
      </h2>
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
        {transcript.length === 0 && !partial && (
          <p className="text-slate-500">The agent greets the car as soon as the lane opens.</p>
        )}
        {transcript.map((t) => (
          <div key={t.id} className={t.role === "agent" ? "text-amber-200" : "text-slate-100"}>
            <span className="mr-2 text-xs uppercase tracking-wider text-slate-500">
              {t.role === "agent" ? "Agent" : guestName(t.speaker ?? "UNKNOWN", primary)}
            </span>
            {t.text}
            {t.interrupted && <span className="ml-2 text-xs text-amber-400">— cut off by the customer</span>}
          </div>
        ))}
        {partial && <div className="text-slate-400 italic">{partial}…</div>}
        <div ref={endRef} />
      </div>
    </section>
  );
}

function RegressionPanel({
  live,
  ab,
  run,
  onRun,
  engineNoise,
  onToggleNoise,
  onDaypart,
}: {
  live: boolean;
  ab: boolean;
  run: ScenarioRun | null;
  onRun: (scenario: (typeof SCENARIOS)[number]) => void;
  engineNoise: boolean;
  onToggleNoise: () => void;
  onDaypart: (d: "breakfast" | "allday") => void;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#0b0f17] px-5 py-4">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-slate-300">Regression tests</h2>
      <p className="mb-3 text-xs text-slate-500">
        Each one plays a scripted car into the microphone and scores the cart against an expected ticket. Same
        scenes, same audio, every run.
      </p>

      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((scenario) => {
          const active = run?.scenarioId === scenario.id;
          const state = active ? run.status : null;
          return (
            <button
              key={scenario.id}
              onClick={() => onRun(scenario)}
              disabled={!live || run?.status === "running"}
              title={scenario.proves}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                state === "pass"
                  ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200"
                  : state === "fail"
                    ? "border-red-400/50 bg-red-400/10 text-red-200"
                    : state === "running"
                      ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                      : "border-white/15 hover:bg-white/5"
              }`}
            >
              {state === "pass" ? "PASS · " : state === "fail" ? "FAIL · " : ""}
              {scenario.title}
            </button>
          );
        })}
      </div>

      {run && (
        <div className="mt-3 rounded-lg bg-white/[0.03] px-3 py-3 font-mono text-[11px] leading-relaxed">
          <div className="mb-1 flex items-center gap-2 font-sans">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                run.status === "pass"
                  ? "bg-emerald-400/15 text-emerald-300"
                  : run.status === "fail"
                    ? "bg-red-400/15 text-red-200"
                    : "bg-amber-400/15 text-amber-200"
              }`}
            >
              {run.status === "running" ? `step ${run.step}/${run.steps}` : run.status}
            </span>
            <span className="text-slate-300">{run.title}</span>
          </div>
          <div className="text-slate-500">expected</div>
          <div className="text-slate-300">{run.expected.join(", ") || "(empty cart)"}</div>
          <div className="mt-1 text-slate-500">observed</div>
          <div className="text-slate-300">{run.ticket.join(", ") || (run.status === "running" ? "…" : "(empty cart)")}</div>
          {ab && run.shadow && (
            <>
              <div className="mt-1 flex items-center gap-2 text-slate-500">
                same calls, single ear, no guards
                <span
                  className={`rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase ${
                    run.shadow.pass ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-200"
                  }`}
                >
                  {run.shadow.pass ? "pass" : "fail"}
                </span>
              </div>
              <div className="text-slate-300">{run.shadow.ticket.join(", ") || "(empty cart)"}</div>
            </>
          )}
          {run.score && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
              <span>slots {Math.round(run.score.slotAccuracy * 100)}%</span>
              <span>false adds {run.score.falseAdds}</span>
              <span>missing {run.score.missing}</span>
              {run.score.ownerAccuracy !== null && <span>owners {Math.round(run.score.ownerAccuracy * 100)}%</span>}
            </div>
          )}
          {run.notes.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-amber-200/90">
              {run.notes.slice(0, 4).map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
        <button
          onClick={onToggleNoise}
          disabled={!live}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
            engineNoise ? "border-amber-400/50 bg-amber-400/15 text-amber-200" : "border-white/15 hover:bg-white/5"
          }`}
        >
          Engine noise {engineNoise ? "on" : "off"}
        </button>
        <button
          onClick={() => onDaypart("breakfast")}
          disabled={!live}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium transition hover:bg-white/5 disabled:opacity-40"
        >
          Switch to breakfast
        </button>
      </div>
    </section>
  );
}

function XRayPane({
  events,
  speakers,
  primary,
  metrics,
}: {
  events: XRayEvent[];
  speakers: { speaker: string; label: string; ms: number }[];
  primary: string | null;
  metrics: ReturnType<typeof useBackseat>["metrics"];
}) {
  return (
    <section className="flex flex-col rounded-2xl border border-white/10 bg-[#0b0f17]">
      <h2 className="border-b border-white/10 px-5 py-3 text-sm font-semibold uppercase tracking-widest text-slate-300">
        X-ray
      </h2>

      <div className="grid grid-cols-2 gap-2 px-5 py-4 text-center">
        <Metric label="reply latency" value={metrics.replyLatencyMs === null ? "—" : `${metrics.replyLatencyMs} ms`} />
        <Metric label="best" value={metrics.bestLatencyMs === null ? "—" : `${metrics.bestLatencyMs} ms`} />
        <Metric label="barge-ins" value={String(metrics.bargeIns)} />
        <Metric label="items held" value={String(metrics.heldItems)} />
      </div>

      <div className="border-t border-white/10 px-5 py-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Voices in the car</h3>
        {speakers.length === 0 ? (
          <p className="text-xs text-slate-500">Diarization needs about a second of speech per voice.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {speakers.map((s) => (
              <li key={s.speaker} className="flex items-center justify-between">
                <span className={primary === s.speaker ? "text-emerald-300" : "text-sky-300"}>{s.label}</span>
                <span className="tabular-nums text-slate-500">{(s.ms / 1000).toFixed(1)}s</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1 overflow-y-auto border-t border-white/10 px-5 py-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Event stream</h3>
        <ul className="space-y-1.5 font-mono text-[11px] leading-snug">
          {events.map((e) => (
            <li key={e.id} className="flex gap-2">
              <span className="shrink-0 text-slate-600">{new Date(e.at).toLocaleTimeString().slice(0, 8)}</span>
              <span
                className={`shrink-0 ${
                  e.ear === "agent" ? "text-amber-300/80" : e.ear === "room" ? "text-sky-300/80" : "text-emerald-300/80"
                }`}
              >
                {e.ear}
              </span>
              <span className={e.tone === "warn" ? "text-amber-200" : "text-slate-300"}>
                {e.label}
                {e.detail && <span className="text-slate-500"> — {e.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <div className="text-lg font-semibold tabular-nums text-slate-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}
