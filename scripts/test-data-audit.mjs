// The data check, group by group: a clean group passes every check, a
// roster many times the enrolled figure is flagged and never repeated, and
// the assistant's briefing no longer carries a headcount at all.
// Run with: node scripts/test-data-audit.mjs
import assert from "node:assert/strict";
import { auditGroup, auditData, rosterHeadcount, CHECKS } from "../server/data-audit.js";
import { describeGroup } from "../server/assistant.js";

const member = (plan, tier, premium, er = premium * 0.7) => ({ first: "A", last: "B", tier, plan, premium, employerCost: er, employeeCost: premium - er, spAges: [], chAges: [] });

/** A group the way the import leaves it: 4 enrolled, two plans, billed rates, a roster of 6. */
const clean = () => ({
  name: "Clean Co",
  code: "CLEA2027",
  tpa: "EBPA",
  enrolled: 4,
  lives: 6,
  monthly: 2600,
  annual: 31200,
  tiers: { EE: 2, ES: 1, EC: 0, FAM: 1 },
  plans: [
    { plan: "EBPA Gold", tpa: "EBPA", enrolled: 3, monthly: 2100, program: "EBPA", groupHealth: true, assumed: false },
    { plan: "EBPA Silver", tpa: "EBPA", enrolled: 1, monthly: 500, program: "EBPA", groupHealth: true, assumed: false },
  ],
  rates: {
    "EBPA Gold": { Employee: 500, "Employee + Spouse": 1100 },
    "EBPA Silver": { "Employee + Family": 500 },
  },
  members: [member("EBPA Gold", "Employee", 500), member("EBPA Gold", "Employee", 500), member("EBPA Gold", "Employee + Spouse", 1100), member("EBPA Silver", "Employee + Family", 500)],
  lines: [{ benefit: "Dental", carrier: "Guardian", plan: "Dental", enrolled: 3, monthly: 120 }],
  supplementalMonthly: 120,
  groupHealthEnrolled: 4,
  groupHealthMonthly: 2600,
  carrierHeads: { EBPA: 4, Guardian: 3 },
  contacts: [{ name: "Pat", email: "pat@example.com" }],
  diagnostics: { employees: { total: 9, byStatus: { Active: 6, Terminated: 3 }, skipped: { Terminated: 3 } } },
  eligible: true,
  programs: ["EBPA"],
  carriersSeen: ["EBPA"],
  archived: false,
  linkToken: "tok",
  sizeCategory: "2-50",
});

const admin = { sizeCategory: "2-50", sizeIsSet: true, linkToken: "tok", importedAt: "2026-09-03T18:48:54Z", duplicateOf: [] };
const split = { plans: { "EBPA Gold": { Employee: { total: 500, er: 350, ee: 150 } } } };
const billing = { medical: { participants: 4, monthly: 2600 } };
const quotes = [{ slot: "UHC", carrier: "UnitedHealthcare", enrolledOnDocument: 4, plans: [{ name: "Gold", rates: { EE: 510, ES: 900, EC: 800, FAM: 1300 } }] }];

// Every check, in order, and a clean group passes all of them.
const ok = auditGroup({ g: clean(), admin, split, proposals: quotes, billing, fundingMonth: "2026-09", manager: "Tracy Hayden", latestImportAt: "2026-09-03T18:48:54Z" });
assert.equal(ok.status, "ok", JSON.stringify(ok.checks.filter((c) => c.level !== "ok"), null, 1));
assert.deepEqual(ok.checks.map((c) => c.key), CHECKS.map((c) => c.key));
assert.equal(ok.figures.roster, 6);
assert.match(ok.checks.find((c) => c.key === "rates").detail, /3 billed tier rates/);

// Aesto's case: 326 on the roster with status Active, 40 enrolled. Flagged,
// explained, and explicitly not a number for the client or the assistant.
const big = clean();
big.diagnostics = { employees: { total: 900, byStatus: { Active: 326, Terminated: 574 }, skipped: { Terminated: 574 } } };
const r = auditGroup({ g: big, admin: { ...admin, sizeIsSet: false }, split, proposals: [], billing: null, fundingMonth: "2026-09", manager: null });
assert.equal(rosterHeadcount(big), 326);
const roster = r.checks.find((c) => c.key === "roster");
assert.equal(roster.level, "warn");
assert.match(roster.detail, /326 employees with status Active against 4 enrolled/);
assert.match(roster.detail, /not shown to the client or the assistant/);
const size = r.checks.find((c) => c.key === "size");
assert.equal(size.level, "warn", "a defaulted size category that the roster contradicts is flagged");
assert.match(size.detail, /roster has 326/);
assert.equal(r.checks.find((c) => c.key === "billing").level, "warn", "captive plans with no invoice this month");
assert.equal(r.checks.find((c) => c.key === "manager").level, "warn");
assert.equal(r.checks.find((c) => c.key === "quotes").level, "info");
assert.equal(r.status, "warn");

// A roster the stored field alone carries (an older import) still reads; none at all is a note.
assert.equal(rosterHeadcount({ medicalEligible: 12 }), 12);
assert.equal(rosterHeadcount({}), null);
assert.equal(auditGroup({ g: { ...clean(), diagnostics: undefined }, admin }).checks.find((c) => c.key === "roster").level, "info");

// Figures that do not add up are a problem, not a note.
const broken = clean();
broken.enrolled = 5;
broken.monthly = 2700;
broken.rates["EBPA Gold"] = { Employee: 500 };
const b = auditGroup({ g: broken, admin, split });
assert.equal(b.status, "fail");
assert.equal(b.checks.find((c) => c.key === "count").level, "fail");
assert.equal(b.checks.find((c) => c.key === "premium").level, "fail");
const rates = b.checks.find((c) => c.key === "rates");
assert.equal(rates.level, "warn");
assert.match(rates.detail, /EBPA Gold ES/);

// Rates that do not reproduce a plan's premium are off schedule.
const off = clean();
off.rates["EBPA Gold"] = { Employee: 450, "Employee + Spouse": 1100 };
assert.match(auditGroup({ g: off, admin, split }).checks.find((c) => c.key === "rates").detail, /EBPA Gold bills \$2,100 but its rates × enrolled give \$2,000/);

// A quote priced on a different headcount, or read with no rates, is flagged.
const q = auditGroup({ g: clean(), admin, split, proposals: [{ slot: "Gravie", carrier: "Gravie", enrolledOnDocument: 9, plans: [{ name: "A", rates: { EE: null, ES: null, EC: null, FAM: null } }] }] });
const qc = q.checks.find((c) => c.key === "quotes");
assert.equal(qc.level, "warn");
assert.match(qc.detail, /1 of 1 plans have no rates/);
assert.match(qc.detail, /priced on 9 enrolled; the group has 4/);

// The whole roster: live groups checked, the rest listed, worst first.
const all = auditData([
  { g: clean(), admin, split, proposals: quotes, billing, fundingMonth: "2026-09", manager: "Tracy Hayden" },
  { g: { ...big, name: "Big Roster" }, admin: { ...admin, sizeIsSet: false }, split, proposals: [], billing: null, fundingMonth: "2026-09", manager: "Debbie Bostic" },
  { g: { ...broken, name: "Broken" }, admin, split, manager: "Debbie Bostic" },
  { g: { ...clean(), name: "Gone", archived: true }, admin },
  { g: { ...clean(), name: "Outside", eligible: false, carriersSeen: ["Aetna"] }, admin },
]);
assert.deepEqual(all.rows.map((x) => x.name), ["Broken", "Big Roster", "Clean Co", "Gone", "Outside"]);
assert.deepEqual(all.counts, { checked: 3, ok: 1, warn: 1, fail: 1, skipped: 2 });
assert.equal(all.byCheck.roster.warn, 1);
assert.equal(all.byCheck.count.fail, 1);
assert.match(all.headline, /1 of 3 groups in order; 1 with a problem, 1 to look at\. Most often:/);
assert.equal(all.rows.find((x) => x.name === "Outside").status, "skip");
assert.match(auditData([{ g: clean(), admin, split, proposals: quotes, billing, fundingMonth: "2026-09", manager: "Tracy Hayden" }]).headline, /All 1 groups are in order/);

// No member is named in a result.
const blob = JSON.stringify(all);
for (const key of ['"first"', '"last"', '"spAges"', '"employerCost"']) assert.ok(!blob.includes(key), `no member field ${key} in the audit`);

// The assistant's briefing: enrolled counts, and no headcount to repeat.
const text = describeGroup({ group: { ...clean(), medicalEligible: 326, planTiers: {} }, proposals: [], funding: null, manager: { name: "Tracy Hayden" }, splits: {}, signup: null, renewal: "open" });
assert.ok(!/Active employees/.test(text), "the roster count is never in the briefing");
assert.ok(!/326/.test(text));
assert.match(text, /Enrolled in medical: 4 employees/);
assert.match(text, /no verified count of the company's total or benefit-eligible employees/);

console.log("data-audit: all assertions passed", { checks: CHECKS.length, headline: all.headline });
