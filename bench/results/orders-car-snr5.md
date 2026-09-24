# Backseat Benchmark v0.1 — order accuracy (recorded car +5 dB)

Source: Amazon FoodOrdering burger dev set (CC BY-NC 4.0), 156/161 cases mapped onto the Burger Lab menu.
Each utterance is spoken into a real Voice Agent session; the cart it produces is compared to the dataset's annotation.

| Metric | Value |
| --- | --- |
| Cases | 156 |
| Order Exact Match | 93% |
| Slot accuracy | 96% |
| False adds | 1 |
| Missing lines | 6 |
| Errors | 1 |

## Where the cart came out wrong

- "i would like two cheeseburgers with lettuce pickles and mustard"
  - expected 2×Lab Burger+lettuce+mustard+pickles
  - got nothing (at_capacity: We are currently at capacity, please try again later)
- "hi i want a vegan burger with extra onions lettuce pickles and mustard"
  - expected 1×Veggie Lab+lettuce+mustard+pickles
  - got nothing
- "and two plain chicken sandwiches with iced tea and small curly fries on the side"
  - expected 2×Crispy Chicken Sandwich, 1×Iced Tea, 1×Curly Fries/small
  - got 2×Crispy Chicken Sandwich, 2×Iced Tea, 1×Curly Fries/small
- "double bacon cheeseburger with mustard and lettuce large curly fry and a milk"
  - expected 1×Double Lab Burger+bacon+lettuce+mustard, 1×Fries/large, 1×Milk
  - got 1×Double Lab Burger+bacon+lettuce+mustard, 1×Curly Fries/large, 1×Milk
- "vegan burger topping tomato mustard lettuce pickle"
  - expected 1×Veggie Lab+lettuce+mustard+pickles+tomato
  - got nothing
- "drink seven up"
  - expected 1×Lemon-Lime Soda
  - got nothing
- "for the burger i want mustard and mayo lettuce tomatoes onions bacon jalapenos"
  - expected 1×Lab Burger+bacon+jalapenos+lettuce+mayo+mustard+no cheese+onions+tomato
  - got 1×Lab Burger+bacon+jalapenos+lettuce+mayo+mustard+onions+tomato
- "hi i want two hamburgers cheddar cheese lettuce tomatoes ketchup onions pickles and mustard on them two french fries and two medium cokes please"
  - expected 2×Lab Burger+cheddar+ketchup+lettuce+mustard+no cheese+onions+pickles+tomato, 2×Fries, 2×Cola/medium
  - got 2×Lab Burger+cheddar+ketchup+lettuce+mustard+onions+pickles+tomato, 2×Fries, 2×Cola/medium
- "can i get a vegan burger with cheddar cheese pickles lettuce tomatoes ketchup mustard and mayonnaise"
  - expected 1×Veggie Lab+cheddar+ketchup+lettuce+mayo+mustard+pickles+tomato
  - got nothing
- "i would like a hamburger with cheddar cheese bacon mustard and ketchup a small order of curly fries and a large chocolate shake to drink"
  - expected 1×Lab Burger+bacon+cheddar+ketchup+mustard+no cheese, 1×Curly Fries/small, 1×Milkshake/large+chocolate
  - got 1×Lab Burger+bacon+cheddar+ketchup+mustard, 1×Curly Fries/small, 1×Milkshake/large+chocolate
- "i like to order a hamburger with tomatoes cheddar cheese lettuce ketchup and ice tea and french fries on the side"
  - expected 1×Lab Burger+cheddar+ketchup+lettuce+no cheese+tomato, 1×Iced Tea, 1×Fries
  - got 1×Lab Burger+cheddar+ketchup+lettuce+tomato, 1×Iced Tea, 1×Fries
