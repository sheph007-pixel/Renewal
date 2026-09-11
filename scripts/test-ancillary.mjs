// The ancillary rule, including a reading made before the question existed:
// what Claude said wins; otherwise the document decides; otherwise no verdict.
import assert from "node:assert/strict";
import { isAncillaryRow, medicalFromDocument } from "../server/proposal-kind.js";

const rates = { EE: 700, ES: 1400, EC: 1295, FAM: 1995 };

// Said outright, either way.
assert.equal(isAncillaryRow({ filename: "x.pdf", extracted: { quotes_medical: false } }), true);
assert.equal(isAncillaryRow({ filename: "ancillary.pdf", extracted: { quotes_medical: true } }), false, "what Claude says wins over the filename");

// Read before the question existed: the document is the evidence.
assert.equal(
  medicalFromDocument({
    filename: "Lioce Group - Default Ancillary Proposal.pdf",
    summary: "Basic Life/AD&D, dental and vision. No medical coverage is quoted here.",
    extracted: { plans: [] },
  }),
  false,
  "names itself ancillary",
);
assert.equal(
  medicalFromDocument({
    filename: "Group - Dental and Vision.pdf",
    summary: "Two passive PPO dental options and two vision options.",
    extracted: { plans: [{ name: "Dental PPO", rates: {} }] },
  }),
  false,
  "only ancillary products, no rated plan",
);
assert.equal(
  medicalFromDocument({
    filename: "UHC Proposal.pdf",
    summary: "Dental PPO and vision options with rates.",
    extracted: { plans: [{ name: "Dental PPO High", rates }, { name: "Vision Plan A", rates: { EE: 8, ES: 15, EC: 14, FAM: 22 } }] },
  }),
  false,
  "rated dental and vision plans are still ancillary — rates alone do not make a medical quote",
);
assert.equal(
  medicalFromDocument({
    filename: "The Lioce Group _Fully Insured EXB Med 3.pdf",
    summary: "Seven Insurance Choice+ plan options priced on 44 enrolled employees, plus dental riders.",
    extracted: { plans: [{ name: "Choice Plus 1000", rates }] },
  }),
  true,
  "a medical quote that mentions dental is still medical",
);
assert.equal(
  medicalFromDocument({
    filename: "quote.pdf",
    summary: "",
    extracted: { plans: [{ name: "Option 2", deductible: "$3,000", oop_max: "$6,000", rates }] },
  }),
  true,
  "a deductible on a plan says medical whatever it is called",
);
assert.equal(
  medicalFromDocument({ filename: "quote.pdf", summary: "Rates unreadable.", extracted: { plans: [] } }),
  null,
  "an unreadable document gets no verdict",
);
assert.equal(isAncillaryRow({ filename: "quote.pdf", summary: "Rates unreadable.", extracted: { plans: [] } }), false, "and is not called ancillary");
assert.equal(isAncillaryRow({ filename: "x.pdf", extracted: null }), false, "nothing read yet: no verdict");

console.log("ancillary: all assertions passed");
