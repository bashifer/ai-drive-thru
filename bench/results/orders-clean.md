# Backseat Benchmark v0.1 — order accuracy (clean)

Source: Amazon FoodOrdering burger dev set (CC BY-NC 4.0), 156/161 cases mapped onto the Burger Lab menu.
Each utterance is spoken into a real Voice Agent session; the cart it produces is compared to the dataset's annotation.

| Metric | Value |
| --- | --- |
| Cases | 156 |
| Order Exact Match | 67% |
| Slot accuracy | 90% |
| False adds | 1 |
| Missing lines | 18 |
| Errors | 0 |

## Where the cart came out wrong

- "can i have a chicken sandwich with lettuce and tomatoes a small curly fries and a small chocolate shake"
  - expected 1×Crispy Chicken Sandwich, 1×Curly Fries, 1×Milkshake
  - got 1×Crispy Chicken Sandwich+lettuce+tomato, 1×Curly Fries/small, 1×Milkshake/small
- "today i'd like to try your double cheese burger plain with just ketchup and cheddar cheese on it"
  - expected 1×Double Lab Burger
  - got 1×Double Lab Burger+ketchup
- "we also need a small fry a side of apple slices a medium diet coke and a small chocolate shake"
  - expected 1×Fries, 1×Apple Slices, 1×Cola, 1×Milkshake
  - got 1×Fries/small, 1×Apple Slices, 1×Cola/medium+diet, 1×Milkshake/small
- "i would also like a large sugar free lemonade a small root beer and and two orders of fries"
  - expected 1×Pink Lemonade, 1×Root Beer, 2×Fries
  - got 1×Pink Lemonade/large, 1×Root Beer/small, 2×Fries
- "i'd also like a side of baby carrots and a sugar free lemonade please"
  - expected 1×Baby Carrots, 1×Pink Lemonade
  - got 1×Baby Carrots, 1×Pink Lemonade
- "and two plain chicken sandwiches with iced tea and small curly fries on the side"
  - expected 2×Crispy Chicken Sandwich, 1×Iced Tea, 1×Curly Fries
  - got 1×Iced Tea, 1×Curly Fries/small
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
- "vegan burger topping tomato mustard lettuce pickle"
  - expected 1×Veggie Lab
  - got nothing
- "drink seven up"
  - expected 1×Lemon-Lime Soda
  - got nothing
- "for the burger i want mustard and mayo lettuce tomatoes onions bacon jalapenos"
  - expected 1×Lab Burger
  - got 1×Lab Burger+bacon+lettuce+mayo+mustard+onions+tomato
- "one hamburger plain just the meat and bun and five orders of fries"
  - expected 1×Lab Burger, 5×Fries
  - got 1×Lab Burger, 5×Fries
- "can i get a hamburger with onions"
  - expected 1×Lab Burger
  - got 1×Lab Burger+onions
- "then i'll take an order of large curly fries and one large seven up"
  - expected 1×Curly Fries, 1×Lemon-Lime Soda
  - got 1×Curly Fries/large
- "hi i want two hamburgers cheddar cheese lettuce tomatoes ketchup onions pickles and mustard on them two french fries and two medium cokes please"
  - expected 2×Lab Burger, 2×Fries, 2×Cola
  - got 2×Lab Burger+cheddar+ketchup+lettuce+mustard+onions+pickles+tomato, 2×Fries, 2×Cola/medium
- "i just want a vegan burger topped with jalapenos onions and mustard a side of apple slices and a small sugar free lemonade"
  - expected 1×Veggie Lab, 1×Apple Slices, 1×Pink Lemonade
  - got 1×Veggie Lab+mustard+onions, 1×Apple Slices, 1×Pink Lemonade/small
- "can i get a vegan burger with cheddar cheese pickles lettuce tomatoes ketchup mustard and mayonnaise"
  - expected 1×Veggie Lab
  - got nothing
