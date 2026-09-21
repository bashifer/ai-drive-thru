import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExpectedLine } from "../src/lib/scoring";

/**
 * Amazon's FoodOrdering dataset as a source of real order phrasing.
 *
 * Each case is a human utterance (`SRC`) plus a machine-executable representation
 * (`EXR`) of the order it should produce — which is exactly the ground truth this
 * project needs, minus the audio. Their burger venue is not our menu, so items are
 * mapped where they correspond and the rest is reported as uncovered rather than
 * quietly dropped.
 *
 * The data is CC BY-NC 4.0: this file downloads it on demand into bench/data/,
 * which is gitignored. Nothing from the dataset is committed or relicensed.
 */

const SOURCE =
  "https://raw.githubusercontent.com/amazon-science/food-ordering-semantic-parsing-dataset/main/data/burger/dev.json";
const LOCAL = resolve(process.cwd(), "bench/data/burger-dev.json");

export type FoodOrderingCase = { SRC: string; EXR: string };

export async function loadCases(): Promise<FoodOrderingCase[]> {
  if (!existsSync(LOCAL)) {
    mkdirSync(resolve(process.cwd(), "bench/data"), { recursive: true });
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`Could not fetch FoodOrdering dev set: ${res.status}`);
    writeFileSync(LOCAL, await res.text());
  }
  return readFileSync(LOCAL, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FoodOrderingCase);
}

/** Their venue's dishes, in our menu's terms. */
const ITEM_MAP: Record<string, { item: string; modifiers?: string[] }> = {
  cheese_burger: { item: "Lab Burger" },
  ham_burger: { item: "Lab Burger", modifiers: ["no cheese"] },
  double_cheese_burger: { item: "Double Lab Burger" },
  chicken_sandwich: { item: "Crispy Chicken Sandwich" },
  vegan_burger: { item: "Veggie Lab" },
  salad: { item: "Side Salad" },
  french_fries: { item: "Fries" },
  coca_cola: { item: "Cola" },
  diet_coke: { item: "Cola", modifiers: ["diet"] },
  seven_up: { item: "Lemon-Lime Soda" },
  iced_tea: { item: "Iced Tea" },
  coffee: { item: "Coffee" },
  chocolate_shake: { item: "Milkshake", modifiers: ["chocolate"] },
  vanilla_shake: { item: "Milkshake", modifiers: ["vanilla"] },
  strawberry_shake: { item: "Milkshake", modifiers: ["strawberry"] },
  curly_fries: { item: "Curly Fries" },
  garlic_fries: { item: "Garlic Fries" },
  sweet_potato_fries: { item: "Sweet Potato Fries" },
  apple_slices: { item: "Apple Slices" },
  baby_carrots: { item: "Baby Carrots" },
  root_beer: { item: "Root Beer" },
  dr_pepper: { item: "Dr Pepper" },
  pink_lemonade: { item: "Pink Lemonade" },
  zero_sugar_lemonade: { item: "Pink Lemonade", modifiers: ["zero sugar"] },
  milk: { item: "Milk" },
};

/** Toppings asked for, in our modifier vocabulary. */
const TOPPING: Record<string, string> = {
  lettuce: "lettuce",
  tomato: "tomato",
  onion: "onions",
  pickle: "pickles",
  ketchup: "ketchup",
  mustard: "mustard",
  mayonnaise: "mayo",
  bacon: "bacon",
  cheddar: "cheddar",
  jalapenos: "jalapenos",
  blue_cheese: "blue cheese",
};

/** Their toppings, in our modifier vocabulary. Positive toppings we cannot express are dropped. */
const NEGATED_TOPPING: Record<string, string> = Object.fromEntries(
  Object.entries(TOPPING).map(([k, v]) => [k, `no ${v}`]),
);

const SIZE_MAP: Record<string, string> = { small: "small", medium: "medium", large: "large" };

type Node = { tag: string; children: Node[]; value?: string };

/** The EXR is a small s-expression; this is the whole parser. */
export function parseExr(exr: string): Node[] {
  const tokens = exr.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  const roots: Node[] = [];
  const stack: Node[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "(") {
      const node: Node = { tag: tokens[++i] ?? "", children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
    } else if (token === ")") {
      stack.pop();
    } else {
      const node = stack[stack.length - 1];
      if (node) node.value = node.value ? `${node.value}_${token}` : token;
    }
  }
  return roots;
}

export type Mapped = {
  src: string;
  expected: ExpectedLine[];
  /** Slot values this venue has and Burger Lab does not. */
  uncovered: string[];
};

const findAll = (node: Node, tag: string) => node.children.filter((c) => c.tag === tag);
const findOne = (node: Node, tag: string) => findAll(node, tag)[0]?.value;

export function mapCase(c: FoodOrderingCase): Mapped {
  const uncovered: string[] = [];
  const expected: ExpectedLine[] = [];

  for (const order of parseExr(c.EXR)) {
    if (!order.tag.endsWith("_ORDER")) continue;

    const typeSlot =
      findOne(order, "MAIN_DISH_TYPE") ?? findOne(order, "SIDE_TYPE") ?? findOne(order, "DRINK_TYPE");
    if (!typeSlot) continue;

    const mapping = ITEM_MAP[typeSlot];
    if (!mapping) {
      uncovered.push(typeSlot);
      continue;
    }

    const qty = Number(findOne(order, "NUMBER") ?? 1) || 1;
    const rawSize = findOne(order, "SIZE");
    const size = rawSize ? SIZE_MAP[rawSize] : undefined;
    if (rawSize && !size) uncovered.push(`size:${rawSize}`);

    const modifiers = [...(mapping.modifiers ?? [])];

    for (const topping of findAll(order, "TOPPING")) {
      const mapped = topping.value ? TOPPING[topping.value] : undefined;
      if (mapped) modifiers.push(mapped);
      else if (topping.value) uncovered.push(`topping:${topping.value}`);
    }

    for (const not of findAll(order, "NOT")) {
      for (const topping of findAll(not, "TOPPING")) {
        const mapped = topping.value ? NEGATED_TOPPING[topping.value] : undefined;
        if (mapped) modifiers.push(mapped);
        else if (topping.value) uncovered.push(`no:${topping.value}`);
      }
    }

    expected.push({
      item: mapping.item,
      qty,
      ...(size ? { size } : {}),
      ...(modifiers.length ? { modifiers } : {}),
    });
  }

  return { src: c.SRC, expected, uncovered };
}

/** Cases whose every slot survives the mapping — the ones worth scoring. */
export function coverage(cases: FoodOrderingCase[]) {
  const mapped = cases.map(mapCase);
  const clean = mapped.filter((m) => m.uncovered.length === 0 && m.expected.length > 0);
  const missing = new Map<string, number>();
  for (const m of mapped) for (const u of m.uncovered) missing.set(u, (missing.get(u) ?? 0) + 1);
  return { mapped, clean, missing: [...missing.entries()].sort((a, b) => b[1] - a[1]) };
}
