// Option IDs end to end (canned reader, KENNION_FAKE_AI): every quoted plan
// gets UH1, GR1 …, numbered per group in carrier order; UnitedHealthcare's
// two proposals share a sequence; a re-read keeps numbers; a newer proposal
// in the same slot hands surviving plans their old numbers and never reuses
// a retired one; an EPO twin is never stored, so it carries no number and
// never reaches the client; a slot stored before that rule is cleaned and
// renumbered once, compactly;
// the sign-up carries the IDs; the comparison finds a plan by ID.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5089;
const CODE = "ids-test-code";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const stop = () => server.kill();
process.on("exit", stop);
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const staffAuth = { Authorization: `Bearer ${staff.token}` };
const mine = staff.groups.filter((g) => !g.archived && g.eligible !== false)[0];
const r0 = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: mine.code }) });
const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];

const plan = (name, code, ee, extra = {}) => ({ name, plan_code: code, network: "Choice Plus", plan_type: "PPO", deductible: "$4,000", oop_max: "$8,150", benefits: {}, rates: { EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 }, monthly_total: null, ...extra });
const reading = (carrier, funding, plans) => ({ carrier, funding, quotes_medical: true, matched_group: mine.name, confidence: 0.95, effective_date: "2027-01-01", proposal_type: "renewal", enrolled_on_document: mine.enrolled, plans, total_monthly: null, summary: "Canned." });
const upload = async (filename, slot, body) => {
  const r = await fetch(`${base}/api/admin/proposals?filename=${encodeURIComponent(filename)}&group=${encodeURIComponent(mine.name)}&slot=${encodeURIComponent(slot)}`, { method: "POST", headers: { ...staffAuth, "Content-Type": "text/plain" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.text());
};
const settled = async (filename) => {
  for (let i = 0; i < 80; i++) {
    await wait(250);
    const rows = (await (await fetch(`${base}/api/admin/proposals`, { headers: staffAuth })).json()).proposals || [];
    const row = rows.find((r) => r.filename === filename);
    if (row && row.status !== "analyzing" && row.audit) return row;
  }
  throw new Error(`${filename} never settled`);
};
const clientIds = async (slot) => {
  const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
  const pr = (page.proposals || []).find((p) => p.slot === slot);
  return pr ? pr.plans.map((p) => `${p.optionId}:${p.name}`) : [];
};
const storedIds = (row) => (row.extracted.plans || []).map((p) => `${p.option_id}:${p.name}`);

// 1. A UHC level-funded quote with three plans: UH1..UH3 in document order.
await upload("uhc-lf.json", "UHC Level Funded", reading("UnitedHealthcare", "level funded", [plan("P4000i8021B", "P4000i8021B", 620), plan("P5000i10021B", "P5000i10021B", 600), plan("P3500i100ES21B", "P3500i100ES21B", 640)]));
let lf = await settled("uhc-lf.json");
assert.deepEqual(storedIds(lf), ["UH1:P4000i8021B", "UH2:P5000i10021B", "UH3:P3500i100ES21B"]);
assert.deepEqual(await clientIds("UHC Level Funded"), ["UH1:P4000i8021B", "UH2:P5000i10021B", "UH3:P3500i100ES21B"]);

// 2. The fully insured quote continues the same sequence.
await upload("uhc-fi.json", "UHC Fully Insured", reading("UnitedHealthcare", "fully insured", [plan("EZ2B Open Access HSA", "EZ2B", 700), plan("EZ2D Open Access HSA", "EZ2D", 710)]));
const fi = await settled("uhc-fi.json");
assert.deepEqual(storedIds(fi), ["UH4:EZ2B Open Access HSA", "UH5:EZ2D Open Access HSA"]);

// 3. A re-read keeps every number.
assert.equal((await fetch(`${base}/api/admin/proposals/${lf.id}/analyze`, { method: "POST", headers: staffAuth })).status, 200);
await wait(1500);
lf = await settled("uhc-lf.json");
assert.deepEqual(storedIds(lf), ["UH1:P4000i8021B", "UH2:P5000i10021B", "UH3:P3500i100ES21B"], "a re-read keeps the numbers");
assert.ok(!lf.extracted.previous_plan_ids, "the carry-over list is cleared once numbers are settled");

// 4. A newer quote in the same slot: a renamed plan with the same code keeps
//    its number, a dropped plan's number is retired, a new plan gets a fresh one.
await upload("uhc-lf-v2.json", "UHC Level Funded", reading("UnitedHealthcare", "level funded", [plan("P4000i8021B Choice Plus", "P4000i8021B", 625), plan("P3500i100ES21B", "P3500i100ES21B", 645), plan("P6000i100LX21B", "P6000i100LX21B", 580)]));
const lf2 = await settled("uhc-lf-v2.json");
assert.deepEqual(storedIds(lf2), ["UH1:P4000i8021B Choice Plus", "UH3:P3500i100ES21B", "UH6:P6000i100LX21B"], "kept by code, kept by name, new number never reuses UH2");
let all = (await (await fetch(`${base}/api/admin/proposals`, { headers: staffAuth })).json()).proposals;
assert.ok(!all.some((r) => r.id === lf.id), "one proposal per slot: the replaced one is deleted, not kept as superseded");
assert.equal(all.filter((r) => r.slot === "UHC Level Funded" && r.group_name === mine.name).length, 1);
assert.deepEqual(await clientIds("UHC Level Funded"), ["UH1:P4000i8021B Choice Plus", "UH3:P3500i100ES21B", "UH6:P6000i100LX21B"]);

// 4b. A third quote in the slot, after the old row is gone: UH2 stays retired
//     and the numbers the deleted row handed down are still honoured.
await upload("uhc-lf-v3.json", "UHC Level Funded", reading("UnitedHealthcare", "level funded", [plan("P5000i10021B", "P5000i10021B", 605), plan("P3500i100ES21B", "P3500i100ES21B", 650)]));
const lf3 = await settled("uhc-lf-v3.json");
assert.deepEqual(storedIds(lf3), ["UH7:P5000i10021B", "UH3:P3500i100ES21B"], "a plan that came back after its number was retired gets a fresh one; a surviving plan keeps its number");
all = (await (await fetch(`${base}/api/admin/proposals`, { headers: staffAuth })).json()).proposals;
assert.equal(all.filter((r) => r.slot === "UHC Level Funded" && r.group_name === mine.name).length, 1, "still one proposal in the slot");
assert.ok(!all.some((r) => r.superseded_by), "nothing is ever left marked superseded");

// 5. Gravie: its own prefix; the EPO twin is not stored, so the PPO designs
//    read GR1, GR2 … with nothing missing.
await upload("gravie.json", "Gravie", reading("Gravie", "level funded", [plan("Gravie Copay 1500 PPO", "G1500", 610, { network: "Cigna OAP (PPO)" }), plan("Gravie Copay 1500 EPO", "G1500E", 590, { network: "Cigna OAP (EPO)", plan_type: "EPO" }), plan("Gravie Copay 2500 PPO", "G2500", 580, { network: "Cigna OAP (PPO)" })]));
const gr = await settled("gravie.json");
assert.deepEqual(storedIds(gr), ["GR1:Gravie Copay 1500 PPO", "GR2:Gravie Copay 2500 PPO"], "EPO twins are never stored");
assert.deepEqual(await clientIds("Gravie"), ["GR1:Gravie Copay 1500 PPO", "GR2:Gravie Copay 2500 PPO"], "PPO only, and the numbers run without gaps");

// 5b. A slot stored before that rule — EPO twins holding numbers — is
//     cleaned and renumbered once, compactly, and nothing from the old
//     sequence leaks.
await upload("gravie-legacy.json", "Gravie", reading("Gravie", "level funded", [plan("Gravie Copay 1500 PPO", "G1500", 610, { network: "Cigna OAP (PPO)", option_id: "GR1" }), plan("Gravie Copay 1500 EPO", "G1500E", 590, { network: "Cigna OAP (EPO)", plan_type: "EPO", option_id: "GR2" }), plan("Gravie Copay 2500 PPO", "G2500", 580, { network: "Cigna OAP (PPO)", option_id: "GR3" }), plan("Gravie Copay 2500 EPO", "G2500E", 560, { network: "Cigna OAP (EPO)", plan_type: "EPO", option_id: "GR4" })]));
const grl = await settled("gravie-legacy.json");
assert.deepEqual(storedIds(grl), ["GR1:Gravie Copay 1500 PPO", "GR2:Gravie Copay 2500 PPO"], "the old GR1–GR4 becomes GR1–GR2, EPO twins gone");
assert.deepEqual(await clientIds("Gravie"), ["GR1:Gravie Copay 1500 PPO", "GR2:Gravie Copay 2500 PPO"]);

// 6. The sign-up carries the ID with the name, and the comparison finds a plan by ID.
const signup = await fetch(`${base}/api/group/signup`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ code: mine.code, plans: ["UH1 · P4000i8021B Choice Plus"], note: "" }) });
assert.equal(signup.status, 200, await signup.text());
const { comparisonTable } = await import("../server/documents.js");
const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
const table = comparisonTable({ group: page.group, proposals: page.proposals, plans: ["UH7", "GR1"], includeCurrent: false });
assert.deepEqual(
  table.rows.filter((r) => r.section === "2027 options").map((r) => r.name),
  ["UH7 · P5000i10021B", "GR1 · Gravie Copay 1500 PPO"],
);

console.log("option ids: UH/GR per group in carrier order, kept across re-reads and newer quotes, never reused, on sign-up and in the comparison — ok", { group: mine.name });
stop();
