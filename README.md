# Backseat — one order, several people talking

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (Sep 2026).

**Most voice agents solve speech-to-text. Backseat solves speech-to-order attribution.**

A car is not one customer. The driver orders, a passenger adds a drink for themselves, a
child shouts for a milkshake, and then the driver says "no shake — and hers without
pickles". Four voices, one cart, and a correction aimed at food that belongs to someone who
is not speaking. A transcript cannot express that; a cart with owners can.

This is where public drive-thru deployments broke. McDonald's ended its IBM pilot in 2024
after videos of wrong orders went viral — one took an order from the next lane, another ran
to 260 McNuggets; Taco Bell slowed its 500-store rollout in 2025 after a prank order for
18,000 cups of water. The 2025 Intouch drive-thru study put a number on it: AI lanes are 21
seconds faster, and order accuracy drops to 83% against an 87% average.

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
| Tool `execution_mode: "hold"` | closing the order and calling the crew: no transition slot, the answer starts as the result lands |
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
kept as 16 kHz μ-law to hold the tape under 2 MB.

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

**Layer 1 — the ticket, without audio.** `npm run test:engine` runs 90 cases in under a
second. Fifty-two go straight at the order engine: corrections, ownership and permission,
back-seat requests, prank quantities, repeats, items that are not on the menu, closing, in
phrasing that follows Taskmaster-2. Eleven replay tool calls that real sessions made through
both carts of the A/B view, twelve check when a tool call may run and what the close looks
at again, six check the replay tape, five check where a customer's turn begins, and four
check how a reply is timed.

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
| Scenes passed | **17/21** | 13/21 |
| Order Exact Match | **86%** | 67% |
| Slot accuracy | **96%** | 94% |
| False adds | **1** | 6 |
| Escalation recall | **50%** | 0% |
| Speaker attribution | **95%** | 94% |
| Lines placed with no voice | **0%** | — (every line is the driver's) |
| Reply after a tool call, last word → first audible word | p50 5.7 s · p90 7.2 s (44 replies) | p50 5.5 s · p90 7.2 s (47 replies) |

The baseline's six false adds are the next lane's fries and apple pie, the kid's onion rings,
a second chicken sandwich, a second Bacon Stack for a sentence said twice, and 260 nuggets.
Backseat's one is the same kid's onion rings, and it is worth the detail: the room ear could
not place that 1.7-second shout with a voice at all, so the rule that an unplaced voice is
the driver's put the rings on the ticket. Nothing went to the kitchen — the close read the
order back and asked "is that right?", and the scripted car has no answer to that, so the
order was still open when the scene ended. A driver would have said no. Speaker attribution
only scores expected lines, so false adds cost the baseline nothing there; its one point of
difference is `passenger-owns-their-fix`, where diarization swapped the two voices. Order
Exact Match is the metric a restaurant actually feels, because a cart is either right or it
is not.

Escalation recall is one scene of two. Asked for 18,000 cups of water, the agent looked at the
menu and refused the quantity itself ("I can't do eighteen thousand of those") instead of
putting it through the ticket, so nobody was called. It has now done that in two full runs and
handed the lane over in three single runs of the same scene: the prompt tells it never to
refuse a quantity itself, and it sometimes does anyway.

On the 156 real orders, one speaker:

| Condition | Order Exact Match | Slot accuracy | False adds |
| --- | --- | --- | --- |
| Clean | 67% | 90% | 1 |
| Recorded car interior, +5 dB | 65% | 88% | 1 |

Two points of exact-match for a real car recording at +5 dB signal-to-noise is the clearest
argument in the project for far-field Voice Focus: the noise is audible on the recording and
the cart barely notices.

Reply latency runs from the customer's last word to the first frame of the agent's reply
that has any sound in it. At a drive-thru nearly every turn changes the cart, so 44 of
Backseat's 46 timed replies waited on a tool call. A run on 21 Sep put them at p50 6.3 s and
p90 10.7 s, and the traces showed where it went: the model calls a tool about 0.9 s after the
turn ends; in the default interactive mode the reply then stays open another 2.3 s for a
transition phrase this agent does not say, and the result may only go back after it; the
answer's first word follows 1.3–2.6 s later; the rest is end-of-turn detection, which we leave
to the API's adaptive default. Closing an order made two calls and paid the slot twice.

Two changes took the longest silence out. Closing is one call now — `finalize_order` hands
back the ticket to read — and the calls that end a conversation run with
`execution_mode: "hold"`, which keeps the agent silent until the result lands and answers
about 50 ms after it, with no slot. Split out of the same traces, a reply that closed the
order went from p50 8.1 s and p90 10.9 s (16 replies) to 4.6 s and 7.2 s (17 replies);
everything else stayed at p50 5.9 s. Mid-order tools stay interactive on purpose. Speech
that starts while a tool is held is dropped: "…wait, no pickles on that burger", said over a
held tool, never reached the model, on the bench and in two probes, where the interactive
slot absorbs it and the next turn applies it. Afterthoughts are how people order. The
baseline runs the same agent, so it got the same gain; this is the lane's rhythm, not the
order engine.

These are single-run figures on a stochastic pipeline, and the committed reports in
`bench/results/` are that same run. Across thirteen full runs the scene suite has landed
between 15 and 19 of 21, and the order set between 65% and 74% exact across its runs — the
gap to the baseline is stable, the third digit is not. The 156-order reports are from 20 and
21 Sep, on earlier builds; that bench speaks one sentence per session into one ear, so the
room ear, the gate and the closing are not in it.

### What still fails, and why it stays in the report

- **Two similar voices get swapped.** In `passenger-owns-their-fix` the diarization stream
  labels the driver and the passenger the wrong way round, and ownership follows it. Turning
  `max_speakers` down from 4 to 3 reduced over-splitting but did not fix it. It fails on the
  thing the project is named after, and it stays in the report.
- **A child's short shout can come back with no voice at all.** In `backseat-ignored` the
  kid's 1.7-second "And onion rings! Onion rings too!" was labelled PENDING by the room ear,
  three times in four runs on 23 September and never on the two days before. An unplaced
  voice is the driver's, so the rings went on the ticket, and only the closing read-back
  stood between them and the kitchen. It is the same weakness as the swapped voices below,
  at the other end: too little audio to place a voice at all.
- **The model sometimes refuses an absurd quantity itself** instead of letting the ticket
  decide, as in the escalation row above.
- **A code-switched sentence can lose half of itself.** "Quiero dos hamburguesas, and a large
  coke" booked two large burgers and lost the drink this run; in the run before it the focused
  ear heard "en la larga", and the agent asked which burger. It has passed in others.
- **The model sometimes adds a correction instead of applying it.** In an earlier run, "two
  lab burgers — actually, make that three" came back as `add_item(2)` twice while the agent
  said "three". It passed here.
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

The last run caught Backseat looking for a turn's words in the wrong place. In the published
run before it, `backseat-approved` put the kid's nuggets in the driver's bag, and this README
said diarization had placed the kid's voice too late. Re-running the scene with the room
ear's turns in the trace said otherwise: it had delivered "Can I have chicken nuggets?
Nuggets, please." as voice B about two seconds before the tool call ran. Attribution looked
for it from the agent's `input.speech.started`, which fires 0.6–1.5 s after the first word,
and the agent had heard the kid's line as two turns and called the tool in the second. The
window opened after the kid had finished. A customer's turn now begins at the first speech
the agent noticed after its last reply, reaching back two seconds and never into that reply.
The scene passed as designed on the next run — held as another voice's, confirmed by the
driver's "yeah, go ahead", in the kid's bag — and the share of lines Backseat could not place
with any voice went from 12% to 0% on that run and 5% on the one after.

Reading the dialogues caught what the scorer could not, and it is worth doing on every run:
in the run published here 15 of the 21 conversations are clean, against 13 in the run before
the fixes below. The scorer checks the cart; a person
at the speaker hears the conversation. Read that way, the 22 Sep run had a lone driver asked
"and the lab burgers — are those yours?" about their own food (our one-call close had made
that question the price of every short line the room ear had not placed), a driver who said
"that's everything" asked again about the next lane's apple pie, "A team member is coming on
the line. What else can I help with?", and the whole order read out twice. All four are fixed.
The close now looks again with the room ear before it asks anything, and a line still nobody's
is checked the way a crew member checks an order — "one Bacon Stack and a medium iced tea, is
that right?" — because the room ear cannot tell a lone driver's short line from a kid's, and
saying nothing had let a kid's unplaced onion rings through. Two faults are left: after a
customer's "uh-huh" the agent still acknowledges twice, and a closing read-back that nobody
answers leaves the order open — which is right for a car, and makes a scripted car look
unfinished.

What the bench caught that a microphone would not have: diarization finalises a turn about a
second after the agent's own end-of-turn, so deciding who spoke at `tool.call` time held
every item; the model reaches for `modifiers` where the schema says `add_modifiers`, so
corrections were acknowledged out loud but never applied; `chocolate` matched the alias
`cola` by substring; and an interrupted reply dropped the tool calls it had already made.

It caught a hole in consent, too. A held item needs the driver's yes, and the words of the
driver's turn come from the room ear. In one run the agent confirmed the next lane's fries
straight after the driver's "that's everything", before the room ear had delivered that
turn: the check found no words, and no words passed as consent. An empty turn is now "no yes
heard" — the item stays held and the agent asks again.

And it caught one of our own numbers. This README used to report reply latency as p50 188 ms.
That was the time to the first `reply.audio` frame, and the Voice Agent API streams frames
from the moment it decides to reply: until the words are ready they are silence, through the
whole of a tool call. The clock also started at the end of each scene's audio file, about
0.6 s after the last word. Both ends now come from the audio itself, which is why the
latency row above is slower than it used to be, and true.

The A/B view caught one the bench could not. With the microphone declined, the browser sent
no audio at all between injected clips. The room ear times words in audio, not in seconds,
so its clock fell further behind the wall clock with every pause, and within a minute every
voice came back unplaced — a kid's milkshake was booked like the driver's burger. The bench
streams a frame every 50 ms whatever is playing, which is why it never saw this. The page now
sends silence as audio, the way a live microphone does.

## What we learned about the Voice Agent API

Written for the people who build it. Each of these cost us a bug or a wrong number, and each
comes with what Backseat does about it.

- **Time to the first frame is not time to the first word.** `reply.audio` streams digital
  silence from the moment a reply starts, through the whole of a tool call. We published
  p50 188 ms before we caught it; the real figure is in the table above. A marker on the
  first voiced frame would save every builder that mistake.
- **An instant tool costs ~2.3 s in interactive mode.** The reply stays open for a transition
  phrase, and `tool.result` is only accepted once `reply.done` is the latest event. Prompting
  does not fill the slot: told to say the item back while the tool runs, the model still
  emits the calls first and puts the echo in its answer.
- **`hold` removes the slot, and drops speech that starts during it.** A held result is
  accepted at once and the answer starts ~50 ms later, but "…wait, no pickles on that
  burger", said while a tool was held, never reached the model; holding the result back until
  the customer stopped made the agent answer twice. Backseat holds only the calls after which
  the customer is done talking. An option to let user speech end a hold, the way it ends an
  interactive reply, would make hold safe for every instant tool.
- **`input.speech.started` is late.** It lagged the first word by 0.6–1.5 s, and after a short
  "that's all" it fired once the words were over. A start time on the audio clock, like the
  streaming word timings, would let two ears line up without guessing; Backseat reaches back
  from the agent's last reply instead.
- **An interrupted reply still did its work.** Its tool calls happened; only the answer is
  withheld. Backseat applies the call and treats the agent's identical re-issue as the same
  work, not a second burger.
- **`session.update` replaces `system_prompt`.** A mid-session menu change has to resend the
  whole prompt; we shipped exactly that bug in the breakfast switch.
- **A tool's `response_instructions` compete with the system prompt.** The read-back's "ask if
  that is everything" kept orders from ever closing after the driver had said so.
- **A session remembers the order it took.** Every car gets new sessions on both ears.
- **A back-channel during a tool call becomes a turn the model answers.** Semantic barge-in
  rightly does not cut the agent off for "uh-huh", but the words still reach the model as
  customer turns, and after the tool result it answers each: "Got it. Anything else?" "I've got
  those. Anything else?" A prompt rule did not stop it.
- **Twice in about seventy scenes on 22 Sep the agent went quiet for over a minute:** once 68 s
  between our tool result and its answer, once because the customer's "Nothing else." never
  became a turn. Nothing on our side was waiting.

## Project layout

```
src/lib/audio.ts        mic capture, dual-rate PCM, playback + barge-in flush, injector
src/lib/voiceAgent.ts   Voice Agent API client (events, tools, mid-session updates)
src/lib/sttStream.ts    diarization side-channel (binary PCM frames, agent_context)
src/lib/attribution.ts  speaker bookkeeping: who is the driver, who asked for what, where a turn began
src/lib/orderEngine.ts  deterministic ticket: menu resolution, guards, totals
src/lib/shadowCart.ts   the A/B cart: the same tool calls, no attribution, no guards
src/lib/tape.ts         the replay tape: what AssemblyAI said, recorded and played back
src/lib/toolDispatch.ts one place where a tool call becomes a change on the ticket, and when
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
