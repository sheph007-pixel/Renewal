// "Your Market Results": the summary box on the Medical Plans page, computed
// from every quoted plan by a fixed template. Each scenario the box has to
// handle: network-only plans, mixed network and RBP, RBP only, a single
// partner, and incomplete rate data. Runs with `node scripts/test-market-results.mts`.
import assert from "node:assert/strict";
import { marketResults, marketResultsSentences, marketResultsText, type MarketPlan } from "../client/src/lib/model.ts";

const rates = (EE: number | null, mult = 2) => ({ EE, ES: EE == null ? null : EE * mult, EC: EE == null ? null : EE * 1.8, FAM: EE == null ? null : EE * 3 });
const plan = (carrier: string, name: string, network: string, EE: number | null, extra: Partial<MarketPlan> = {}): MarketPlan => ({
  carrier,
  label: "Level Funded",
  plan: name,
  type: "PPO",
  ded: 1000,
  oop: 5000,
  copays: "—",
  rx: "—",
  network,
  rates: rates(EE),
  monthly: 1000,
  indicative: false,
  ...extra,
});

// 1. Network-only plans, three partners, one wins price and another wins selection.
const networkOnly = [
  plan("UnitedHealthcare", "P4000", "United Choice Plus", 700),
  plan("UnitedHealthcare", "P3500", "United Choice Plus", 720),
  plan("UnitedHealthcare", "P6000", "United Choice Plus", 650),
  plan("Gravie", "Copay 1500", "Cigna", 600),
  plan("Gravie", "Copay 2500", "Cigna", 560),
  plan("Angle Health", "Trad 500", "Cigna", 610.4),
];
let r = marketResults(networkOnly)!;
assert.equal(r.totalPlans, 6);
assert.deepEqual(r.partners.map((p) => [p.name, p.plans]), [["UnitedHealthcare", 3], ["Gravie", 2], ["Angle Health", 1]]);
assert.equal(r.partners[1].avgEmployeeOnlyCost, 290, "(600 + 560) / 2 × 0.5");
assert.deepEqual(r.lowestCost.map((p) => p.name), ["Gravie"]);
assert.deepEqual(r.widest.map((p) => p.name), ["UnitedHealthcare"]);
assert.deepEqual(r.networks, ["Cigna", "United Choice Plus"], "networks, not RBP, alphabetical, distinct");
assert.deepEqual(r.rbp, []);
let text = marketResultsText(r);
assert.deepEqual(text, [
  "Kennion took your group to market and received 6 plan options from UnitedHealthcare (3 plans), Gravie (2 plans) and Angle Health (1 plan).",
  "Gravie offered the lowest average employee-only cost at $290/month, assuming a 50% employer contribution.",
  "UnitedHealthcare offered the widest selection with 3 plans, with available network options including Cigna and United Choice Plus.",
]);
// Values are marked for the page; fixed wording is not.
const marked = marketResultsSentences(r)[0].filter((x) => x.value).map((x) => x.text);
assert.deepEqual(marked, ["6 plan options", "UnitedHealthcare", "3 plans", "Gravie", "2 plans", "Angle Health", "1 plan"]);

// 2. Mixed: a partner with network plans and an RBP partner; RBP counts toward totals and partners but never the network list.
const mixed = [
  ...networkOnly,
  plan("Cobalt", "Cobalt RBP 2000", "Reference-Based Pricing", 500, { type: "RBP" }),
  plan("Cobalt", "Cobalt RBP 4000", "RBP", 450, { type: "RBP" }),
];
r = marketResults(mixed)!;
assert.equal(r.totalPlans, 8);
assert.deepEqual(r.lowestCost.map((p) => p.name), ["Cobalt"], "RBP plans compete on price like any other");
assert.deepEqual(r.networks, ["Cigna", "United Choice Plus"], "RBP is a pricing approach, not a network");
assert.deepEqual(r.rbp, [{ name: "Cobalt", plans: 2 }]);
text = marketResultsText(r);
assert.equal(text[0], "Kennion took your group to market and received 8 plan options from UnitedHealthcare (3 plans), Gravie (2 plans), Angle Health (1 plan) and Cobalt (2 plans).");
assert.equal(text[1], "Cobalt offered the lowest average employee-only cost at $238/month, assuming a 50% employer contribution.");
assert.equal(text[2], "UnitedHealthcare offered the widest selection with 3 plans, with available network options including Cigna and United Choice Plus.");
assert.equal(text[3], "We also included Cobalt, offering 2 reference-based pricing plans, as an alternative to traditional network-based coverage.");

// Two RBP partners: one sentence naming each with its count.
r = marketResults([...mixed, plan("Nationwide", "NW RBP", "Reference Based Pricing", 480)])!;
assert.deepEqual(r.rbp, [{ name: "Cobalt", plans: 2 }, { name: "Nationwide", plans: 1 }]);
assert.equal(marketResultsText(r).at(-1), "We also included Cobalt, offering 2 reference-based pricing plans and Nationwide, offering 1 reference-based pricing plan, as an alternative to traditional network-based coverage.");

// 3. RBP only: no network clause at all, and no empty list.
r = marketResults([plan("Cobalt", "Cobalt RBP 2000", "RBP", 500, { type: "RBP" }), plan("Cobalt", "Cobalt RBP 4000", "RBP", 450, { type: "RBP" })])!;
assert.deepEqual(r.networks, []);
text = marketResultsText(r);
assert.deepEqual(text, [
  "Kennion took your group to market and received 2 plan options from Cobalt (2 plans).",
  "Cobalt's 2 plans average $238/month for employee-only coverage, assuming a 50% employer contribution.",
  "We also included Cobalt, offering 2 reference-based pricing plans, as an alternative to traditional network-based coverage.",
]);
assert.ok(!text.join(" ").includes("including"), "no network list when there is no network");

// 4. A single partner: its average and count, no superlatives.
r = marketResults(networkOnly.filter((p) => p.carrier === "UnitedHealthcare"))!;
text = marketResultsText(r);
assert.deepEqual(text, [
  "Kennion took your group to market and received 3 plan options from UnitedHealthcare (3 plans).",
  "UnitedHealthcare's 3 plans average $345/month for employee-only coverage, assuming a 50% employer contribution, with available network options including United Choice Plus.",
]);
assert.ok(!text.join(" ").match(/lowest|widest/), "one partner: no competition");

// 5. Incomplete rates: a partner missing an employee-only rate voids the price claim; selection and networks still stand.
r = marketResults([...networkOnly, plan("Angle Health", "Trad 1500", "Cigna", null)])!;
assert.equal(r.partners.find((p) => p.name === "Angle Health")!.avgEmployeeOnlyCost, null, "a missing rate is not zero");
assert.deepEqual(r.lowestCost, []);
text = marketResultsText(r);
assert.deepEqual(text, [
  "Kennion took your group to market and received 7 plan options from UnitedHealthcare (3 plans), Gravie (2 plans) and Angle Health (2 plans).",
  "UnitedHealthcare offered the widest selection with 3 plans, with available network options including Cigna and United Choice Plus.",
]);

// UnitedHealthcare quotes both fundings: both count as its plans, and the sentence says so.
r = marketResults([plan("UnitedHealthcare", "FI 1", "United Choice Plus", 700, { label: "Fully Insured" }), plan("UnitedHealthcare", "LF 1", "United Choice Plus", 650), plan("UnitedHealthcare", "LF 2", "United Choice Plus", 640), plan("Gravie", "G1", "Cigna", 600)])!;
assert.deepEqual(r.partners.map((p) => [p.name, p.plans, p.fundings]), [["UnitedHealthcare", 3, ["Fully Insured", "Level Funded"]], ["Gravie", 1, ["Level Funded"]]]);
assert.equal(marketResultsText(r)[0], "Kennion took your group to market and received 4 plan options from UnitedHealthcare (3 plans, fully insured and level funded) and Gravie (1 plan).");

// One partner wins both price and selection: one combined sentence.
r = marketResults([plan("Gravie", "A", "Cigna", 500), plan("Gravie", "B", "Cigna", 520), plan("UnitedHealthcare", "C", "United Choice Plus", 700)])!;
assert.equal(marketResultsText(r)[1], "Gravie offered both the lowest average employee-only cost at $255/month, assuming a 50% employer contribution, and the widest selection with 2 plans, with available network options including Cigna and United Choice Plus.");

// Ties: no sole winner invented.
r = marketResults([plan("Gravie", "A", "Cigna", 500), plan("UnitedHealthcare", "C", "United Choice Plus", 500)])!;
text = marketResultsText(r);
assert.equal(text[1], "Gravie and UnitedHealthcare tied for the lowest average employee-only cost at $250/month, assuming a 50% employer contribution.");
assert.equal(text[2], "Each partner offered 1 plan, with available network options including Cigna and United Choice Plus.");
r = marketResults([plan("Gravie", "A", "Cigna", 500), plan("Gravie", "B", "Cigna", 500), plan("UnitedHealthcare", "C", "United Choice Plus", 600), plan("UnitedHealthcare", "D", "United Choice Plus", 600), plan("Angle Health", "E", "Cigna", 700)])!;
assert.equal(marketResultsText(r)[2], "Gravie and UnitedHealthcare each offered the widest selection with 2 plans, with available network options including Cigna and United Choice Plus.");

// Rankings before rounding: $300.4 beats $300.6 though both print as $300.
r = marketResults([plan("Gravie", "A", "Cigna", 600.8), plan("UnitedHealthcare", "C", "United Choice Plus", 601.2)])!;
assert.deepEqual(r.lowestCost.map((p) => p.name), ["Gravie"]);
assert.match(marketResultsText(r)[1], /^Gravie offered the lowest average employee-only cost at \$300\/month/);

// A Surest row is UnitedHealthcare's (its carrier already reads so); a placeholder network is not a network.
r = marketResults([plan("UnitedHealthcare", "Surest Copay", "United Choice Plus", 640), plan("Nationwide", "NW 3000", "On the proposal", 590)])!;
assert.deepEqual(r.partners.map((p) => p.name), ["UnitedHealthcare", "Nationwide"]);
assert.deepEqual(r.networks, ["United Choice Plus"]);

// Nothing quoted: nothing to say.
assert.equal(marketResults([]), null);
assert.deepEqual(marketResultsText(null), []);

console.log("market results: all assertions passed");
