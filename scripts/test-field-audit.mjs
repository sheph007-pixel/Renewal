// The audit checks every client-facing field in code, not rates alone:
//  1. Comparison normalizes harmless formatting only ($1,500 = 1500, 25 % =
//     25%, "No charge" = $0) and never rewrites a stored value.
//  2. Each auditor returns, per plan, what the document prints - name, code,
//     network, deductible, out-of-pocket max, coinsurance, every benefit,
//     HSA eligibility, four rates - and server code compares them: a wrong
//     copay is a finding even when the auditor said "pass" and listed nothing.
//  3. The auditor is told where to find each plan, never the stored values.
//  4. A large proposal is audited in deterministic batches: every plan
//     exactly once per model, all batches tied to one reading and document;
//     a missing or failed batch leaves the audit pending, never a pass.
import assert from "node:assert/strict";
import { comparePlan, figures, sameBenefit, sameAmount, sameNetwork, nameForCompare, AUDIT_STANDARD } from "../server/plan-compare.js";
import { auditProposal, auditBatches, AUDIT_BATCH, readingVersion } from "../server/proposal-audit.js";

// 1. Comparison-only normalization.
assert.ok(sameBenefit("$1,500", "1500"));
assert.ok(sameBenefit("25 %", "25%"));
assert.ok(sameBenefit("No charge", "$0"));
assert.ok(sameBenefit("$30 copay", "$30"));
assert.ok(sameBenefit("$10 / $40 / $80", "Tier 1: $10; Tier 2: $40; Tier 3: $80"));
assert.ok(!sameBenefit("$10 / $40 / $80", "$10 / $45 / $80"), "a different copay is a different value");
assert.ok(!sameBenefit("20%", "30%"));
assert.ok(!sameBenefit("$30 copay", "$40 copay"));
assert.deepEqual(figures("$3,000 / $6,000"), ["3000", "6000"]);
assert.ok(sameAmount("$3,000", "$3,000 / $6,000"), "the individual figure agrees; the stored value states no family figure");
assert.ok(!sameAmount("$3,000 / $6,000", "$3,000 / $7,000"), "a family figure both state must agree");
assert.ok(!sameAmount("$2,500", "$3,000"));
assert.ok(sameNetwork("Choice Plus", "UHC Choice Plus Network"));
assert.ok(!sameNetwork("Choice", "Choice Plus"), "Choice is never Choice Plus");
assert.equal(nameForCompare(`Option 1 ${String.fromCharCode(0x2013)} EZ2I  (Open Access HSA)`), nameForCompare("option 1 - EZ2I (Open Access HSA)"));

// 2. Field-by-field comparison.
const stored = {
  name: "Choice Plus 3000",
  plan_code: "P3000",
  network: "Choice Plus",
  deductible: "$3,000",
  oop_max: "$6,000",
  benefits: { doctor_visit: "$30 copay", specialist: "$60 copay", imaging: "", urgent_care: "$75", emergency_room: "$350 copay", hospital: "20% after deductible", rx: "$10 / $40 / $80", coinsurance: "20%", hsa_eligible: "no" },
  rates: { EE: 612.45, ES: 1290.1, EC: 1150, FAM: 1850.2 },
};
const frozen = JSON.stringify(stored);
const onDoc = { name: "Choice Plus 3000", plan_code: "P3000", network: "UHC Choice Plus", deductible: "$3,000 per person", oop_max: "$6,000", doctor_visit: "$30", specialist: "$60 copay", imaging: null, urgent_care: "$75 copay", emergency_room: "$350", hospital: "20% after ded", rx: "Tier 1 $10, Tier 2 $40, Tier 3 $80", coinsurance: "20 %", hsa_eligible: "No", EE: 612.45, ES: 1290.1, EC: 1150, FAM: 1850.2 };
assert.deepEqual(comparePlan(stored, onDoc), [], "formatting differences are not findings");
assert.equal(JSON.stringify(stored), frozen, "comparison never rewrites the stored value");
const wrong = comparePlan(stored, { ...onDoc, specialist: "$65 copay", deductible: "$3,500", rx: "$10 / $45 / $80", hsa_eligible: "yes", plan_code: "P3000B", FAM: 1850.02, imaging: "$250" });
assert.deepEqual(
  wrong.map((d) => d.field).sort(),
  ["benefit hsa_eligible", "benefit imaging", "benefit rx", "benefit specialist", "deductible", "plan_code", "rate FAM"].sort(),
  "every client-facing field compared: benefits, deductible, code, rates - and a value the document states that the database lacks",
);
assert.deepEqual(comparePlan(stored, { ...onDoc, name: "Choice Plus 3000 (headline option 2)" }).map((d) => d.field), ["name"], "the name must be exactly as printed");
assert.deepEqual(comparePlan(stored, { ...onDoc, doctor_visit: null, network: null }), [], "a value the document does not state is not held against the database");

// 3 + 4. The audit, with a stand-in auditor: batches, blind payload, code comparison.
const plan = (i) => ({
  name: `Plan ${i}`,
  plan_code: `C${i}`,
  network: "Choice Plus",
  deductible: `$${1000 + i}`,
  oop_max: "$6,000",
  benefits: { doctor_visit: "$30", specialist: "$60", imaging: "", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10 / $40 / $80", coinsurance: "20%", hsa_eligible: "no" },
  rates: { EE: 500 + i, ES: 1000 + i, EC: 900 + i, FAM: 1500 + i },
  option_id: `UH${i + 1}`,
  source: { identity: [i + 1], benefits: [i + 1], rates: [i + 1], sheet: "", rows: "", appearances: 2, codes: [`C${i}`] },
});
const N = 60;
const extracted = { plans: Array.from({ length: N }, (_, i) => plan(i)) };
assert.equal(AUDIT_BATCH, 25);
assert.deepEqual(auditBatches(N).map((b) => [b[0], b[b.length - 1]]), [[0, 24], [25, 49], [50, 59]], "deterministic batches by stored index");
const asked = { Claude: [], ChatGPT: [] };
const docRead = (i) => {
  const p = plan(i);
  // The document prints a different specialist copay for plan 52 - a value the
  // stand-in auditor reads correctly but never mentions as a mismatch.
  return { index: i, on_document: true, name: p.name, plan_code: p.plan_code, network: p.network, deductible: p.deductible, oop_max: p.oop_max, ...p.benefits, specialist: i === 52 ? "$65" : p.benefits.specialist, imaging: null, benefits_belong: true, ...p.rates };
};
const answer = ({ skip = null, fail = null, reading = extracted } = {}) => async (who, payload, indices) => {
  const key = /^claude/i.test(who) ? "Claude" : "ChatGPT";
  asked[key].push(indices);
  const told = JSON.parse(payload.split("The plans to find and read:\n")[1].split("\n\nRead every")[0]);
  assert.deepEqual(Object.keys(told[0]).sort(), ["id", "index", "name", "network", "plan_code", "plan_type", "source_pages"], "the auditor is told where to find each plan, never its stored values");
  assert.match(payload, new RegExp(`reading ${readingVersion(reading)}`), "every batch names the same reading");
  if (fail != null && indices[0] === fail) throw new Error("rate limited");
  return { verdict: "pass", plan_appearances: N * 2, plans_found_total: N, epo_excluded: 0, document_plan_count: N, duplicates_found: false, plan_confirmations: indices.filter((i) => i !== skip).map(docRead), mismatches: [], notes: "" };
};
let a = await auditProposal({ filename: "big.pdf", mime: "application/pdf", buffer: Buffer.from(""), extracted, sourceSha: "sha-big", read: answer() });
assert.deepEqual(asked.Claude, auditBatches(N), "Claude saw every plan exactly once, in order");
assert.deepEqual(asked.ChatGPT, auditBatches(N), "ChatGPT too");
assert.equal(a.standard, AUDIT_STANDARD);
assert.equal(a.batches, 3);
assert.equal(a.sourceSha, "sha-big");
assert.equal(a.status, "issues", "both auditors said pass - code found the wrong copay anyway");
assert.deepEqual(
  a.mismatches.map((m) => [m.index, m.field, m.stored, m.onDocument]),
  [[52, "benefit specialist", "$60", "$65"], [52, "benefit specialist", "$60", "$65"]],
  "one finding per auditor, pinned to the plan's index",
);
assert.ok(a.models.every((m) => m.confirmed === N && m.of === N && m.batches.length === 3));

// A batch that comes back short: that model is incomplete, the audit pending.
asked.Claude = [];
asked.ChatGPT = [];
const good = { plans: extracted.plans.map((p, i) => (i === 52 ? { ...p, benefits: { ...p.benefits, specialist: "$65" } } : p)) };
a = await auditProposal({ filename: "big.pdf", mime: "application/pdf", buffer: Buffer.from(""), extracted: good, sourceSha: "sha-big", read: answer({ reading: good }) });
assert.equal(a.status, "pass", "every field agrees, every plan in every batch, both models");
a = await auditProposal({ filename: "big.pdf", mime: "application/pdf", buffer: Buffer.from(""), extracted: good, sourceSha: "sha-big", read: answer({ skip: 31, reading: good }) });
assert.equal(a.status, "pending", "a plan left out of a batch is never a pass");
assert.ok(a.models.every((m) => m.verdict === "incomplete" && m.confirmed === N - 1));
// A batch that fails: pending, and the model's result says which batch.
a = await auditProposal({ filename: "big.pdf", mime: "application/pdf", buffer: Buffer.from(""), extracted: good, sourceSha: "sha-big", read: answer({ fail: 25, reading: good }) });
assert.equal(a.status, "pending", "a failed batch is never a pass");
assert.ok(a.models.every((m) => m.verdict === "error" && /Batch 2 of 3: rate limited/.test(m.notes)));

// A plan the list lacks, reported by every batch (each reads the whole document), is one finding per auditor.
const extra = (who, payload, indices) => ({ verdict: "issues", plan_appearances: N * 2, plans_found_total: N + 1, epo_excluded: 0, document_plan_count: N + 1, duplicates_found: false, plan_confirmations: indices.map(docRead).map((r) => (r.index === 52 ? { ...r, specialist: "$65" } : r)), mismatches: [{ plan: "Plan X", field: "extra_plan", stored: "not stored", on_document: "Plan X" }], notes: "" });
a = await auditProposal({ filename: "big.pdf", mime: "application/pdf", buffer: Buffer.from(""), extracted: good, sourceSha: "sha-big", read: extra });
assert.equal(a.status, "issues");
assert.equal(a.mismatches.filter((m) => m.field === "extra_plan").length, 2, "one per auditor, not one per batch");
assert.equal(a.mismatches.filter((m) => m.field === "plan_count").length, 2, "and the count held to the database once per auditor");

console.log("field audit: every client-facing field read by each auditor and compared in code, formatting normalized for comparison only, large proposals audited in batches - every plan once per model, pending unless every batch passes - ok");
