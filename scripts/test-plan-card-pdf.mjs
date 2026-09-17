// One plan's card as a PDF, from the card the page sends.
import assert from "node:assert/strict";
import { renderPlanCardPdf } from "../server/documents.js";

const card = {
  title: "Gravie Option GR25", subtitle: "Gravie HDHP $9,100 Ded/$9,100 OOPM", carrier: "Gravie", funding: "Level Funded", type: "HDHP",
  headline: { average: 354.43, companyPays: 8784, basis: "Illustrative Quote" },
  benefits: [["Deductible", "$9,100", null], ["Out-of-pocket max", "$9,100", null], ["Doctor visit", "No cost after ded", null], ["Prescription drugs", "No cost after ded generic · No cost after ded preferred brand · No cost after ded non-preferred", null], ["Network type", "PPO", null], ["Network", "Cigna", "https://example.com/find"], ["Pharmacy (PBM)", "Express Scripts", "https://example.com/formulary"]],
  tiers: [{ label: "Employee Only", count: 37, rate: 427.64, er: 183, ee: 244.64 }, { label: "Employee + Spouse", count: 3, rate: 883.06, er: 183, ee: 700.06 }, { label: "Employee + Children", count: 5, rate: 720.41, er: 183, ee: 537.41 }, { label: "Employee + Family", count: 3, rate: 1240.9, er: 183, ee: 1057.9 }],
  totals: { er: 8784, ee: 17012.61, premium: 25796.61, enrolled: 48 },
  audit: "Proposal audit completed Sep 14, 2026: the name, benefits and rates were checked against the carrier's own quote.",
};
const file = await renderPlanCardPdf({ group: { name: "TPI Global Solutions, Inc." }, card });
assert.equal(file.mime, "application/pdf");
assert.match(file.filename, /^TPI Global Solutions Inc - Gravie Option GR25 \d{4}-\d{2}-\d{2}\.pdf$/);
assert.equal(file.data.subarray(0, 5).toString(), "%PDF-");
const pages = (file.data.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
assert.equal(pages, 1, `${pages} pages: a card is one page`);
console.log("ok - plan card pdf:", file.data.length, "bytes");
import("node:fs").then((fs) => process.env.OUT && fs.writeFileSync(process.env.OUT, file.data));
