// One unique carrier plan = one canonical record: repeated appearances merge
// by exact identity (code, else exact name on the same network), conflicting
// appearances are flagged rather than silently resolved, every plan (EPO
// included) is stored and counted, and deterministic validation catches duplicates,
// missing rates, missing provenance, plan mixing and count drift.
import assert from "node:assert/strict";
import { canonicalizePlans, identityKey } from "../server/plan-canonical.js";
import { validatePlans } from "../server/plan-validate.js";

const rates = (EE, ES, EC, FAM) => ({ EE, ES, EC, FAM });
const pages = (identity = [], benefits = [], rates_ = []) => ({ identity, benefits, rates: rates_ });

// The example from the spec: one plan on pages 7, 18-19 and 37.
let c = canonicalizePlans([
  { name: "UHC Choice Plus 3000", plan_code: "ABC123", network: "Choice Plus", source_pages: pages([7]) },
  { name: "UHC Choice Plus 3000", plan_code: "ABC123", network: "Choice Plus", deductible: "$3,000", oop_max: "$6,000", benefits: { doctor_visit: "$30", rx: "$10/$40/$80" }, source_pages: pages([18], [18, 19]) },
  { name: "UHC Choice Plus 3000", plan_code: "abc123 ", network: "Choice Plus", rates: rates(612.45, 1290.1, 1150, 1850.2), source_pages: pages([37], [], [37]) },
]);
assert.equal(c.plans.length, 1, "three appearances, one plan");
let p = c.plans[0];
assert.equal(p.name, "UHC Choice Plus 3000");
assert.equal(p.plan_code, "ABC123", "the code as first printed, exactly");
assert.deepEqual(p.rates, rates(612.45, 1290.1, 1150, 1850.2));
assert.equal(p.deductible, "$3,000");
assert.equal(p.benefits.doctor_visit, "$30");
assert.deepEqual(p.source.identity, [7, 18, 37]);
assert.deepEqual(p.source.benefits, [18, 19]);
assert.deepEqual(p.source.rates, [37]);
assert.equal(p.source.appearances, 3);
assert.equal(p.conflicts, undefined);
assert.equal(c.reconciliation.appearances_read, 3);
assert.equal(c.reconciliation.unique_plans, 1);

// Pages reported as positions within an excerpt map back to original pages.
c = canonicalizePlans([{ name: "Plan X", plan_code: "X1", rates: rates(1, 2, 3, 4), source_pages: pages([1], [1], [2]), _pageMap: [12, 31] }]);
assert.deepEqual(c.plans[0].source.rates, [31]);
assert.deepEqual(c.plans[0].source.identity, [12]);

// A rate row that prints the name but no code joins the one coded plan with
// that exact name - and only when exactly one does.
c = canonicalizePlans([
  { name: "Choice Plus HSA 3000-80", plan_code: "P3000H", network: "Choice Plus", deductible: "$3,000", source_pages: pages([8], [18]) },
  { name: "Choice Plus HSA 3000-80", plan_code: null, network: "Choice Plus", rates: rates(500, 1000, 900, 1400), source_pages: pages([], [], [37]) },
]);
assert.equal(c.plans.length, 1);
assert.deepEqual(c.plans[0].source.rates, [37]);
assert.equal(c.plans[0].rates.EE, 500);
c = canonicalizePlans([
  { name: "Choice Plus 2000", plan_code: "A1", network: "Choice Plus" },
  { name: "Choice Plus 2000", plan_code: "B2", network: "Choice Plus" },
  { name: "Choice Plus 2000", plan_code: null, network: "Choice Plus", rates: rates(1, 2, 3, 4) },
]);
assert.equal(c.plans.length, 3, "two different codes are two plans, and an uncoded row that could be either is not guessed onto one");

// Similar names are never merged.
c = canonicalizePlans([
  { name: "Choice Plus 3000", plan_code: null, network: "Choice Plus", rates: rates(1, 2, 3, 4) },
  { name: "Choice Plus 3000 HSA", plan_code: null, network: "Choice Plus", rates: rates(1, 2, 3, 4) },
  { name: "Choice Plus 3000", plan_code: null, network: "Choice", rates: rates(1, 2, 3, 4) },
]);
assert.equal(c.plans.length, 3);

// Conflicting appearances: kept as one plan, the disagreement recorded, not resolved.
c = canonicalizePlans([
  { name: "Plan Y", plan_code: "Y1", rates: rates(100, 200, 300, 1842.17), source_pages: pages([10], [], [10]) },
  { name: "Plan Y", plan_code: "Y1", rates: rates(100, 200, 300, 1824.17), source_pages: pages([40], [], [40]) },
]);
assert.equal(c.plans.length, 1);
p = c.plans[0];
assert.equal(p.rates.FAM, 1842.17, "the first value is kept, not overwritten");
assert.equal(p.conflicts.length, 1);
assert.equal(p.conflicts[0].field, "FAM");
assert.deepEqual(p.conflicts[0].values.map((v) => v.value), [1842.17, 1824.17]);

// Every unique plan is stored - EPO included - and counted; what a client
// sees is decided separately (plan-visibility.js).
c = canonicalizePlans(
  [
    { name: "Choice Plus 1000", plan_code: "P1", network: "Choice Plus" },
    { name: "Choice Plus 1000", plan_code: "P1", network: "Choice Plus" },
    { name: "Core EPO 1000", plan_code: "E1", network: "Core EPO" },
    { name: "Choice Plus 2000", plan_code: "P2", network: "Choice Plus" },
  ],
  { reportedAppearances: 7, reportedUnique: 3, reportedEpo: 1 },
);
assert.deepEqual(c.plans.map((p) => p.plan_code), ["P1", "E1", "P2"], "the EPO plan is stored like any other");
assert.equal(c.excluded, undefined);
assert.deepEqual(
  { a: c.reconciliation.plan_appearances, u: c.reconciliation.unique_plans, ppo: c.reconciliation.unique_ppo, epo: c.reconciliation.unique_epo, exp: c.reconciliation.expected },
  { a: 7, u: 3, ppo: 2, epo: 1, exp: 3 },
);
const { clientPlans, hiddenReason } = await import("../server/plan-visibility.js");
assert.deepEqual(clientPlans(c.plans).map((p) => p.plan_code), ["P1", "P2"], "the client is shown the PPO plans");
assert.match(hiddenReason(c.plans[1]), /EPO/);
assert.notEqual(identityKey({ plan_code: "P1" }), identityKey({ name: "P1" }));

// --- Deterministic validation ------------------------------------------------
const good = (over = {}) => ({
  name: "Plan A",
  plan_code: "A1",
  network: "Choice Plus",
  deductible: "$1,000",
  oop_max: "$5,000",
  rates: rates(500, 1000, 900, 1400),
  option_id: "UH1",
  source: { identity: [3], benefits: [5], rates: [9], sheet: "", rows: "", appearances: 3, codes: ["A1"] },
  ...over,
});
const reading = (plans, extra = {}) => ({
  plans,
  excluded: [],
  reconciliation: { plan_appearances: plans.length * 3, unique_plans: plans.length, unique_ppo: plans.length, unique_epo: 0, excluded: 0, expected: plans.length, reader_unique_plans: plans.length },
  extraction: { sourceSha: "sha1" },
  ...extra,
});
const run = (x, over = {}) => validatePlans({ extracted: x, sourceSha: "sha1", ...over });
const failing = (v) => v.checks.filter((k) => !k.ok).map((k) => k.key);

let v = run(reading([good(), good({ name: "Plan B", plan_code: "B1", option_id: "UH2", source: { ...good().source, codes: ["B1"] } })]));
assert.equal(v.ok, true, JSON.stringify(v.failures));

assert.deepEqual(failing(run(reading([good()]), { sourceSha: "sha2" })), ["version"], "a reading of another version of the document");
assert.equal(run(reading([good()]), { sourceSha: "sha2" }).fix, "read");

v = run(reading([good(), good({ option_id: "UH2" })]));
assert.ok(failing(v).includes("unique"), "the same plan stored twice");
assert.ok(failing(v).includes("codes"));
assert.equal(v.fix, "correct");

v = run(reading([good(), good({ name: "Plan B", plan_code: "B1", option_id: "UH1", source: { ...good().source, codes: ["B1"] } })]));
assert.deepEqual(failing(v), ["ids"], "one BenSync ID on two plans");
assert.deepEqual(failing(run(reading([good()]), { groupOptionIds: ["UH1"] })), ["ids"], "an ID another proposal of the group holds");

assert.deepEqual(failing(run(reading([good({ rates: rates(500, null, 900, 1400) })]))), ["rates"]);
assert.equal(run(reading([good({ rates: rates(500, null, 900, 1400), unpriced: ["ES"] })])).ok, true, "a tier the carrier does not price, confirmed");
assert.deepEqual(failing(run(reading([good({ rates: rates(500, "n/a", 900, 1400) })]))), ["rates"]);
assert.deepEqual(failing(run(reading([good({ deductible: null })]))), ["fields"]);

assert.deepEqual(failing(run(reading([good({ source: undefined })]))), ["provenance"]);
assert.equal(run(reading([good({ source: undefined })])).fix, "read", "a reading with no provenance is extracted again");
assert.deepEqual(failing(run(reading([good({ source: { identity: [], benefits: [], rates: [], sheet: "PPO", rows: "row 9", codes: [] } })]), { textSource: true })), [], "a workbook's sheet and row are its provenance");

v = run(reading([good({ source: { ...good().source, codes: ["A1", "B7"] } })]));
assert.deepEqual(failing(v), ["pairing"], "benefits or rates carried in from another plan code");
v = run(reading([good({ conflicts: [{ field: "FAM", values: [{ value: 1842.17, pages: [10] }, { value: 1824.17, pages: [40] }] }] })]));
assert.deepEqual(failing(v), ["pairing"], "an unresolved conflicting appearance");
assert.match(v.failures[0], /1842\.17 p10 vs 1824\.17 p40/);

const drift = reading([good()]);
drift.reconciliation = { ...drift.reconciliation, expected: 2 };
assert.deepEqual(failing(run(drift)), ["reconciliation"], "expected count is not what is stored");
const epoMiscount = reading([good(), good({ name: "Plan A EPO", plan_code: "A1E", network: "Core EPO", option_id: "UH2", source: { ...good().source, codes: ["A1E"] } })]);
assert.deepEqual(failing(run(epoMiscount)), ["reconciliation"], "an EPO plan stored but not counted");
const readerCount = reading([good()]);
readerCount.reconciliation = { ...readerCount.reconciliation, reader_unique_plans: 3 };
assert.deepEqual(failing(run(readerCount)), ["reconciliation"], "the reader saw more plans than were stored");
assert.equal(run({ ...reading([good()]), reconciliation: undefined }).fix, "read");

// --- Unique name / unique code standard ---------------------------------------
// A plan printed on page 4 (summary), 12 (benefits) and 31 (rates) is ONE
// canonical plan with provenance from all three - never three plans.
c = canonicalizePlans([
  { name: "Choice Plus 2500", plan_code: "P2500", network: "Choice Plus", source_pages: pages([4]) },
  { name: "Choice Plus 2500", plan_code: "P2500", network: "Choice Plus", deductible: "$2,500", oop_max: "$6,000", source_pages: pages([12], [12]) },
  { name: "Choice Plus 2500", plan_code: "P2500", network: "Choice Plus", rates: rates(500, 1000, 900, 1400), source_pages: pages([31], [], [31]) },
]);
assert.equal(c.plans.length, 1);
assert.deepEqual([c.plans[0].source.identity, c.plans[0].source.benefits, c.plans[0].source.rates], [[4, 12, 31], [12], [31]]);
const second = good({ name: "Plan B", plan_code: "B1", option_id: "UH2", source: { ...good().source, codes: ["B1"] } });
// Two plans with the same rates are two plans: nothing collapses them.
v = run(reading([good(), { ...second, rates: good().rates }]));
assert.equal(v.ok, true, "identical rates never make two carrier plans one");
const { offeredCount } = await import("../server/proposal-audit.js");
assert.equal(offeredCount(reading([good(), { ...second, rates: good().rates }])), 2, "the stored count is the canonical list's length");
// A duplicate carrier plan code fails.
v = run(reading([good(), { ...second, plan_code: "A1", source: { ...second.source, codes: ["A1"] } }]));
assert.ok(failing(v).includes("codes"));
assert.equal(v.fix, "correct");
// The same exact name with nothing printed to tell them apart: settled against the source.
v = run(reading([good({ plan_code: null, source: { ...good().source, codes: [] } }), { ...second, name: "Plan A", plan_code: null, network: "Choice", source: { ...second.source, codes: [] } }]));
assert.deepEqual(failing(v), ["names"]);
assert.equal(v.fix, "correct");
// The same exact name on two DIFFERENT plan codes: never merged, never shown
// twice silently - flagged for a person.
const shared = reading([good(), { ...second, name: "plan  a" }]);
v = run(shared);
assert.deepEqual(failing(v), ["names"]);
assert.equal(v.fix, "review", "a person confirms whether the carrier uses one name for two plans");
assert.match(v.failures[0], /"Plan A" is on 2 different plan codes \(A1, B1\)/);
// Once a person confirms exactly those codes share the name, it passes; a
// change to the codes flags it again.
assert.equal(run({ ...shared, shared_names_confirmed: [{ name: "Plan A", codes: ["A1", "B1"], by: "hunter@kennion.com" }] }).ok, true);
assert.deepEqual(failing(run({ ...shared, shared_names_confirmed: [{ name: "Plan A", codes: ["A1", "B9"] }] })), ["names"]);

// A correction keeps the reconciliation on the canonical list (EPO counted
// once, the document's count taken as it is), and an "added" plan that is
// already stored under the same identity is not added twice.
const { applyCorrection } = await import("../server/proposal-audit.js");
const epoReading = {
  plans: [good(), good({ name: "Plan A EPO", plan_code: "A1E", network: "Core EPO", option_id: "UH2", source: { ...good().source, codes: ["A1E"] } })],
  reconciliation: { plan_appearances: 6, unique_plans: 2, unique_ppo: 1, unique_epo: 1, expected: 2, reader_unique_plans: 2 },
  extraction: { sourceSha: "sha1" },
};
const corrected = applyCorrection(epoReading, { document_plan_count: 3, fixes: [], remove: [], unpriced: [], add: [
  { name: "Plan A", plan_code: "a1", rates: rates(1, 2, 3, 4) },
  { name: "Plan C", plan_code: "C1", network: "Choice Plus", deductible: "$1", oop_max: "$2", rates: rates(1, 2, 3, 4), source_pages: pages([5], [5], [5]) },
] });
assert.deepEqual(corrected.extracted.plans.map((p) => p.plan_code), ["A1", "A1E", "C1"], "A1 is already stored (same code, case aside); C1 is new");
assert.deepEqual(
  { u: corrected.extracted.reconciliation.unique_plans, ppo: corrected.extracted.reconciliation.unique_ppo, epo: corrected.extracted.reconciliation.unique_epo, exp: corrected.extracted.reconciliation.expected, reader: corrected.extracted.reconciliation.reader_unique_plans },
  { u: 3, ppo: 2, epo: 1, exp: 3, reader: 3 },
  "the document's count is not inflated by the EPO plans it already includes",
);

console.log("plan canonical: one plan per carrier identity, appearances merged with provenance, conflicts flagged not resolved, every plan stored (EPO included) with visibility decided separately, deterministic validation, unique names and codes enforced - ok");
