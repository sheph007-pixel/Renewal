// Every structured-output schema sent to Anthropic stays within its limit of
// 16 union-typed (nullable / anyOf) parameters - past it the API refuses the
// request with a 400 before reading anything, which is how every Claude
// audit failed ("18 parameters with type arrays or anyOf ... limit: 16").
// Also: an auditor's empty string reads as "not stated", never a value.
import assert from "node:assert/strict";
import { AUDIT_SCHEMAS, SCHEMA_UNION_LIMIT, unionParams, shape } from "../server/proposal-audit.js";
import { STRUCTURED_SCHEMAS } from "../server/ai.js";

const all = { ...AUDIT_SCHEMAS(), ...STRUCTURED_SCHEMAS() };
for (const [name, schema] of Object.entries(all)) {
  const n = unionParams(schema);
  assert.ok(n <= SCHEMA_UNION_LIMIT, `${name} schema has ${n} union-typed parameters (limit ${SCHEMA_UNION_LIMIT})`);
}
assert.equal(unionParams({ properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] }, b: { type: ["string", "null"] }, c: { type: "string" } } }), 2);

// Empty strings from the auditor are "not stated": a stored plan with no
// specialist copay agrees with an auditor that reads none.
const stored = [{ id: "UH1", name: "P100", plan_code: null, network: null, deductible: "$100", oop_max: "$4,000", benefits: { doctor_visit: "$20", specialist: null }, rates: { EE: 1, ES: 2, EC: 3, FAM: 4 } }];
const blank = Object.fromEntries(["network", "specialist", "imaging", "urgent_care", "emergency_room", "hospital", "rx", "coinsurance", "hsa_eligible"].map((k) => [k, ""]));
const r = shape("Claude (test)", { verdict: "pass", plan_appearances: 1, plans_found_total: 1, epo_excluded: 0, document_plan_count: 1, duplicates_found: false, mismatches: [], notes: "", plan_confirmations: [{ index: 0, on_document: true, name: "P100", plan_code: "", deductible: "$100", oop_max: "$4,000", doctor_visit: "$20", benefits_belong: true, EE: 1, ES: 2, EC: 3, FAM: 4, ...blank }] }, stored);
assert.equal(r.verdict, "pass", JSON.stringify(r.mismatches));
// ...and a value the auditor does read still has to match.
const r2 = shape("Claude (test)", { verdict: "pass", plan_appearances: 1, plans_found_total: 1, epo_excluded: 0, document_plan_count: 1, duplicates_found: false, mismatches: [], notes: "", plan_confirmations: [{ index: 0, on_document: true, name: "P100", plan_code: "", deductible: "$100", oop_max: "$4,000", doctor_visit: "$25", benefits_belong: true, EE: 1, ES: 2, EC: 3, FAM: 4, ...blank }] }, stored);
assert.equal(r2.verdict, "issues");
assert.deepEqual(r2.mismatches.map((m) => m.field), ["benefit doctor_visit"]);

console.log(`schema limits: ${Object.keys(all).join(", ")} within ${SCHEMA_UNION_LIMIT} union parameters; empty strings read as not stated - ok`);
