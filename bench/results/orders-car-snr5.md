# Backseat Benchmark v0.1 — order accuracy (recorded car +5 dB)

Source: Amazon FoodOrdering burger dev set (CC BY-NC 4.0), 156/161 cases mapped onto the Burger Lab menu.
Each utterance is spoken into a real Voice Agent session; the cart it produces is compared to the dataset's annotation.

| Metric | Value |
| --- | --- |
| Cases | 156 |
| Order Exact Match | 65% |
| Slot accuracy | 88% |
| False adds | 1 |
| Missing lines | 25 |
| Errors | 0 |

## Where the cart came out wrong

- "i would like a vegan burger with lettuce tomatoes and onions and a large order of sweet potato fries"
  - expected 1×Veggie Lab, 1×Sweet Potato Fries
  - got nothing
- "can i have a chicken sandwich with lettuce and tomatoes a small curly fries and a small chocolate shake"
  - expected 1×Crispy Chicken Sandwich, 1×Curly Fries, 1×Milkshake
  - got 1×Crispy Chicken Sandwich+lettuce+tomato, 1×Curly Fries/small, 1×Milkshake/small
- "we also need a small fry a side of apple slices a medium diet coke and a small chocolate shake"
  - expected 1×Fries, 1×Apple Slices, 1×Cola, 1×Milkshake
  - got 1×Fries/small, 1×Apple Slices, 1×Cola/medium+diet, 1×Milkshake/small
- "i would also like a large sugar free lemonade a small root beer and and two orders of fries"
  - expected 1×Pink Lemonade, 1×Root Beer, 2×Fries
  - got 1×Pink Lemonade/large, 1×Root Beer/small, 2×Fries
- "hi i want a vegan burger with extra onions lettuce pickles and mustard"
  - expected 1×Veggie Lab
  - got nothing
- "i'd also like a side of baby carrots and a sugar free lemonade please"
  - expected 1×Baby Carrots, 1×Pink Lemonade
  - got nothing
- "and two plain chicken sandwiches with iced tea and small curly fries on the side"
  - expected 2×Crispy Chicken Sandwich, 1×Iced Tea, 1×Curly Fries
  - got 2×Iced Tea, 1×Curly Fries/small
- "hi i'd like a double cheeseburger with bacon and jalapenos a medium dr pepper and a small order of sweet potato fries"
  - expected 1×Double Lab Burger, 1×Dr Pepper, 1×Sweet Potato Fries
  - got 1×Double Lab Burger+bacon, 1×Dr Pepper/medium, 1×Sweet Potato Fries/small
- "i want two chicken sandwich with bacon lettuce tomatoes onions jalapenos and mustard and mayo"
  - expected 2×Crispy Chicken Sandwich
  - got 2×Crispy Chicken Sandwich+bacon+lettuce+mayo+mustard+onions+tomato
- "can i get a double cheeseburger with bacon jalapenos lettuce onions mayo and mustard"
  - expected 1×Double Lab Burger
  - got 1×Double Lab Burger+bacon+lettuce+mayo+mustard+onions
- "also a large vanilla shake"
  - expected 1×Milkshake
  - got 1×Milkshake/large
- "also a large fry and a medium coke"
  - expected 1×Fries, 1×Cola
  - got 1×Fries/large
- "i'll have a cheeseburger with ketchup mustard onions and pickles a large order of garlic fries a small chocolate shake and i need a large dr pepper"
  - expected 1×Lab Burger, 1×Garlic Fries, 1×Milkshake, 1×Dr Pepper
  - got 1×Lab Burger+ketchup+mustard+onions+pickles, 1×Garlic Fries/large, 1×Milkshake/small, 1×Dr Pepper/large
- "double bacon cheeseburger with mustard and lettuce large curly fry and a milk"
  - expected 1×Double Lab Burger, 1×Fries, 1×Milk
  - got 1×Curly Fries/large, 1×Milk
- "i'll have a hamburger topped with bacon and ketchup along with a large coke and large order of french fries"
  - expected 1×Lab Burger, 1×Cola, 1×Fries
  - got 1×Lab Burger+bacon+ketchup, 1×Cola/large, 1×Fries/large
- "can i get a cheeseburger with mayo and pickle only a small fry and chocolate shake please"
  - expected 1×Lab Burger, 1×Fries, 1×Milkshake
  - got 1×Lab Burger+mayo+pickles, 1×Milkshake, 1×Fries/small
- "i'd like a double cheeseburger with onions and mustard large garlic fries and a strawberry shake"
  - expected 1×Double Lab Burger, 1×Garlic Fries, 1×Milkshake
  - got 1×Double Lab Burger+mustard+onions, 1×Garlic Fries/large, 1×Milkshake
- "i would also like a small seven up"
  - expected 1×Lemon-Lime Soda
  - got nothing
- "i'd like a cheeseburger with mayonnaise lettuce and tomato small fries and a medium dr pepper"
  - expected 1×Lab Burger, 1×Fries, 1×Dr Pepper
  - got nothing
- "vegan burger topping tomato mustard lettuce pickle"
  - expected 1×Veggie Lab
  - got nothing
- "drink seven up"
  - expected 1×Lemon-Lime Soda
  - got nothing
- "can i get a plain chicken sandwich small curly fries and a medium dr pepper"
  - expected 1×Crispy Chicken Sandwich, 1×Curly Fries, 1×Dr Pepper
  - got 1×Crispy Chicken Sandwich, 1×Curly Fries, 1×Dr Pepper
- "for the burger i want mustard and mayo lettuce tomatoes onions bacon jalapenos"
  - expected 1×Lab Burger
  - got 1×Lab Burger+bacon+lettuce+mayo+mustard+onions+tomato
- "with small garlic fries and a small seven up"
  - expected 1×Garlic Fries, 1×Lemon-Lime Soda
  - got 1×Garlic Fries/small
- "one hamburger plain just the meat and bun and five orders of fries"
  - expected 1×Lab Burger, 5×Fries
  - got 1×Lab Burger, 5×Fries
