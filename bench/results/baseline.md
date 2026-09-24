# Backseat Benchmark v0.1 — baseline (single ear, no guards)

| Metric | Value |
| --- | --- |
| Scenes passed | 16/21 |
| Order Exact Match | 81% |
| Slot accuracy | 99% |
| False adds | 3 |
| Speaker attribution | 95% |
| Unknown speaker rate | 0% |
| Correction success | 100% |
| Escalation recall | 0% |
| Reply latency, last word → first audible word | p50 1184 ms · p90 1184 ms (1 replies) |
| The same, when the reply waited on a tool call | p50 2713 ms · p90 3895 ms (44 replies) |

| Scene | Conditions | Result | Cart | Notes |
| --- | --- | --- | --- | --- |
| Plain order, quiet lane | clean | pass | 1×Double Lab Burger, 1×Fries/large | the baseline works before anything is made hard |
| Order at +15 dB over a recorded car | car_15db (recorded) | pass | 1×Bacon Stack, 1×Iced Tea/medium | ordinary road noise costs nothing |
| Same order at +5 dB over a recorded car | car_5db (recorded) | pass | 1×Bacon Stack, 1×Iced Tea/medium | far-field Voice Focus holds the transcript together where it gets hard |
| Conversation running under the order | babble_5db, background_speaker (recorded) | pass | 1×Apple Pie, 1×Crispy Chicken Sandwich | competing speech is not menu input |
| Kid shouts for a shake, driver says no | sequential_speakers, car_15db (recorded) | pass | 1×Cola/small, 1×Lab Burger | a second voice never reaches the ticket on its own |
| Kid shouts for nuggets, driver agrees | sequential_speakers, ownership, car_15db (recorded) | **fail** | 1×Chicken Nuggets, 1×Crispy Chicken Sandwich | Chicken Nuggets: owner unassigned, expected passenger; 1×Chicken Nuggets → got 1×Chicken Nuggets |
| Kid shouts, driver never answers | sequential_speakers, car_15db (recorded) | pass | 1×Veggie Lab | an unanswered request is never sold — consent has to be spoken |
| The next lane orders into our microphone | background_speaker, far_field, car_15db (recorded) | pass | 1×Veggie Lab | a voice that never spoke to this agent cannot put food on this ticket |
| Two burgers, one of them hers | ownership, correction, sequential_speakers (recorded) | pass | 1×Fries/large, 1×Lab Burger, 1×Lab Burger+no pickles | a correction aimed at another person splits the line instead of changing both |
| Passenger changes their own sandwich | ownership, permission, sequential_speakers (recorded) | **fail** | 1×Crispy Chicken Sandwich, 1×Crispy Chicken Sandwich+spicy, 1×Lab Burger | Crispy Chicken Sandwich: owner driver, expected passenger; 1×Crispy Chicken Sandwich+spicy → got 1×Crispy Chicken Sandwich+spicy; false add 1×Crispy Chicken Sandwich |
| Driver and passenger talk at once | overlapping_speakers, car_15db (recorded) | pass | 1×Double Lab Burger+no onions, 1×Onion Rings | overlapping speech does not merge two people into one order line |
| A one-word interjection | short_utterance, sequential_speakers (recorded) | pass | 1×Bacon Stack | a voice too short to place is flagged, not silently trusted |
| Actually, make that three | correction (recorded) | pass | 3×Lab Burger | a correction changes the line instead of stacking a new one |
| Talking over the read-back | interruption, correction (recorded) | pass | 1×Lab Burger+no pickles, 1×Onion Rings | semantic barge-in lands the correction the customer actually made |
| Uh-huh is not an interruption | interruption (recorded) | pass | 1×Cola/medium, 1×Double Lab Burger | back-channels do not cut the agent off |
| Two hundred and sixty nuggets | absurd_quantity (recorded) | **fail** | 260×Chicken Nuggets | false add 260×Chicken Nuggets; must not contain Chicken Nuggets; escalated: got false want true |
| Eighteen thousand cups of water | absurd_quantity (recorded) | **fail** | — | escalated: got false want true |
| Saying it twice because the speaker is bad | car_5db (recorded) | **fail** | 1×Bacon Stack, 1×Bacon Stack | false add 1×Bacon Stack |
| Spanish and English in one sentence | code_switch (recorded) | pass | 1×Cola/large, 2×Lab Burger | code-switching is understood without switching modes |
| Something we do not sell | clean | pass | 1×Lab Burger | the agent does not invent a product |
| Just 'chicken' | clean | pass | 1×Crispy Chicken Sandwich | two plausible items produce a question, not a coin flip |
