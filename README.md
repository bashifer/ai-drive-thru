# Backseat — one order, several people talking

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (Sep 2026).

**Most voice agents solve speech-to-text. Backseat solves speech-to-order attribution.**

A car is not one customer. The driver orders, a passenger adds a drink for themselves, a
child shouts for a milkshake, and then the driver says "no shake — and hers without
pickles". Four voices, one cart, and a correction aimed at food that belongs to someone who
is not speaking. A transcript cannot express that; a cart with owners can.

This is where public drive-thru deployments broke. McDonald's ended its IBM pilot in 2024
after orders picked up voices from the next lane and famously ran to 260 McNuggets; Taco Bell
slowed its 500-store rollout in 2025 after a prank order for 18,000 cups of water. The 2025
Intouch drive-thru study put a number on it: AI lanes are 21 seconds faster, and order
accuracy drops to 83% against an 87% average.

## The layer this project is about

```
audio
  ↓  what was said?              Universal-3.5 Pro, far-field Voice Focus
  ↓  who said it?                streaming diarization, word-level speaker labels
  ↓  was it addressed to us?     a request to the lane, or two passengers talking
  ↓  whose item does it change?  owner vs requester, "mine" vs "hers"
  ↓  may they change it?         the driver owns the lane, everyone owns their own food
  ↓  does it need confirmation?  candidate request → driver's yes → cart
cart mutation
```

The first two rows are AssemblyAI's. The bottom four are the product, and they are where a
drive-thru order actually goes wrong.

## What it does

- **Keeps one cart for several people.** Every line carries an owner and a requester. "Hers
  without pickles" splits a line of two burgers and changes exactly one of them.
- **Distinguishes a request from a cart change.** A voice that is not the driver produces a
  candidate; the driver's yes turns it into food. Nobody's shake arrives unasked.
- **Enforces who may change what.** The driver may change anything. A passenger may change
  their own item, and needs the driver for anyone else's.
- **Refuses absurd orders.** Quantity, repeat-loop and total guards turn "260 nuggets" into
  a question and "18,000 waters" into a human handover.
- **Closes into one kitchen ticket, bagged by person.** When the driver says that's
  everything, the order goes to the kitchen grouped by whose food it is; anything nobody
  confirmed is left off and said out loud.
- **Survives noise and interruptions.** Far-field Voice Focus for engine rumble, semantic
  barge-in so a correction lands mid-sentence while "uh-huh" does not.
- **Proves it.** Every demo button is a regression test with an expected cart, scored
  PASS/FAIL against the same acoustic conditions each time.

## Where this sits

Deciding *whether speech was addressed to the system* is an active area on its own —
attention labs shipped a Selective Auditory Attention system in 2026 aimed at exactly the
drive-thru case, and ai-coustics published a real drive-thru benchmark separating a main
speaker from passengers and radio. AssemblyAI's own far-field Voice Focus exists for rooms,
kiosks and drive-thrus.

Backseat does not claim to be first to notice the passenger problem. It takes the opposite
end of it: not *whom to ignore*, but **what a cart should do when several real people build
one order together** — ownership, permission, candidate-versus-confirmed state, and a
deterministic audit trail from each cart mutation back to the voice that caused it.

## Architecture: two ears

```
Microphone (browser, echo cancellation on)
  │
  ├─► Voice Agent API            wss://agents.assemblyai.com/v1/ws        ← the focused ear
  │     Universal-3.5 Pro STT + LLM + TTS in one socket
  │     far-field Voice Focus · keyterms · semantic turn detection · barge-in
  │     tool.call ─► Order engine (menu resolution, guards) ─► Board + crew view
  │                        ▲
  │                        │ who asked for this?
  └─► Streaming STT             wss://streaming.assemblyai.com/v3/ws      ← the room ear
        universal-3-5-pro, speaker_labels=true, no voice focus (it must hear everyone)
        agent_context pushed after every agent reply
```

The focused ear runs the conversation. The room ear answers one question — *who said that* —
and the order engine, not the model, decides what that means for the ticket.

## AssemblyAI features and where they earn their place

| Feature | Where it is used |
| --- | --- |
| Voice Agent API (single WebSocket: STT + LLM + TTS + tools) | the whole lane conversation |
| Semantic end-of-turn + tool parameter hints | waits for a complete quantity instead of cutting in after "two…" |
| Semantic barge-in, `transcript.agent.interrupted` | mid-read-back corrections; back-channels do not interrupt |
| Voice Focus `far-field` | engine, wind, radio (the docs name drive-thru speakers for this variant) |
| `keyterms` + `transcription_prompt` | menu items, sizes, modifiers heard right the first time |
| `session.update` mid-session | breakfast → all-day menu switch with no reconnect |
| Client-side tools + `response_instructions` | the order engine; the model proposes, code decides |
| `reply.create` | the agent proactively asks the driver about a back-seat request |
| Streaming diarization (`speaker_labels`, `max_speakers`) | per-voice attribution and the split ticket |
| `agent_context` (Universal-3.5 Pro) | the room ear knows the question, so "large" and "yeah" land right |
| Code-switching (18 input languages) | "Quiero dos tacos, and a large Coke" |

## Running it

```bash
npm install
cp .env.example .env.local   # paste your AssemblyAI key
npm run dev
```

Open http://localhost:3000 in a Chromium browser. **▶ Watch a recorded lane** needs no key and
no microphone; **Pull up to the speaker** opens a live one.

### The demo buttons are the test suite

The page carries six regression tests. Each plays a scripted car into the microphone bus —
the driver, the kid, the passenger, the next lane — waits for the agent to work, then scores
the resulting cart against an expected ticket and shows PASS or FAIL with what was expected,
what arrived, and which slots differ. They are the same scenes the offline bench runs.
Every test is a new car: a session that has taken an order remembers it ("I've already got a
lab burger on there"), so the lane opens fresh sessions on both ears for the next one, just
as the bench does for every scene.

```bash
npm run clips     # writes public/clips/*.wav once, using AssemblyAI voices
```

Clips are mixed in *after* the browser's echo canceller, so the models hear them cleanly, and
**a declined microphone does not stop anything**: the lane falls back to injected audio and
every test still runs. One person, one laptop, no second voice required.

### A/B: the same calls, two carts

The order board shows two receipts. Every tool call the agent makes is booked twice: into
Backseat's ticket, and into a shadow cart built exactly like the bench's `--baseline` — one
ear, every voice treated as the driver, no guards. Only Backseat's answers go back to the
agent, so it is one conversation with two bookkeepers. Run **Two hundred and sixty nuggets**
and the left receipt reads `260 × Chicken Nuggets`, $1,207.42 with tax, while the right one is
empty with the crew called. Every line the left cart booked and Backseat did not is marked,
and each regression test scores both carts.

Where Backseat's own question shaped the conversation, the shadow gets the benefit of the
doubt. A driver's "no" to a held request takes it off the shadow too, as the `remove_item` a
single-ear agent would have made; a "yes" changes nothing, because the shadow booked the item
on the spot. The gap on screen is therefore a lower bound. The baseline column in the results
below measures the other half: the same audio through a separate single-ear conversation,
steered by its own answers.

### Replay: a recorded lane, decided again

**▶ Watch a recorded lane** plays three cars — 260 nuggets, a kid shouting for a shake, and
"hers without pickles" — in about two minutes, with no microphone, no key and no credits.

The tape (`public/replays/lane.json`) holds only what AssemblyAI said: the Voice Agent's events
(transcripts, tool calls, the agent's own voice) and the room ear's finished turns with their
word timings and speaker labels. Nothing Backseat decided is on it. The events go through the
same handlers at the moments they happened, so attribution, the order engine and both carts
decide again in the browser as it plays; the session ids in the X-ray are the recorded
sessions' own. Silences in which nothing happens are cut to a beat, and the agent's voice is
kept as 16 kHz μ-law to hold the tape to 1.6 MB.

To record another: `npm run dev`, open `/?record`, run the tests you want on it, then press
**● recording · save tape**. The page writes `public/replays/lane.json` through a route that
exists only in development.

## Testing: a virtual car, not a microphone

There is no public corpus of drive-thru orders with a kid shouting over the driver and a
correct ticket attached. The nearest open data is Google's
[Taskmaster-2 food-ordering corpus](https://github.com/google-research-datasets/Taskmaster/tree/master/TM-2-2020)
(CC BY 4.0, 1,050 real ordering dialogues — text, one speaker), in-car multi-speaker audio
like AISHELL-5 (Mandarin, no orders), and noise sets like MS-SNSD and DEMAND. So the bench
builds its own scenes, with ground truth.

**Layer 1 — the ticket, without audio.** `npm run test:engine` runs 60 cases in under a
second. Forty-three go straight at the order engine: corrections, ownership and permission,
back-seat requests, prank quantities, repeats, items that are not on the menu, in phrasing
that follows Taskmaster-2. Eleven replay tool calls that real sessions made through both
carts of the A/B view, and six check the replay tape.

**Layer 2 — the scene bench.** `npm run bench` plays a scripted car into the real APIs.
Voices come from AssemblyAI's own TTS (a Voice Agent session whose `greeting` is the line),
so scenes have a dozen consistent speaker identities and no third-party corpus to license.
Each scene is rendered frame by frame in real time — engine rumble plus whoever is speaking —
and streamed into both ears. Below the WebSocket nothing is simulated: same agent, same
tools, same order engine as the browser.

Lines are cued off the conversation rather than a stopwatch: `after_agent` waits for the
agent to finish, `interrupt` deliberately talks over it, `at` drops a voice in from the next
lane at a fixed moment. Every scene declares the ticket it expects, the items that must
never appear, and how many distinct voices the room ear should end up with.

```bash
npm run bench                       # 21 scenes, full stack
npm run bench -- --baseline         # same audio, single ear, no guards
npm run bench -- --scene backseat-declined
npm run fetch:noise                 # recorded car, traffic and babble beds
npm run bench:orders                # 156 real orders, one speaker
npm run bench:orders -- --snr 5     # the same 156 over a recorded car
npm run test:engine                 # the ticket layer, no audio, under a second
```

A single scene or a `--limit` sample reports to `bench/cache/runs/`; only a full run replaces
the published reports in `bench/results/`.

**Real noise.** `npm run fetch:noise` prepares recorded beds — a car interior, street
traffic and human babble — from Microsoft's [MS-SNSD](https://github.com/microsoft/MS-SNSD)
noise set (MIT). Scenes that ask for `car` or `babble` use them automatically and the report
marks those rows `(recorded)`; without the beds the bench falls back to synthesised rumble and
says so, because "+5 dB over a real car" and "+5 dB over brown noise" are not the same claim.
[DEMAND](https://zenodo.org/records/1227121) (CC BY 4.0) works too: download an archive and
pass `npm run fetch:noise -- --demand <path to TCAR_16k.zip>`.

**Layer 3 — the order layer at volume.** `npm run bench:orders` speaks 156 utterances from
[Amazon's FoodOrdering dataset](https://github.com/amazon-science/food-ordering-semantic-parsing-dataset)
(CC BY-NC 4.0) into a real session, each with an annotated order attached, and compares the
cart slot by slot. 156 of the 161 dev cases map onto this menu; the five that do not are
reported rather than dropped. The data is fetched on demand into a gitignored folder — this
repository carries the parser, the mapping and the runner, not the corpus.

## Results

Same audio, same agent, same tools. The only difference is whether the room ear and the
order guards are switched on.

| | Backseat | Single ear, no guards |
| --- | --- | --- |
| Scenes passed | **19/21** | 14/21 |
| Order Exact Match | **91%** | 67% |
| Slot accuracy | 96% | 99% |
| False adds | **0** | 8 |
| Escalation recall | **100%** | 0% |
| Speaker attribution | 95% | 95% |
| Reply latency | p50 188 ms · p90 506 ms | p50 190 ms · p90 478 ms |

Slot accuracy is the one row the baseline wins, and it is worth saying why: it counts how
much of each *expected* line arrived, and a system that adds everything it hears scores well
on it. The false-add row is the other half of that sentence — the baseline books the next
lane's fries, 260 nuggets and 18,000 cups of water. Order Exact Match is the metric a
restaurant actually feels, because a cart is either right or it is not.

On the 156 real orders, one speaker:

| Condition | Order Exact Match | Slot accuracy | False adds |
| --- | --- | --- | --- |
| Clean | 67% | 90% | 1 |
| Recorded car interior, +5 dB | 65% | 88% | 1 |

Two points of exact-match for a real car recording at +5 dB signal-to-noise is the clearest
argument in the project for far-field Voice Focus: the noise is audible on the recording and
the cart barely notices.

Reply latency counts first audio out after the customer stopped speaking, over 47 replies.
Thirteen more replies took longer than five seconds because they were waiting on a tool round
trip; those are reported separately rather than folded into the percentile, since they measure
the kitchen, not the turn-taking.

These are single-run figures on a stochastic pipeline, and the committed reports in
`bench/results/` are that same run. Across eight runs the scene suite has landed between 15
and 19 of 21 and the order set between 65% and 74% exact — the gap to the baseline is stable,
the third digit is not.

### What still fails, and why it stays in the report

- **Two similar voices get swapped.** In `passenger-owns-their-fix` the diarization stream
  labels the driver and the passenger the wrong way round, and ownership follows it. Turning
  `max_speakers` down from 4 to 3 reduced over-splitting but did not fix it. This is the one
  scene that fails on the thing the project is named after, and it stays in the report.
- **A size can attach to the wrong item in a code-switched sentence.** "Quiero dos
  hamburguesas, and a large coke" sometimes books two large burgers and loses the drink.
- **"Mhm" comes back as "milk".** Reliably enough that the back-channel scene now says
  "Uh-huh. Right." instead — the scene is about turn-taking, not about that homophone.
- These are arguments for the tiers below, not scenes to be tuned until they are green.

### Honest about the audio

Scene voices are AssemblyAI TTS and the engine rumble is synthesised, so these numbers measure
the *order logic* under controlled conditions. Synthetic voices are cleaner than people: no
accents, no Lombard effect, no breath, and diarization finds them easier than it would find a
real car. The ladder this is climbing:

| Tier | Audio | What it proves | Status |
| --- | --- | --- | --- |
| A | synthetic voices, synthetic noise | order logic, regressions, every commit | in the repo |
| B | same scenes over recorded car, traffic and babble | robustness to real noise | in the repo (`npm run fetch:noise`) |
| C | scenes re-recorded through a speaker in a car | far field and the device path | not yet |
| D | live demo with people | that it works with humans at all | the video |

The voices are still TTS at every tier below D. That is the honest limit of these numbers:
synthetic speakers are easier to tell apart than real ones, which is exactly where the two
failing scenes above live.

The baseline flag is the honest comparison: identical audio and identical agent, with only
the diarization gating and the order guards turned off. Reports land in `bench/results/`.

What the bench caught that a microphone would not have: diarization finalises a turn about a
second after the agent's own end-of-turn, so deciding who spoke at `tool.call` time held
every item; the model reaches for `modifiers` where the schema says `add_modifiers`, so
corrections were acknowledged out loud but never applied; `chocolate` matched the alias
`cola` by substring; and an interrupted reply dropped the tool calls it had already made.

The A/B view caught one the bench could not. With the microphone declined, the browser sent
no audio at all between injected clips. The room ear times words in audio, not in seconds,
so its clock fell further behind the wall clock with every pause, and within a minute every
voice came back unplaced — a kid's milkshake was booked like the driver's burger. The bench
streams a frame every 50 ms whatever is playing, which is why it never saw this. The page now
sends silence as audio, the way a live microphone does.

## Project layout

```
src/lib/audio.ts        mic capture, dual-rate PCM, playback + barge-in flush, injector
src/lib/voiceAgent.ts   Voice Agent API client (events, tools, mid-session updates)
src/lib/sttStream.ts    diarization side-channel (binary PCM frames, agent_context)
src/lib/attribution.ts  speaker bookkeeping: who is the driver, who asked for what
src/lib/orderEngine.ts  deterministic ticket: menu resolution, guards, totals
src/lib/shadowCart.ts   the A/B cart: the same tool calls, no attribution, no guards
src/lib/tape.ts         the replay tape: what AssemblyAI said, recorded and played back
src/lib/toolDispatch.ts one place where a tool call becomes a change on the ticket
src/lib/menu.ts         Burger Lab menu, aliases, keyterms
src/lib/agentConfig.ts  system prompt, tool schemas, transcription prompt
src/app/page.tsx        order confirmation board, lane audio, X-ray panel
public/replays/         the recorded lane behind "Watch a recorded lane"
bench/                  the virtual car: scenes, TTS cache, runner, reports
tests/                  the ticket layer, no audio needed
```

Burger Lab is a fictional brand. No real restaurant chain is affiliated or depicted.

## Licence

MIT.
