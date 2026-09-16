// A proposal reading against the roster: the reader's own roster name when it
// gives one, the carrier's spelling of the employer when it does not, and the
// file name last — with anything ambiguous left unmatched.
import assert from "node:assert/strict";
import { matchRosterGroup, groupNamedIn, spacedOut } from "../server/proposal-match.js";

const roster = [
  "TPI Global Solutions, Inc.",
  "Johnson Storage & Moving Co. Holdings, LLC",
  "South Alabama Family Care, LLC",
  "South Alabama Medical Clinic, LLC",
  "Dixie MetalCraft Corporation",
].map((name) => ({ name }));
const m = (reading, filename = "quote.pdf", context = null) => matchRosterGroup(reading, roster, filename, context);

assert.deepEqual(
  m({ matched_group: "TPI Global Solutions, Inc.", group_name_on_document: "tpi Global Solutions, Inc." }),
  { name: "TPI Global Solutions, Inc.", how: "exact" },
  "the roster name verbatim",
);
assert.deepEqual(
  m({ matched_group: "tpi Global Solutions, Inc.", group_name_on_document: "tpi Global Solutions, Inc." }),
  { name: "TPI Global Solutions, Inc.", how: "normalized" },
  "the reader mirrored the paper's casing",
);
assert.deepEqual(
  m({ matched_group: "TPI Global Solutions", group_name_on_document: "tpi Global Solutions" }),
  { name: "TPI Global Solutions, Inc.", how: "normalized" },
  "legal form dropped",
);
assert.deepEqual(
  m({ matched_group: null, group_name_on_document: "tpi Global Solutions, Inc." }),
  { name: "TPI Global Solutions, Inc.", how: "document" },
  "no roster name from the reader; the employer on the paper identifies one group",
);
assert.deepEqual(
  m({ matched_group: null, group_name_on_document: "TPI Global" }),
  { name: "TPI Global Solutions, Inc.", how: "document" },
  "a short form whose words all sit in one roster name",
);
assert.deepEqual(
  m({ matched_group: null, group_name_on_document: null }, "01__01__2027_tpiGlobalSolutions,Inc._435483.pdf"),
  { name: "TPI Global Solutions, Inc.", how: "filename" },
  "Angle Health's file name, words run together",
);
assert.deepEqual(
  m({ matched_group: null, group_name_on_document: null }, "435483_tpiGlobalSolutions,Inc._AngleHealth_Scorecard.pdf"),
  { name: "TPI Global Solutions, Inc.", how: "filename" },
  "the scorecard's file name",
);
assert.deepEqual(
  m({ matched_group: null, group_name_on_document: null }, "quote.pdf", { subject: "Re: Kennion Captive-Angle", body: "Here is one of our better quotes!" }),
  null,
  "an email naming no group",
);
assert.deepEqual(
  m({ matched_group: null, group_name_on_document: "South Alabama" }, "South Alabama quote.pdf"),
  null,
  "two roster groups start the same way: unmatched",
);
assert.deepEqual(m({ matched_group: "Bostrom Seating, Inc.", group_name_on_document: "Bostrom Seating, Inc." }), null, "a company not on the roster");
assert.deepEqual(
  m({ matched_group: "Dixie MetalCraft Corporation", group_name_on_document: "Dixie Metalcraft Corp" }, "Dixie Metalcraft Corporation LF EXH Med 3.pdf"),
  { name: "Dixie MetalCraft Corporation", how: "exact" },
  "an exact roster name wins before any fallback",
);
assert.deepEqual(m(null), null, "no reading");

assert.equal(spacedOut("01__01__2027_tpiGlobalSolutions,Inc._435483"), "01 01 2027 tpi Global Solutions,Inc. 435483");
assert.equal(groupNamedIn("Johnson Storage & Moving Co Holdings renewal", roster), "Johnson Storage & Moving Co. Holdings, LLC");
assert.equal(groupNamedIn("TPI Global Solutions and South Alabama Family Care", roster), null, "two groups named: neither");

console.log("proposal match: all assertions passed");
