// The data check, group by group: a clean group passes every check, a
// roster many times the enrolled figure is flagged and never repeated, and
// the assistant's briefing no longer carries a headcount at all.
// Run with: node scripts/test-data-audit.mjs
import assert from "node:assert/strict";
import { auditGroup, auditData, rosterHeadcount, compareToExport, CHECKS } from "../server/data-audit.js";
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

// The month's billing, plan by plan and tier by tier against the census and
// the XML's rates: a head more or less is timing; a different rate, a plan
// billed that the XML does not carry, or a tier two people out is flagged.
const billedClean = { medical: { participants: 4, monthly: 2600, byPlan: {
  "EBPA Gold": { lines: 3, monthly: 2100, byTier: { Employee: { n: 2, rate: 500 }, "Employee + Spouse": { n: 1, rate: 1100 } } },
  "EBPA Silver": { lines: 1, monthly: 500, byTier: { "Employee + Family": { n: 1, rate: 500 } } },
} } };
const bc = auditGroup({ g: clean(), admin, split, billing: billedClean, fundingMonth: "2026-09" }).checks.find((c) => c.key === "billing");
assert.equal(bc.level, "ok", bc.detail);
assert.match(bc.detail, /3 tiers checked/);
const billedOff = { medical: { participants: 4, monthly: 2615, byPlan: {
  "EBPA Gold": { lines: 3, monthly: 2115, byTier: { Employee: { n: 2, rate: 500 }, "Employee + Spouse": { n: 1, rate: 1115 } } },
  "EBPA Silver": { lines: 1, monthly: 500, byTier: { "Employee + Family": { n: 3, rate: 500 } } },
  "EBPA Bronze": { lines: 2, monthly: 800, byTier: { Employee: { n: 2, rate: 400 } } },
} } };
const bo = auditGroup({ g: clean(), admin, split, billing: billedOff, fundingMonth: "2026-09" }).checks.find((c) => c.key === "billing");
assert.equal(bo.level, "warn");
assert.match(bo.detail, /EBPA Gold ES: billed at \$1,115\.00, the XML's rate is \$1,100\.00/);
assert.match(bo.detail, /EBPA Silver FAM: 3 billed, 1 in the XML/);
assert.match(bo.detail, /Billed but not in this group's XML: EBPA Bronze \(2 billed\)/);

// The plans a client is shown are every quoted plan: EPO plans and a Gravie
// quote of any size are not problems.
{
  const gravie = (n, epo = 0) => ({ slot: "Gravie", carrier: "Gravie", enrolledOnDocument: 4, plans: [
    ...Array.from({ length: n }, (_, i) => ({ name: `Gravie Copay ${i} PPO`, network: "Cigna Open Access Plus (PPO)", rates: { EE: 500, ES: 900, EC: 800, FAM: 1300 } })),
    ...Array.from({ length: epo }, (_, i) => ({ name: `Gravie Copay ${i} EPO`, network: "Cigna Open Access Plus (EPO)", planType: "EPO", rates: { EE: 480, ES: 880, EC: 780, FAM: 1280 } })),
  ] });
  for (const q of [gravie(67), gravie(60), gravie(67, 67)]) {
    const c = auditGroup({ g: clean(), admin, split, proposals: [q] }).checks.find((k) => k.key === "quotes");
    assert.equal(c.level, "ok", c.detail);
  }
}

// The stored export re-read against the portal: exact matches, drift named
// field by field, companies on one side only.
const exportOf = (g, patch = {}) => ({ group: { name: g.name, enrolled: g.enrolled, monthly: g.monthly, lives: g.lives, plans: g.plans.map((p) => ({ plan: p.plan, enrolled: p.enrolled, monthly: p.monthly })), lines: g.lines, ...patch } });
const portal = [clean(), { ...clean(), name: "Drifted" }, { ...clean(), name: "Left", archived: false, eligible: true }, { ...clean(), name: "Gone", archived: true }];
const match = (name) => portal.find((g) => g.name === name) || null;
const cmp = compareToExport(
  [exportOf(portal[0]), exportOf(portal[1], { enrolled: 5, monthly: 3100, plans: [{ plan: "EBPA Gold", enrolled: 4, monthly: 2600 }, { plan: "EBPA Silver", enrolled: 1, monthly: 500 }] }), exportOf({ ...clean(), name: "Brand New" })],
  portal,
  match,
);
assert.equal(cmp.companies, 3);
assert.equal(cmp.matched, 1);
assert.deepEqual(cmp.differ.map((d) => d.name), ["Drifted"]);
assert.match(cmp.differ[0].fields.join(" | "), /enrolled 4 in the portal, 5 in the export/);
assert.match(cmp.differ[0].fields.join(" | "), /EBPA Gold: 3 at \$2,100 in the portal, 4 at \$2,600 in the export/);
assert.deepEqual(cmp.missingFromPortal.map((m) => m.name), ["Brand New"]);
assert.deepEqual(cmp.notInFile.map((m) => m.name), ["Left"], "archived groups are not expected in the file");

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
