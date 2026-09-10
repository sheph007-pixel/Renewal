// The short name on an Employee Navigator invoice against the roster's legal
// names: what must match, and what must stay unmatched rather than be filed
// under the wrong company.
import assert from "node:assert/strict";
import { matchInvoiceName } from "../server/invoice-parse.js";
import { normalizeName } from "../server/group-id.js";

const roster = [
  "Ashley Mac's Holdings, LLC",
  "Ursa Logistics, LLC",
  "R.E. Garrison Corporate",
  "R.E. Garrison Trucking 1099",
  "Taz Charleston LLC",
  "Taz Panama City, Inc.",
  "Taziki's Franchise Group, LLC",
  "South Alabama Family Care, LLC",
  "South Alabama Medical Clinic, LLC",
  "The Lioce Group",
  "Worth Industries, Inc.",
];
const m = (name) => matchInvoiceName(name, roster, normalizeName);

assert.equal(m("Worth Industries, Inc."), "Worth Industries, Inc.", "an exact name");
assert.equal(m("Worth Industries"), "Worth Industries, Inc.", "legal form dropped");
assert.equal(m("Ashley Mac's"), "Ashley Mac's Holdings, LLC", "the file's words all in one roster name");
assert.equal(m("R E Garrison - 1099"), "R.E. Garrison Trucking 1099", "R E and R.E. agree; 1099 picks the entity");
assert.equal(m("R E Garrison Corp"), "R.E. Garrison Corporate", "the closer of two supersets");
assert.equal(m("Ursa Group"), "Ursa Logistics, LLC", "a distinctive first word nobody else starts with");
assert.equal(m("Taziki's"), "Taziki's Franchise Group, LLC", "an apostrophe-s first word");
assert.equal(m("Taz Charleston LLC"), "Taz Charleston LLC", "Taz stays exact, not Taziki's");
assert.equal(m("South Alabama"), null, "two groups start the same way: unmatched");
assert.equal(m("The Group"), null, "generic words match nothing");
assert.equal(m("Bostrom Seating, Inc"), null, "a company not on the roster");
assert.equal(m(""), null, "nothing");

console.log("invoice match: all assertions passed");
