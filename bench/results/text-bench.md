# Backseat Benchmark v0.1 — order layer (FoodOrdering, no audio)

Source: Amazon FoodOrdering burger dev set (CC BY-NC 4.0), 156/161 cases mapped onto the Burger Lab menu.
Driven through the Voice Agent API over text: same prompt, same tools, same order engine as the lane.

| Metric | Value |
| --- | --- |
| Cases | 8 |
| Order Exact Match | 0% |
| Slot accuracy | 0% |
| False adds | 0 |
| Missing lines | 14 |
| Request errors | 0 |

## Where the cart still comes out wrong

- "i would like a vegan burger with lettuce tomatoes and onions and a large order of sweet potato fries"
  - expected 1×Veggie Lab, 1×Sweet Potato Fries
  - got nothing
- "i would also like an iced tea"
  - expected 1×Iced Tea
  - got nothing
- "i'll have a cheeseburger with lettuce large french fries and a large diet coke"
  - expected 1×Lab Burger, 1×Fries, 1×Cola
  - got nothing
- "i'd like a double cheeseburger with onions pickles bacon ketchup and mustard"
  - expected 1×Double Lab Burger
  - got nothing
- "hi can i have the double cheeseburger with ketchup and onions and french fries on the side"
  - expected 1×Double Lab Burger, 1×Fries
  - got nothing
- "can i also have a medium diet coke"
  - expected 1×Cola
  - got nothing
- "can i have a chicken sandwich with lettuce and tomatoes a small curly fries and a small chocolate shake"
  - expected 1×Crispy Chicken Sandwich, 1×Curly Fries, 1×Milkshake
  - got nothing
- "hi could i please have a cheeseburger with cheddar cheese onions pickles lettuce ketchup mustard and a little mayo"
  - expected 1×Lab Burger
  - got nothing
