// The same carrier plan stored twice because the reader added a placement
// label to its name - "P100i10025B" and "P100i10025B (alt grid base)", the
// same network, deductible, OOP max and rates - is one plan: folded when a
// proposal is read, flagged by validation if it is ever stored, and folded
// by rule in every group's stored proposals (the copy's BenSync ID retired),
// so the database and the Medical Plans grid hold it once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePlans, foldPlacementDuplicates, placementCore } from "../server/plan-canonical.js";
import { validatePlans } from "../server/plan-validate.js";

const rates = { EE: 966, ES: 1932, EC: 1740, FAM: 2800 };
const plan = (name, extra = {}) => ({ name, plan_code: null, network: "Choice Plus", plan_type: "PPO", deductible: "$100", oop_max: "$4,000", benefits: { doctor_visit: "$20" }, rates: { ...rates }, monthly_total: null, ...extra });

// Placement labels, and names that are not.
assert.equal(placementCore("P100i10025B (alt grid base)"), "P100i10025B");
assert.equal(placementCore("Choice Plus 2000 (headline option 2)"), "Choice Plus 2000");
assert.equal(placementCore("P3000 [PPO alternate 32]"), "P3000");
assert.equal(placementCore("Gold 1500 (HSA)"), null, "carrier wording is not a placement label");
assert.equal(placementCore("P100i10025B"), null);

// 1. At read time: the labelled appearance is another appearance of the plan.
let c = canonicalizePlans([plan("P100i10025B"), plan("P100i10025B (alt grid base)"), plan("P200i10025B", { rates: { EE: 900, ES: 1800, EC: 1600, FAM: 2600 } })]);
assert.deepEqual(c.plans.map((p) => p.name), ["P100i10025B", "P200i10025B"], "one plan, under its printed name");
assert.equal(c.plans[0].source.appearances, 2);
assert.equal(c.reconciliation.unique_plans, 2);
assert.equal(c.reconciliation.placement_labels_folded, 1);
// A labelled copy that states a different rate is still one plan, with the
// disagreement recorded for the source to settle - never silently chosen.
c = canonicalizePlans([plan("P100i10025B"), plan("P100i10025B (alt grid base)", { rates: { ...rates, FAM: 2900 } })]);
assert.equal(c.plans.length, 1);
assert.deepEqual(c.plans[0].conflicts.map((k) => k.field), ["FAM"]);
// Different printed codes are different plans, label or not.
c = canonicalizePlans([plan("P100", { plan_code: "AAA" }), plan("P100 (alt grid base)", { plan_code: "BBB" })]);
assert.equal(c.plans.length, 2);
// A different network is a different plan.
c = canonicalizePlans([plan("P100"), plan("P100 (alt grid base)", { network: "Options PPO" })]);
assert.equal(c.plans.length, 2);

// A name that IS another appearance's code: the same plan.
c = canonicalizePlans([plan("Choice Plus P100i10025B", { plan_code: "P100i10025B" }), plan("P100i10025B")]);
assert.equal(c.plans.length, 1);
assert.equal(c.plans[0].name, "Choice Plus P100i10025B");
assert.equal(validatePlans({ extracted: { plans: [plan("Choice Plus P100i10025B", { plan_code: "P100i10025B" }), plan("P100i10025B")] } }).checks.find((k) => k.key === "unique").ok, false, "and stored that way, it fails validation");

// 2. Stored: validation fails on it (routed to correction), and the fold removes it.
const stored = [plan("P100i10025B", { option_id: "UH70" }), plan("P100i10025B (alt grid base)", { option_id: "UH146", benefits: { doctor_visit: "$20", specialist: "$40" } })];
const v = validatePlans({ extracted: { plans: stored } });
const unique = v.checks.find((k) => k.key === "unique");
assert.equal(unique.ok, false, "a plan stored twice fails validation");
assert.match(unique.note, /"P100i10025B" and "P100i10025B \(alt grid base\)" look like one plan stored twice/);
const f = foldPlacementDuplicates(stored);
assert.deepEqual(f.plans.map((p) => [p.option_id, p.name]), [["UH70", "P100i10025B"]], "the printed name and its ID are kept");
assert.equal(f.plans[0].benefits.specialist, "$40", "a value only the copy stated is kept");
assert.deepEqual(f.folded.map((x) => x.plan.option_id), ["UH146"]);
assert.equal(validatePlans({ extracted: { plans: f.plans } }).checks.find((k) => k.key === "unique").ok, true);
// Not folded: a labelled copy with a different value (settled against the source instead).
assert.equal(foldPlacementDuplicates([stored[0], { ...stored[1], deductible: "$500" }]).folded.length, 0);
// Carrier wording in brackets with the same values: flagged for the source, not folded by rule.
const hsa = [plan("Gold 1500"), plan("Gold 1500 (HSA)")];
assert.equal(foldPlacementDuplicates(hsa).folded.length, 0);
assert.equal(validatePlans({ extracted: { plans: hsa } }).checks.find((k) => k.key === "unique").ok, false);

// 3. Every group's stored proposals: folded by rule at boot, the copy's ID retired, the grid shows the plan once.
const data = JSON.parse((await import("node:fs")).readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
const g = data.groups.find((x) => !x.archived && x.eligible !== false);
const seed = join(mkdtempSync(join(tmpdir(), "dups-")), "proposals.json");
const reading = (plans) => ({ carrier: "UnitedHealthcare", funding: "level funded", quotes_medical: true, plans, reconciliation: { plan_appearances: plans.length, appearances_read: plans.length, unique_plans: plans.length, unique_ppo: plans.length, unique_epo: 0, expected: plans.length } });
writeFileSync(seed, JSON.stringify([{ group_name: g.name, slot: "UHC Level Funded", carrier: "UnitedHealthcare", extracted: reading([plan("P100i10025B", { option_id: "UH1" }), plan("P100i10025B (alt grid base)", { option_id: "UH2" }), plan("P200i10025B", { option_id: "UH3", rates: { EE: 900, ES: 1800, EC: 1600, FAM: 2600 } })]) }]));
const PORT = 5098;
const CODE = "dups-code";
const server = spawn("node", ["server/index.js"], { env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "", KENNION_SEED_PROPOSALS: seed, KENNION_CLIENT_VERIFIED_ONLY: "0" }, stdio: ["ignore", "pipe", "pipe"] });
process.on("exit", () => server.kill());
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => process.stderr.write(d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
let row = null;
for (let i = 0; i < 80; i++) {
  row = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals.find((r) => r.group_name === g.name && r.slot === "UHC Level Funded");
  if (row && row.extracted.plans.length === 2) break;
  await new Promise((r) => setTimeout(r, 250));
}
assert.deepEqual(row.extracted.plans.map((p) => [p.option_id, p.name]), [["UH1", "P100i10025B"], ["UH3", "P200i10025B"]], "stored once, under the printed name, with its ID");
assert.equal(row.extracted.reconciliation.unique_plans, 2);
assert.ok(row.extracted.corrections.some((k) => k.option_id === "UH2" && k.model === "rule" && /folded into "P100i10025B" \(UH1\)/.test(k.to)), "the fold is logged on the reading");
assert.match(log, /duplicates: #\d+ .* folded UH2 "P100i10025B \(alt grid base\)" into UH1/);
const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: staff.groups.find((x) => x.name === g.name).code }) })).json();
const shown = page.proposals.find((p) => p.slot === "UHC Level Funded").plans;
assert.deepEqual(shown.map((p) => p.optionId), ["UH1", "UH3"], "the grid shows the plan once");

console.log("placement duplicates: folded at read time, flagged by validation, folded by rule in stored proposals (ID retired, logged), shown once - ok");
server.kill();
