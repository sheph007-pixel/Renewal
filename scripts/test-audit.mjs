// The audit that runs itself: carriers on the report's basis, a carrier named
// twice read as one, billing against the XML, and the verdict line.
import assert from "node:assert/strict";
import { reconcileCarriers, reconcileBilling, runAudit, auditFingerprint } from "../server/audit.js";

const groups = [
  { name: "C", archived: false, eligible: true, enrolled: 12, groupHealthEnrolled: 4, medicalMonthly: 9000, groupHealthMonthly: 2000, totalMonthly: 9000,
    plans: [{ plan: "Blue Secure", program: "BCBS-AL", groupHealth: false, enrolled: 8, monthly: 7000 }, { plan: "EBPA Silver", program: "EBPA", groupHealth: true, enrolled: 4, monthly: 2000 }], lines: [], carrierHeads: null },
  { name: "A", archived: false, eligible: true, enrolled: 10, groupHealthEnrolled: 10, medicalMonthly: 5000, groupHealthMonthly: 5000, totalMonthly: 5300,
    plans: [{ plan: "EBPA Gold", program: "EBPA", groupHealth: true, enrolled: 10, monthly: 5000 }],
    lines: [{ benefit: "Dental", carrier: "Guardian", plan: "Dental", enrolled: 9, monthly: 300 }],
    carrierHeads: { EBPA: 10, Guardian: 9 } },
  { name: "B", archived: true, eligible: true, enrolled: 2, medicalMonthly: 1000, groupHealthMonthly: 0, totalMonthly: 1000,
    plans: [{ plan: "Blue Secure", program: "BCBS-AL", groupHealth: false, enrolled: 2, monthly: 1000 }], lines: [], carrierHeads: { "Blue Cross Blue Shield of Alabama": 2 } },
];
const stats = { filename: "cs.xls", uploadedAt: "2026-09-03T10:00:00Z", reportDate: "2026-09-02", rows: [
  { carrier: "EBPA", eligible: 20, enrolled: 14, companies: 2, plans: 2, employeeCosts: 0, planCosts: 7000 },
  { carrier: "Blue Cross Blue Shield", eligible: 0, enrolled: 0, companies: 1, plans: 0, employeeCosts: 0, planCosts: 0 },
  { carrier: "Blue Cross Blue Shield of Alabama", eligible: 4, enrolled: 10, companies: 2, plans: 2, employeeCosts: 0, planCosts: 8000 },
  { carrier: "Guardian", eligible: 20, enrolled: 9, companies: 1, plans: 1, employeeCosts: 0, planCosts: 400 },
  { carrier: "Flores & Associates", eligible: 5, enrolled: 3, companies: 1, plans: 1, employeeCosts: 0, planCosts: 0 },
] };

const rows = reconcileCarriers(stats, groups);
assert.equal(rows.length, 4, "the two Blue Cross rows are one");
const bcbs = rows.find((r) => r.carrier === "Blue Cross Blue Shield of Alabama");
assert.equal(bcbs.report.companies, 3);
assert.equal(bcbs.portal.monthly, 8000, "archived group counted, as the report counts it");
assert.equal(bcbs.portal.archivedMonthly, 1000);
assert.equal(bcbs.ok, true);
const guardian = rows.find((r) => r.carrier === "Guardian");
assert.equal(guardian.pct, -25);
assert.equal(guardian.ok, false, "dollars off by more than 1% and $50 is a mismatch");
assert.equal(rows.find((r) => r.carrier === "Flores & Associates").service, true);
assert.equal(rows.find((r) => r.carrier === "EBPA").ok, true);

const funding = { filename: "f.xlsx", uploadedAt: "2026-09-03T11:00:00Z", month: "2026-09",
  byInvoice: { 1: { group: "A" }, 2: { group: null }, 3: { group: "C" } },
  summary: { A: { medical: { participants: 10, monthly: 5010 } }, C: { medical: { participants: 4, monthly: 2000 } } } };
const billing = reconcileBilling(funding, groups);
assert.equal(billing.groups, 2, "archived groups are not billed against");
assert.equal(billing.matches, 2, "$10 on $5,000 is within range, and a Blue Cross group is judged on its captive plans only");
assert.equal(billing.coverage.live, 7010, "billing filed under groups the portal shows");
assert.equal(billing.coverage.archived, 0);
assert.equal(billing.coverage.unfiled, 0, "the unfiled invoice has no lines in this fixture");
assert.equal(billing.coverage.total, 7010);
assert.equal(billing.unassigned, 1);

const lastImport = { filename: "x.xml", uploaded_at: "2026-09-03T09:00:00Z", companies_applied: 3 };
const a = runAudit({ groups, carrierStats: stats, funding, lastImport });
assert.equal(a.complete, true);
assert.equal(a.verdict.kind, "warn");
assert.match(a.verdict.headline, /2 of 3 carriers match Employee Navigator; Guardian -25% to check · every group bills what the XML says · 1 invoice still needs a group\./);
assert.equal(a.portal.enrolled, 22, "live groups only");
const b = runAudit({ groups, carrierStats: null, funding: null, lastImport });
assert.equal(b.complete, false);
assert.match(b.verdict.headline, /Waiting on the carrier stats report and the funding workbook/);
assert.equal(runAudit({ groups, carrierStats: stats, funding, lastImport: null }).verdict.headline, "Nothing to audit yet - the XML export comes first.");
assert.notEqual(auditFingerprint({ carrierStats: stats, funding, lastImport }), auditFingerprint({ carrierStats: stats, funding: { ...funding, byInvoice: { ...funding.byInvoice, 2: { group: "A" } } }, lastImport }), "filing an invoice changes the fingerprint");

console.log("audit: all assertions passed", { carriers: rows.length, headline: a.verdict.headline });
