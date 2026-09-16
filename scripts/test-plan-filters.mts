// The Medical Plans filters and sort, as data: OR within a category, AND
// between them, the option counts each dropdown shows, chips and their
// removal, clear all, the bill range's validation, and the Sort by labels.
// Runs with `node scripts/test-plan-filters.mts`.
import assert from "node:assert/strict";
import {
  DED_BANDS,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  OOP_BANDS,
  SORT_CHOICES,
  bandsWithData,
  billError,
  billLabel,
  categoryCount,
  filterChips,
  filterCount,
  filtersEmpty,
  matches,
  optionCounts,
  parseDollars,
  parseSortValue,
  sortLabel,
  sortValue,
  toggleIn,
  withBill,
  type PlanFacets,
  type PlanFilters,
} from "../client/src/lib/planfilters.ts";

const plan = (carrier: string, network: string, funding: string, ded: number | null, oop: number | null, bill: number | null): PlanFacets => ({ carrier, network, funding, ded, oop, bill });
const plans: PlanFacets[] = [
  plan("UnitedHealthcare", "PPO", "Fully Insured", 1000, 5000, 31000),
  plan("UnitedHealthcare", "PPO", "Level Funded", 2500, 6000, 29000),
  plan("Gravie", "PPO", "Level Funded", 3500, 7000, 36000),
  plan("Gravie", "EPO", "Level Funded", 0, 3000, 40000),
  plan("Cobalt", "RBP", "Level Funded", 6000, 8500, 25000),
  plan("Nationwide", "PPO", "Level Funded", null, null, null),
];
const showing = (f: PlanFilters) => plans.filter((x) => matches(x, f));

// 1. Nothing applied shows everything.
assert.equal(showing(EMPTY_FILTERS).length, 6);
assert.ok(filtersEmpty(EMPTY_FILTERS));

// 2. OR within a category: two carriers show both carriers' plans.
let f = toggleIn(toggleIn(EMPTY_FILTERS, "carriers", "Gravie"), "carriers", "Cobalt");
assert.deepEqual(showing(f).map((x) => x.carrier), ["Gravie", "Gravie", "Cobalt"]);
assert.equal(categoryCount(f, "carriers"), 2);

// 3. AND between categories: Gravie or Cobalt, and PPO, is one plan.
f = toggleIn(f, "networks", "PPO");
assert.equal(showing(f).length, 1);
assert.equal(showing(f)[0].ded, 3500);
assert.equal(filterCount(f), 3);

// 4. Toggling a selection again removes it.
f = toggleIn(f, "carriers", "Cobalt");
assert.deepEqual(f.carriers, ["Gravie"]);

// 5. Deductible and OOP bands are inclusive at both ends and non-overlapping.
const dedBand = (v: number) => DED_BANDS.filter((b) => v >= b.min && (b.max == null || v <= b.max)).map((b) => b.id);
assert.deepEqual(dedBand(0), ["0"]);
assert.deepEqual(dedBand(1000), ["1-1000"]);
assert.deepEqual(dedBand(1001), ["1001-2500"]);
assert.deepEqual(dedBand(5000), ["2501-5000"]);
assert.deepEqual(dedBand(5001), ["5001-"]);
assert.deepEqual(dedBand(99999), ["5001-"]);
const oopBand = (v: number) => OOP_BANDS.filter((b) => v >= b.min && (b.max == null || v <= b.max)).map((b) => b.id);
assert.deepEqual(oopBand(3000), ["0-3000"]);
assert.deepEqual(oopBand(3001), ["3001-6000"]);
assert.deepEqual(oopBand(8001), ["8001-"]);
// Every whole-dollar value from 0 to 20,000 falls in exactly one band of each set.
for (let v = 0; v <= 20000; v++) {
  assert.equal(dedBand(v).length, 1, `deductible ${v}`);
  assert.equal(oopBand(v).length, 1, `oop ${v}`);
}

// 6. Only bands with a plan behind them are offered, in order.
assert.deepEqual(bandsWithData(DED_BANDS, plans.map((x) => x.ded)).map((b) => b.id), ["0", "1-1000", "1001-2500", "2501-5000", "5001-"]);
assert.deepEqual(bandsWithData(OOP_BANDS, [5000, 5500, null]).map((b) => b.id), ["3001-6000"]);

// 7. A deductible band filter: a plan with no deductible on record never matches it.
f = toggleIn(EMPTY_FILTERS, "deds", "0");
assert.deepEqual(showing(f).map((x) => x.carrier), ["Gravie"]);
f = toggleIn(f, "deds", "5001-");
assert.equal(showing(f).length, 2);

// 8. The bill range: either end alone, both together, and unpriced plans left out.
assert.equal(showing(withBill(EMPTY_FILTERS, { min: 30000, max: null })).length, 3);
assert.equal(showing(withBill(EMPTY_FILTERS, { min: null, max: 30000 })).length, 2);
assert.equal(showing(withBill(EMPTY_FILTERS, { min: 29000, max: 31000 })).length, 2);
assert.equal(showing(withBill(EMPTY_FILTERS, { min: 31000, max: 31000 })).length, 1);
assert.equal(billError({ min: 40000, max: 30000 }), "Minimum must not exceed maximum.");
assert.equal(billError({ min: 30000, max: 30000 }), null);
assert.equal(billError({ min: null, max: null }), null);
assert.equal(parseDollars("$31,275"), 31275);
assert.equal(parseDollars("31275.60"), 31276);
assert.equal(parseDollars(""), null);
assert.equal(parseDollars("abc"), null);
assert.equal(billLabel({ min: 30000, max: 40000 }), "$30,000 – $40,000");
assert.equal(billLabel({ min: 30000, max: null }), "at least $30,000");
assert.equal(billLabel({ min: null, max: 40000 }), "up to $40,000");

// 9. Option counts: what choosing each option would show given the other
//    categories, ignoring the category's own selections; every option is
//    listed, zero included, so the list keeps its shape.
f = toggleIn(EMPTY_FILTERS, "networks", "EPO");
let counts = optionCounts(plans, f, "carriers", ["UnitedHealthcare", "Gravie", "Cobalt", "Nationwide"]);
assert.deepEqual(counts, { UnitedHealthcare: 0, Gravie: 1, Cobalt: 0, Nationwide: 0 });
counts = optionCounts(plans, f, "networks", ["PPO", "EPO", "RBP"]);
assert.deepEqual(counts, { PPO: 4, EPO: 1, RBP: 1 }, "a category's own selections do not shrink its counts");
counts = optionCounts(plans, toggleIn(EMPTY_FILTERS, "carriers", "Gravie"), "deds", DED_BANDS.map((b) => b.id));
assert.deepEqual(counts, { "0": 1, "1-1000": 0, "1001-2500": 0, "2501-5000": 1, "5001-": 0 });

// 10. Chips: one per selection, labelled by category, each removing only itself.
f = toggleIn(toggleIn(toggleIn(EMPTY_FILTERS, "carriers", "Gravie"), "deds", "2501-5000"), "fundings", "Level Funded");
f = withBill(f, { min: 30000, max: null });
const chips = filterChips(f);
assert.deepEqual(
  chips.map((c) => c.label),
  ["Carrier/TPA: Gravie", "Funding: Level Funded", "Deductible: $2,501 – $5,000", "Monthly bill: at least $30,000"],
);
const without = chips[2].remove(f);
assert.deepEqual(without.deds, []);
assert.deepEqual(without.carriers, ["Gravie"]);
assert.equal(without.bill.min, 30000);
const noBill = chips[3].remove(f);
assert.deepEqual(noBill.bill, { min: null, max: null });
assert.equal(filterCount(noBill), 3);
assert.equal(filterChips(EMPTY_FILTERS).length, 0);

// 11. Clear all is the empty set — the sort is separate state and untouched by it.
assert.ok(filtersEmpty(EMPTY_FILTERS));
assert.deepEqual(DEFAULT_SORT, { key: "total", dir: 1 });

// 12. Sort by: plain labels, both ways for the three dollar columns; header
//     sorts outside the list still get a label, and values round-trip.
assert.deepEqual(
  SORT_CHOICES.map(sortLabel),
  ["Monthly bill: Low to high", "Monthly bill: High to low", "Deductible: Low to high", "Deductible: High to low", "OOP max: Low to high", "OOP max: High to low"],
);
assert.equal(sortLabel({ key: "carrier", dir: 1 }), "Carrier/TPA: A to Z");
assert.equal(sortLabel({ key: "plan", dir: -1 }), "Plan: Z to A");
assert.equal(sortLabel({ key: "er", dir: -1 }), "Your company pays: High to low");
for (const c of SORT_CHOICES) assert.deepEqual(parseSortValue(sortValue(c)), c);
assert.equal(parseSortValue("nope:asc"), null);
assert.equal(parseSortValue("total:sideways"), null);

console.log("plan filters: all assertions passed");
