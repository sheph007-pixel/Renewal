// The plan design catalogue: a carrier's standard designs, loaded once and
// the same for every group. The Angle Health workbook parses to 19 designs
// with 20 service lines each; a quoted plan whose name is a catalogue code
// takes its benefits from the catalogue; the staff route lists the
// catalogue and an upload adds to it; and a group's page and the assistant's
// figures carry the design on the quoted plan.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { applyCatalogue, catalogueIndex, catalogueKey, designBenefits, designLine, lookupDesign, parseCatalogueWorkbook, serviceText } from "../server/plan-catalogue.js";
import { describeGroup } from "../server/assistant.js";

const workbook = readFileSync(new URL("../server/data/plan-docs/AngleHealthStandardPlanBenefits.xlsx", import.meta.url));
const designs = parseCatalogueWorkbook(workbook, { carrier: "Angle Health", planYear: 2027, source: "AngleHealthStandardPlanBenefits.xlsx" });
assert.equal(designs.length, 19, "nineteen Angle Health designs");
assert.ok(designs.every((d) => d.services.length === 20), "twenty service lines on every design");
assert.ok(designs.every((d) => d.planId && /^[0-9a-f-]{36}$/.test(d.planId)), "every design carries Angle's plan ID");

// ANG TRAD 5000 7000, as printed on page 4 of the quote.
const trad = designs.find((d) => d.planCode === "ANG TRAD 5000 7000");
assert.deepEqual(trad.inNetwork, { deductibleIndividual: 5000, deductibleFamily: 10000, oopMaxIndividual: 7000, oopMaxFamily: 14000 });
assert.deepEqual(trad.outOfNetwork, { deductibleIndividual: 10000, deductibleFamily: 20000, oopMaxIndividual: 14000, oopMaxFamily: 28000, coinsurance: 0.5 });
assert.equal(trad.deductibleEmbedded, true);
assert.equal(trad.familyName, "Traditional");
assert.deepEqual(designBenefits(trad), {
  doctorVisit: "$25 copay",
  specialist: "$75 copay",
  imaging: "$25 copay labs · 20% after deductible X-ray · 20% after deductible imaging",
  urgentCare: "$85 copay",
  hospital: "20% after deductible",
  rx: "$20 / $60 / $85 / 20% after deductible",
  er: "$300 copay after deductible",
});
assert.match(designLine(trad), /^ANG TRAD 5000 7000 \(Traditional\): deductible \$5,000 individual \/ \$10,000 family; out-of-pocket max \$7,000 \/ \$14,000; PCP \$25 copay/);
assert.match(designLine(trad), /out-of-network deductible \$10,000, OOP max \$14,000, 50% coinsurance$/);

// An HDHP: everything after the deductible, and the one non-embedded family deductible in the lineup.
const hdhp = designs.find((d) => d.planCode === "ANG HDHP 1750 1750");
assert.equal(hdhp.deductibleEmbedded, false, "the $1,750 HDHP's family deductible is not embedded");
assert.equal(designBenefits(hdhp).doctorVisit, "No cost after deductible");
assert.equal(designBenefits(hdhp).rx, "No cost after deductible (all tiers)", "four drug tiers that say the same thing say it once");
assert.match(designLine(hdhp), /family deductible not embedded$/);
assert.equal(serviceText({ amount: 0, deductibleApplies: false }), "No cost");
assert.equal(serviceText({ percent: 0.2, deductibleApplies: false }), "20%");
assert.equal(serviceText({ costShare: "As printed", deductibleApplies: false }), "As printed");

// A Value plan: copays for office visits, the deductible for the rest.
const value = designs.find((d) => d.planCode === "ANG VALUE 9200");
assert.equal(designBenefits(value).specialist, "$50 copay");
assert.equal(designBenefits(value).rx, "$10 / $40 / No cost after deductible / No cost after deductible");

// Lookups forgive case, spacing and punctuation; a name that is not a code finds nothing.
const index = catalogueIndex(designs);
assert.equal(catalogueKey("  ang-trad  5000/7000 "), "ANG TRAD 5000 7000");
assert.equal(lookupDesign(index, "angle health", { name: "Ang Trad 5000 7000" }), trad);
assert.equal(lookupDesign(index, "Angle Health", { name: "Traditional 5000", planCode: "ANG TRAD 5000 7000" }), trad, "the printed code matches when the name does not");
assert.equal(lookupDesign(index, "Angle Health", { name: "Angle Traditional 2000" }), null);
assert.equal(lookupDesign(index, "Gravie", { name: "ANG TRAD 5000 7000" }), null, "a code is the carrier's own");

// A quoted proposal: the catalogue design's figures replace the reader's on
// the plan that is a design; a plan that is not stays as read.
const proposal = {
  id: 1,
  slot: "Angle",
  carrier: "Angle Health",
  plans: [
    { optionId: "AN1", name: "ANG TRAD 5000 7000", planCode: null, planType: null, deductible: "$5000", oopMax: "7000", benefits: { doctorVisit: "$25", specialist: "$75", imaging: "", urgentCare: "", hospital: "20%", rx: "" }, rates: { EE: 409.48, ES: 818.96, EC: 777.11, FAM: 1166.66 }, monthlyTotal: null },
    { optionId: "AN2", name: "Angle Custom 1000", planCode: null, planType: "Traditional", deductible: "$1,000", oopMax: "$3,000", benefits: null, rates: { EE: 500, ES: 1000, EC: 900, FAM: 1400 }, monthlyTotal: null },
  ],
};
const applied = applyCatalogue(proposal, index, "Angle Health");
assert.notEqual(applied, proposal, "a new proposal object when a plan was matched");
assert.equal(applied.plans[0].deductible, "$5,000");
assert.equal(applied.plans[0].oopMax, "$7,000");
assert.equal(applied.plans[0].planType, "Traditional", "the design family stands in for a plan type the reader did not give");
assert.equal(applied.plans[0].benefits.er, "$300 copay after deductible");
assert.equal(applied.plans[0].benefits.imaging, "$25 copay labs · 20% after deductible X-ray · 20% after deductible imaging");
assert.equal(applied.plans[0].design.planCode, "ANG TRAD 5000 7000");
assert.equal(applied.plans[0].design.services.length, 20);
assert.equal(applied.plans[0].design.services[0].text, "$25 copay");
assert.equal(applied.plans[0].rates.EE, 409.48, "the group's own rates are untouched");
assert.equal(applied.plans[1], proposal.plans[1], "a plan that is not a catalogue design is left as read");
assert.equal(applyCatalogue(proposal, new Map(), "Angle Health"), proposal, "no catalogue, no change");
assert.equal(applyCatalogue(proposal, index, "Gravie"), proposal, "another carrier's catalogue does not apply");

// The assistant's figures carry the design on the quoted plan.
const seed = JSON.parse(readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
const g = seed.groups[0];
const text = describeGroup({ group: { ...g, rates: {}, planTiers: {} }, proposals: [{ ...applied, funding: "level funded", effectiveDate: "2027-01-01", summary: null }], funding: null, manager: null, splits: {}, signup: null, renewal: null, planDesigns: seed.planDesigns });
assert.match(text, /Option AN1 - ANG TRAD 5000 7000 \(Traditional\): deductible \$5,000, out-of-pocket max \$7,000/);
assert.match(text, /benefits - PCP \$25 copay; specialist \$75 copay; urgent care \$85 copay; imaging \$25 copay labs[^;]*; hospital 20% after deductible; ER \$300 copay after deductible; Rx \$20 \/ \$60 \/ \$85 \/ 20% after deductible/);
assert.match(text, /standard design - family deductible \$10,000, family out-of-pocket max \$14,000; out-of-network deductible \$10,000, out-of-network out-of-pocket max \$14,000, 50% coinsurance/);
assert.ok(!/Option AN2[^\n]*standard design/.test(text), "no standard design line on a plan that is not one");

// A workbook that is not a catalogue is refused, not half-read.
assert.throws(() => parseCatalogueWorkbook(Buffer.from("not a workbook"), { carrier: "Angle Health" }));

// The server: the shipped catalogue is loaded at boot and listed for staff;
// an upload adds designs by code; a quoted Angle plan reaches the group's
// page with the design on it.
const PORT = 5093;
const CODE = "catalogue-test-code";
const server = spawn("node", ["server/index.js"], { env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
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
const auth = { Authorization: `Bearer ${staff.token}` };
assert.equal((await fetch(`${base}/api/admin/plan-catalogue`)).status, 401);
let cat = await (await fetch(`${base}/api/admin/plan-catalogue`, { headers: auth })).json();
assert.deepEqual(cat.carriers.map((c) => [c.carrier, c.planYear, c.count, c.sources]), [
  ["Angle Health", 2027, 19, ["AngleHealthStandardPlanBenefits.xlsx"]],
  ["Optimyl Health", 2027, 4, ["OptimylHealthStandardPlanBenefits.xlsx"]],
]);
assert.equal(cat.designs.length, 23);
assert.equal(cat.durable, false);

// Upload the same workbook again as Angle Health: every code is already there, so still 19.
const up = await fetch(`${base}/api/admin/plan-catalogue/angle-health?filename=again.xlsx`, { method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: workbook });
const upText = await up.text();
assert.equal(up.status, 200, upText);
const upj = JSON.parse(upText);
assert.equal(upj.loaded, 19);
assert.equal(upj.total, 19);
cat = await (await fetch(`${base}/api/admin/plan-catalogue`, { headers: auth })).json();
assert.equal(cat.designs.length, 23);
assert.equal(cat.carriers[0].sources.join(), "again.xlsx", "the upload's designs replaced the shipped ones by code");
assert.equal((await fetch(`${base}/api/admin/plan-catalogue/no-such-carrier`, { method: "POST", headers: auth, body: workbook })).status, 404);
assert.equal((await fetch(`${base}/api/admin/plan-catalogue/gravie`, { method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: Buffer.from("nope") })).status, 400);

// A quoted Angle proposal (canned reader) reaches the group's page with the design on the plan.
const mine = staff.groups.filter((x) => !x.archived && x.eligible !== false)[0];
const r0 = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: mine.code }) });
const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];
const reading = {
  carrier: "Angle Health",
  funding: "level funded",
  quotes_medical: true,
  matched_group: mine.name,
  confidence: 0.95,
  effective_date: "2027-01-01",
  proposal_type: "new business",
  enrolled_on_document: mine.enrolled,
  plans: [
    { name: "ANG TRAD 5000 7000", plan_code: null, network: "Cigna", plan_type: null, deductible: "$5000", oop_max: "$7000", benefits: { doctor_visit: "$25", specialist: "$75", imaging: "", urgent_care: "", hospital: "", rx: "" }, rates: { EE: 409.48, ES: 818.96, EC: 777.11, FAM: 1166.66 }, monthly_total: null },
    { name: "ANG HDHP 1750 1750", plan_code: null, network: "Cigna", plan_type: "HDHP", deductible: "$1750", oop_max: "$1750", benefits: {}, rates: { EE: 452.98, ES: 905.95, EC: 859.66, FAM: 1290.6 }, monthly_total: null },
  ],
  total_monthly: null,
  summary: "Canned.",
};
const r1 = await fetch(`${base}/api/admin/proposals?filename=${encodeURIComponent("angle.json")}&group=${encodeURIComponent(mine.name)}&slot=Angle`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: JSON.stringify(reading) });
const r1Text = await r1.text();
assert.equal(r1.status, 200, r1Text);
let pr = null;
for (let i = 0; i < 80 && !pr; i++) {
  await wait(250);
  const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
  pr = (page.proposals || []).find((p) => p.slot === "Angle") || null;
}
assert.ok(pr, "the Angle proposal reached the group's page");
const [p1, p2] = pr.plans;
assert.equal(p1.deductible, "$5,000");
assert.equal(p1.oopMax, "$7,000");
assert.equal(p1.planType, "Traditional");
assert.equal(p1.benefits.urgentCare, "$85 copay", "a benefit the reader left blank is filled from the catalogue");
assert.equal(p1.benefits.er, "$300 copay after deductible");
assert.equal(p1.design.planId, trad.planId);
assert.equal(p1.design.services.length, 20);
assert.equal(p2.design.deductibleEmbedded, false);
assert.equal(p2.benefits.doctorVisit, "No cost after deductible");
assert.equal(p2.rates.EE, 452.98);

console.log("plan catalogue: 19 Angle Health designs parsed, matched by code, listed and loaded by staff, on the group's page and in the assistant's figures - ok");
stop();
