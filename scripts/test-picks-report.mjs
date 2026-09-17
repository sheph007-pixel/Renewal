// The AI Picks report renders as a PDF from a stored record: pages, the
// census, each pick with its reason, the bills side by side.
import assert from "node:assert/strict";
import { renderPicksReport } from "../server/documents.js";

const plan = (optionId, name, ee, extra = {}) => ({ optionId, name, network: "Choice Plus", deductible: "$8,000 individual / $16,000 family", oopMax: "$8,000 individual / $16,000 family", rates: { EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 }, benefits: {}, ...extra });
const group = {
  name: "Test Group, Inc.",
  enrolled: 5,
  monthly: 3200,
  tiers: { EE: 3, ES: 1, EC: 0, FAM: 1 },
  plans: [{ plan: "Old PPO", enrolled: 5, monthly: 3200 }],
  rates: { "Old PPO": { Employee: 600, "Employee + Spouse": 1200, "Employee + Child(ren)": 1080, "Employee + Family": 1800 } },
  planTiers: { "Old PPO": { EE: 3, ES: 1, EC: 0, FAM: 1 } },
  census: { employees: 5, average: 41, median: 39, youngest: 24, oldest: 61, spread: "wide", bands: { under30: 1, from30to44: 2, from45to54: 1, from55: 1 }, spouses: 2, withChildren: 1, children: 2 },
};
const proposals = [
  { slot: "UHC Fully Insured", carrier: "UnitedHealthcare", plans: [plan("UH1", "Alt 1 EZ2Q", 720), plan("UH2", "Alt 15 EZ4C", 690)] },
  { slot: "UHC Level Funded", carrier: "UnitedHealthcare", plans: [plan("UH3", "P4000i8021B", 640), plan("UH4", "P3500", 655), plan("UH5", "P6000", 590)] },
  { slot: "Gravie", carrier: "Gravie", plans: [plan("GR1", "Gravie Copay $500", 610, { network: "Cigna OAP (PPO)" })] },
];
const recommendations = {
  summary: "A young, spread-out group; the level funded quotes carry the value.",
  startWith: "UH3",
  startWithReason: "Balanced deductible for the ages on file at a bill below today.",
  createdAt: "2026-09-17T02:00:00.000Z",
  picks: [
    { carrier: "UnitedHealthcare", funding: "Fully Insured", slot: "UHC Fully Insured", tier: "lower_cost", optionId: "UH2", plan: "Alt 15 EZ4C", reason: "Lowest fully insured bill." },
    { carrier: "UnitedHealthcare", funding: "Fully Insured", slot: "UHC Fully Insured", tier: "richer_benefits", optionId: "UH1", plan: "Alt 1 EZ2Q", reason: "Richest fully insured design." },
    { carrier: "UnitedHealthcare", funding: "Level Funded", slot: "UHC Level Funded", tier: "lower_cost", optionId: "UH5", plan: "P6000", reason: "Lowest bill on file." },
    { carrier: "UnitedHealthcare", funding: "Level Funded", slot: "UHC Level Funded", tier: "best_fit", optionId: "UH3", plan: "P4000i8021B", reason: "Balanced for the ages on file." },
    { carrier: "UnitedHealthcare", funding: "Level Funded", slot: "UHC Level Funded", tier: "richer_benefits", optionId: "UH4", plan: "P3500", reason: "Lowest deductible in the lineup." },
    { carrier: "Gravie", funding: "Level Funded", slot: "Gravie", tier: "best_fit", optionId: "GR1", plan: "Gravie Copay $500", reason: "Copay design suits the families." },
  ],
};

const file = await renderPicksReport({ group, proposals, recommendations, contribution: { EE: 300, ES: 300, EC: 300, FAM: 300 } });
assert.equal(file.mime, "application/pdf");
assert.match(file.filename, /^Test Group Inc - AI Picks \d{4}-\d{2}-\d{2}\.pdf$/);
assert.ok(file.data.length > 4000, `pdf is ${file.data.length} bytes`);
assert.equal(file.data.subarray(0, 5).toString(), "%PDF-");
const pages = (file.data.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
assert.ok(pages >= 1 && pages <= 4, `${pages} pages`);

// Without a census or contribution it still renders, on enrollment alone.
const bare = await renderPicksReport({ group: { ...group, census: null }, proposals, recommendations, contribution: null });
assert.equal(bare.data.subarray(0, 5).toString(), "%PDF-");

console.log(`ok - picks report: ${file.data.length} bytes, ${pages} page(s)`);
