// One unique carrier plan = one canonical record: repeated appearances merge
// by exact identity (code, else exact name on the same network), conflicting
// appearances are flagged rather than silently resolved, EPO plans are
// counted and excluded, and deterministic validation catches duplicates,
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

// EPO plans are counted and excluded, never silently dropped.
c = canonicalizePlans(
  [
    { name: "Choice Plus 1000", plan_code: "P1", network: "Choice Plus" },
    { name: "Choice Plus 1000", plan_code: "P1", network: "Choice Plus" },
    { name: "Core EPO 1000", plan_code: "E1", network: "Core EPO" },
    { name: "Choice Plus 2000", plan_code: "P2", network: "Choice Plus" },
  ],
  { reportedAppearances: 7, reportedUnique: 3, reportedEpo: 1 },
);
assert.equal(c.plans.length, 2);
assert.equal(c.excluded.length, 1);
assert.match(c.excluded[0].reason, /EPO/);
assert.deepEqual(
  { a: c.reconciliation.plan_appearances, u: c.reconciliation.unique_plans, ppo: c.reconciliation.unique_ppo, epo: c.reconciliation.unique_epo, exp: c.reconciliation.expected },
  { a: 7, u: 3, ppo: 2, epo: 1, exp: 2 },
);
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
const readerCount = reading([good()]);
readerCount.reconciliation = { ...readerCount.reconciliation, reader_unique_plans: 3 };
assert.deepEqual(failing(run(readerCount)), ["reconciliation"], "the reader saw more plans than were stored");
assert.equal(run({ ...reading([good()]), reconciliation: undefined }).fix, "read");

console.log("plan canonical: one plan per carrier identity, appearances merged with provenance, conflicts flagged not resolved, EPO counted and excluded, deterministic validation - ok");
