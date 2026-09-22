/**
 * Burger Lab menu (fictional brand — no real chain is impersonated).
 *
 * Aliases exist because the customer never says the menu name: "coke", "a large
 * sprite", "chicken sandwich". Resolution happens in code, not in the model, so a
 * mis-heard word becomes a question instead of a wrong line on the ticket.
 */

export type Size = "small" | "medium" | "large";
export type Category = "burgers" | "chicken" | "sides" | "drinks" | "desserts" | "breakfast";

export type MenuItem = {
  id: string;
  name: string;
  category: Category;
  price: number; // base price, size upcharges applied separately
  aliases: string[];
  sizes?: Size[];
  modifiers?: string[];
  daypart?: "breakfast" | "allday";
};

export const SIZE_UPCHARGE: Record<Size, number> = {
  small: 0,
  medium: 0.6,
  large: 1.2,
};

/**
 * Toppings a burger venue actually carries. The list mirrors the slot vocabulary of
 * Amazon's FoodOrdering burger menu, so real annotated utterances from that dataset
 * are executable against this menu rather than approximated.
 */
const BURGER_TOPPINGS = [
  "lettuce",
  "tomato",
  "onions",
  "pickles",
  "ketchup",
  "mustard",
  "mayo",
  "bacon",
  "cheddar",
  "jalapenos",
  "blue cheese",
];
const NO_TOPPINGS = BURGER_TOPPINGS.map((t) => `no ${t}`);
const SANDWICH_MODIFIERS = [...BURGER_TOPPINGS, ...NO_TOPPINGS, "extra cheese", "no cheese", "no sauce"];

export const MENU: MenuItem[] = [
  {
    id: "lab_burger",
    name: "Lab Burger",
    category: "burgers",
    price: 5.49,
    aliases: ["lab burger", "burger", "regular burger", "hamburger", "cheeseburger"],
    modifiers: SANDWICH_MODIFIERS,
  },
  {
    id: "double_lab",
    name: "Double Lab Burger",
    category: "burgers",
    price: 7.99,
    aliases: ["double", "double lab", "double burger", "double cheeseburger"],
    modifiers: SANDWICH_MODIFIERS,
  },
  {
    id: "bacon_stack",
    name: "Bacon Stack",
    category: "burgers",
    price: 8.49,
    aliases: ["bacon stack", "bacon burger", "stack"],
    modifiers: [...SANDWICH_MODIFIERS, "extra bacon"],
  },
  {
    id: "veggie_lab",
    name: "Veggie Lab",
    category: "burgers",
    price: 6.99,
    aliases: ["veggie", "veggie burger", "veggie lab", "plant burger", "vegan burger"],
    modifiers: SANDWICH_MODIFIERS,
  },
  {
    id: "crispy_chicken",
    name: "Crispy Chicken Sandwich",
    category: "chicken",
    price: 6.79,
    aliases: ["chicken sandwich", "crispy chicken", "chicken burger", "crispy"],
    modifiers: [...SANDWICH_MODIFIERS, "spicy", "extra sauce"],
  },
  {
    id: "nuggets",
    name: "Chicken Nuggets",
    category: "chicken",
    price: 4.29,
    aliases: ["nuggets", "nugs", "chicken nuggets", "chicken nugget"],
    sizes: ["small", "medium", "large"],
    modifiers: ["bbq sauce", "ranch", "honey mustard", "no sauce"],
  },
  {
    id: "chicken_wrap",
    name: "Chicken Wrap",
    category: "chicken",
    price: 5.29,
    aliases: ["wrap", "chicken wrap", "snack wrap"],
    modifiers: ["spicy", "no lettuce"],
  },
  {
    id: "fries",
    name: "Fries",
    category: "sides",
    price: 2.79,
    aliases: ["fries", "french fries", "chips"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no salt", "extra salt"],
  },
  {
    id: "onion_rings",
    name: "Onion Rings",
    category: "sides",
    price: 3.49,
    aliases: ["onion rings", "rings"],
    sizes: ["small", "large"],
  },
  {
    id: "curly_fries",
    name: "Curly Fries",
    category: "sides",
    price: 3.29,
    aliases: ["curly fries", "curlies"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no salt", "extra salt"],
  },
  {
    id: "garlic_fries",
    name: "Garlic Fries",
    category: "sides",
    price: 3.59,
    aliases: ["garlic fries"],
    sizes: ["small", "medium", "large"],
  },
  {
    id: "sweet_potato_fries",
    name: "Sweet Potato Fries",
    category: "sides",
    price: 3.49,
    aliases: ["sweet potato fries", "sweet potato"],
    sizes: ["small", "medium", "large"],
  },
  {
    id: "apple_slices",
    name: "Apple Slices",
    category: "sides",
    price: 1.79,
    aliases: ["apple slices", "apples"],
  },
  {
    id: "baby_carrots",
    name: "Baby Carrots",
    category: "sides",
    price: 1.79,
    aliases: ["baby carrots", "carrots"],
  },
  {
    id: "side_salad",
    name: "Side Salad",
    category: "sides",
    price: 3.29,
    aliases: ["salad", "side salad", "green salad"],
  },
  {
    id: "cola",
    name: "Cola",
    category: "drinks",
    price: 1.99,
    aliases: ["coke", "cola", "coca cola", "pepsi", "soda", "pop"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no ice", "diet"],
  },
  {
    id: "lemon_lime",
    name: "Lemon-Lime Soda",
    category: "drinks",
    price: 1.99,
    aliases: ["sprite", "lemon lime", "seven up", "7up", "lemonade soda"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no ice"],
  },
  {
    id: "iced_tea",
    name: "Iced Tea",
    category: "drinks",
    price: 1.89,
    aliases: ["iced tea", "tea", "sweet tea", "unsweet tea"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no ice", "sweet", "unsweet"],
  },
  {
    id: "coffee",
    name: "Coffee",
    category: "drinks",
    price: 1.79,
    aliases: ["coffee", "black coffee", "hot coffee"],
    sizes: ["small", "medium", "large"],
    modifiers: ["cream", "sugar", "black"],
  },
  {
    id: "water",
    name: "Bottled Water",
    category: "drinks",
    price: 1.49,
    aliases: ["water", "bottled water", "cup of water", "waters"],
  },
  {
    id: "root_beer",
    name: "Root Beer",
    category: "drinks",
    price: 1.99,
    aliases: ["root beer"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no ice"],
  },
  {
    id: "dr_pepper",
    name: "Dr Pepper",
    category: "drinks",
    price: 1.99,
    aliases: ["dr pepper", "doctor pepper"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no ice"],
  },
  {
    id: "pink_lemonade",
    name: "Pink Lemonade",
    category: "drinks",
    price: 2.19,
    aliases: ["pink lemonade", "lemonade"],
    sizes: ["small", "medium", "large"],
    modifiers: ["no ice", "zero sugar"],
  },
  {
    id: "milk",
    name: "Milk",
    category: "drinks",
    price: 1.59,
    aliases: ["milk", "carton of milk"],
  },
  {
    id: "milkshake",
    name: "Milkshake",
    category: "desserts",
    price: 3.99,
    aliases: ["shake", "milkshake", "chocolate shake", "vanilla shake", "strawberry shake"],
    sizes: ["small", "medium", "large"],
    modifiers: ["chocolate", "vanilla", "strawberry", "extra thick"],
  },
  {
    id: "apple_pie",
    name: "Apple Pie",
    category: "desserts",
    price: 2.19,
    aliases: ["pie", "apple pie"],
  },
  {
    id: "sundae",
    name: "Ice Cream Sundae",
    category: "desserts",
    price: 2.99,
    aliases: ["sundae", "ice cream", "ice cream sundae"],
    modifiers: ["chocolate", "caramel", "no nuts"],
  },
  {
    id: "egg_muffin",
    name: "Egg Muffin",
    category: "breakfast",
    price: 3.49,
    aliases: ["egg muffin", "breakfast sandwich", "muffin"],
    daypart: "breakfast",
    modifiers: ["no cheese", "add bacon", "add sausage"],
  },
  {
    id: "hash_browns",
    name: "Hash Browns",
    category: "breakfast",
    price: 2.29,
    aliases: ["hash brown", "hash browns", "potato patty"],
    daypart: "breakfast",
  },
  {
    id: "pancakes",
    name: "Pancakes",
    category: "breakfast",
    price: 4.49,
    aliases: ["pancakes", "hotcakes", "flapjacks"],
    daypart: "breakfast",
  },
];

export const COMBOS: Record<string, { name: string; items: string[]; discount: number }> = {
  lab_combo: { name: "Lab Combo", items: ["lab_burger", "fries", "cola"], discount: 1.5 },
  double_combo: { name: "Double Combo", items: ["double_lab", "fries", "cola"], discount: 1.8 },
  chicken_combo: { name: "Chicken Combo", items: ["crispy_chicken", "fries", "cola"], discount: 1.6 },
};

export const TAX_RATE = 0.0825;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Spoken Spanish that shows up in code-switched orders. */
const SPANISH_HINTS: Record<string, string> = {
  hamburguesa: "lab_burger",
  papas: "fries",
  "papas fritas": "fries",
  refresco: "cola",
  agua: "water",
  pollo: "crispy_chicken",
  ensalada: "side_salad",
  cafe: "coffee",
  batido: "milkshake",
};

export type MenuMatch = { item: MenuItem; score: number };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word containment: "cheeseburger" must not match the alias "burger",
 *  and "chocolate" must not match "cola". */
const containsPhrase = (haystack: string, needle: string) =>
  new RegExp(`(^|\\s)${escapeRe(needle)}($|\\s)`).test(haystack);

const words = (s: string) => s.split(" ").filter(Boolean);

/** Plural handling shared by item lookup and modifier matching: "fry" finds "fries". */
const singular = (s: string) => words(s).map(singularWord).join(" ");

/**
 * Resolve what the customer said to a menu item. Returns every plausible match so
 * the caller can ask instead of guessing when two items are equally likely.
 */
export function resolveMenuItem(spoken: string, daypart: "breakfast" | "allday" = "allday"): MenuMatch[] {
  const raw = normalize(spoken);
  if (!raw) return [];

  // "dos hamburguesas" is the plural the customer actually says.
  const spanishForms = [raw, singular(raw)];
  for (const [phrase, id] of Object.entries(SPANISH_HINTS)) {
    if (spanishForms.some((form) => containsPhrase(form, phrase))) {
      const item = MENU.find((m) => m.id === id);
      if (item) return [{ item, score: 1 }];
    }
  }

  const available = MENU.filter((m) =>
    daypart === "breakfast" ? m.daypart !== undefined || m.category === "drinks" : m.daypart === undefined,
  );
  const pool = available.length ? available : MENU;

  const score = (q: string): MenuMatch[] => {
    const qWords = words(q).length;
    const out: MenuMatch[] = [];

    for (const item of pool) {
      const candidates = [item.name, ...item.aliases].map(normalize);
      let best = 0;

      for (const c of candidates) {
        const cWords = words(c).length;
        if (q === c || singular(q) === singular(c)) {
          best = Math.max(best, 1);
        } else if (containsPhrase(q, c) || containsPhrase(singular(q), singular(c))) {
          // The more of what they said the alias covers, the more specific the match.
          best = Math.max(best, Math.min(0.98, 0.7 + 0.3 * (cWords / Math.max(qWords, 1))));
        } else if (containsPhrase(c, q) || containsPhrase(singular(c), singular(q))) {
          best = Math.max(best, 0.6 + 0.2 * (qWords / Math.max(cWords, 1)));
        } else {
          const overlap = tokenOverlap(q, c);
          if (overlap > 0) best = Math.max(best, 0.5 * overlap);
        }
      }

      if (best > 0.4) out.push({ item, score: best });
    }
    return out;
  };

  let matches = score(raw);
  if (!matches.length) matches = score(singular(raw));

  return matches.sort((a, b) => b.score - a.score).slice(0, 3);
}

function tokenOverlap(a: string, b: string) {
  const at = new Set(words(a).filter((t) => t.length > 2));
  const bt = words(b).filter((t) => t.length > 2);
  if (!at.size || !bt.length) return 0;
  const hit = bt.filter((t) => at.has(t)).length;
  return hit / bt.length;
}

/** Words this menu uses whose plural is not a trailing "s". */
const IRREGULAR: Record<string, string> = {
  fries: "fry",
  fry: "fry",
  patties: "patty",
  leaves: "leaf",
};

function singularWord(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.endsWith("oes")) return w.slice(0, -2);
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ss")) return w;
  if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
  return w;
}

const modifierKey = (s: string) =>
  normalize(s)
    .replace(/^without /, "no ")
    .split(" ")
    .map(singularWord)
    .join(" ");

/**
 * Match a spoken modifier to one the kitchen knows.
 *
 * People say "tomatoes" and "no onions"; the menu lists "tomato" and "no onion" or
 * the other way round. Comparing the canonical form keeps a real topping from being
 * dropped over a plural.
 */
const MODIFIER_ALIASES: Record<string, string> = {
  "sugar free": "zero sugar",
  "no sugar": "zero sugar",
  "american cheese": "cheddar",
  "cheese": "cheddar",
  "mayonnaise": "mayo",
  "hot": "spicy",
};

export function canonicalModifier(item: MenuItem, raw: string): string | null {
  const allowed = item.modifiers ?? [];
  let key = modifierKey(raw);
  if (!key) return null;
  key = modifierKey(MODIFIER_ALIASES[key] ?? key);

  for (const candidate of allowed) if (modifierKey(candidate) === key) return candidate;

  // "cheddar cheese" is the customer saying "cheddar" with a word to spare; "extra
  // onions" is not "onions", so a negation or an intensifier must not be swallowed.
  const spoken = new Set(key.split(" "));
  if (spoken.has("no") || spoken.has("extra")) return null;
  for (const candidate of allowed) {
    const tokens = modifierKey(candidate).split(" ");
    if (tokens.some((t) => t === "no" || t === "extra")) continue;
    if (tokens.every((t) => spoken.has(t))) return candidate;
  }
  return null;
}

/**
 * Modifiers the customer packed into the item name itself: "diet coke", "spicy chicken".
 *
 * Words belonging to the item's own name never count — a "Bacon Stack" is not a
 * burger with bacon added on top of it.
 */
export function modifiersInPhrase(item: MenuItem, spoken: string): string[] {
  const own = new Set(
    [item.name, ...item.aliases]
      .flatMap((n) => normalize(n).split(" "))
      .map(singularWord),
  );
  const said = new Set(normalize(spoken).split(" ").map(singularWord));
  const found: string[] = [];
  for (const candidate of item.modifiers ?? []) {
    const key = modifierKey(candidate);
    if (key.includes(" ") || own.has(key)) continue;
    if (said.has(key)) found.push(candidate);
  }
  return found;
}

/** Noises that keep a conversation going without asking for anything. */
const BACK_CHANNEL_WORDS = new Set([
  "uh",
  "huh",
  "uhhuh",
  "mhm",
  "mm",
  "hmm",
  "mmhmm",
  "yeah",
  "yep",
  "yes",
  "ok",
  "okay",
  "right",
  "sure",
  "aha",
  "gotcha",
]);

/** Words that mean yes. Anything else is not consent, however polite. */
const AFFIRMATIVE = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "alright",
  "fine",
  "please do",
  "go ahead",
  "add",
  "why not",
  "of course",
  "do it",
  "sounds good",
];

/** True when these words are an answer of yes rather than a change of subject. */
export function saysYes(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  const words = new Set(t.split(" "));
  return AFFIRMATIVE.some((a) => (a.includes(" ") ? t.includes(a) : words.has(a)));
}

/** How customers say the order is finished. */
const DONE = [
  "that's everything",
  "thats everything",
  "that's all",
  "thats all",
  "that's it",
  "thats it",
  "nothing else",
  "that'll be all",
  "that will be all",
  "that's the order",
  "eso es todo",
];

/** True when these words close the order: "that's everything", "nothing else". */
export function saysDone(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  return DONE.some((d) => t.includes(d));
}

/** True when the words an item was booked from are just the customer agreeing. */
export function isBackChannel(text: string): boolean {
  const parts = normalize(text).split(" ").filter(Boolean);
  if (!parts.length) return false;
  return parts.every((w) => BACK_CHANNEL_WORDS.has(w));
}

export function priceOf(item: MenuItem, size?: Size) {
  return +(item.price + (size ? SIZE_UPCHARGE[size] : 0)).toFixed(2);
}

/** Keyterms for both ears: menu names plus the words customers actually say. */
export function menuKeyterms(limit = 100): string[] {
  const terms = new Set<string>();
  for (const item of MENU) {
    terms.add(item.name);
    for (const a of item.aliases.slice(0, 2)) terms.add(a);
  }
  for (const combo of Object.values(COMBOS)) terms.add(combo.name);
  ["no pickles", "extra cheese", "add bacon", "large", "medium", "small", "combo", "meal"].forEach((t) =>
    terms.add(t),
  );
  return Array.from(terms).slice(0, limit);
}
