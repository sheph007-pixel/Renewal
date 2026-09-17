// The 2027 Program Overview renders as a two-page PDF: the story, what
// stays the same and what is new, the two bills, next steps, FAQs and the
// team. No rates and no plan table: those live on BenSync.
import assert from "node:assert/strict";
import { renderChangesReport } from "../server/documents.js";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const plan = (optionId, name, ee) => ({ optionId, name, network: "Choice Plus", deductible: "$4,000", oopMax: "$8,000", rates: { EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 }, benefits: {} });
const group = { name: "Test Group, Inc.", enrolled: 5, monthly: 3200, tiers: { EE: 3, ES: 1, EC: 0, FAM: 1 }, plans: [{ plan: "Old PPO", enrolled: 5, monthly: 3200 }], pyEnd: "2026-12-31" };
const proposals = [
  { slot: "UHC Fully Insured", carrier: "UnitedHealthcare", plans: [plan("UH1", "Alt 1", 720), plan("UH2", "Alt 15", 690)] },
  { slot: "Gravie", carrier: "Gravie", plans: [plan("GR1", "Copay $500", 610)] },
];
const manager = { name: "Pat Example", title: "Account Manager", phone: "205-555-0100", email: "pat@example.com", calendly: "https://example.com" };
const broker = { name: "Hunter Shepherd", title: "President & Licensed Broker", phone: "205-555-0101", email: "hunter@example.com" };

const file = await renderChangesReport({ group, proposals, slots: ["UHC Fully Insured", "Gravie"], manager, broker, signup: null, assistant: true });
assert.equal(file.mime, "application/pdf");
assert.match(file.filename, /^Test Group Inc - 2027 Program Overview \d{4}-\d{2}-\d{2}\.pdf$/);
const pdf = await pdfParse(file.data);
assert.equal(pdf.numpages, 2, `expected 2 pages, got ${pdf.numpages}`);
const text = pdf.text.replace(/\s+/g, " ");
for (const phrase of [
  "Good news: the Kennion Program is growing.",
  "runs through December 31, 2026",
  "3 medical plan options from 2 national carriers and program partners: UnitedHealthcare and Gravie.",
  "Two Bills, One Team",
  "From Your Medical Carrier/TPA",
  "Questions We Hear Most",
  "Will we receive more than one bill?",
  "Pat Example",
  "BenSync AI Assistant",
  "The bottom line: more options from major national programs",
  "We help you build the right strategy. Then we handle the rest.",
]) assert.ok(text.includes(phrase), `missing: ${phrase}`);
for (const banned of ["$720", "$3,200", "Vs Today", "Market Review In Progress"]) assert.ok(!text.includes(banned), `should not say: ${banned}`);

// With nothing quoted yet the document still stands, and still fits two pages.
const empty = await renderChangesReport({ group: { ...group, plans: [] }, proposals: [], slots: [], manager: null, broker, signup: { submitted_at: "2026-10-02T15:00:00Z" }, assistant: false });
const t2 = await pdfParse(empty.data);
assert.equal(t2.numpages, 2);
assert.ok(t2.text.includes("You submitted your plan choices on October 2."));
console.log("ok - changes report: two pages, the story, two bills, FAQs, the team");
