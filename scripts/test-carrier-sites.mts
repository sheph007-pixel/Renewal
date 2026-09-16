// The Carrier/TPA name links to the carrier's main website: every name the
// system uses resolves, and a name not on file gets no link rather than a
// wrong one.
import assert from "node:assert/strict";
import { websiteOf } from "../client/src/lib/carrier-sites.ts";

assert.equal(websiteOf("UnitedHealthcare"), "https://www.uhc.com/");
assert.equal(websiteOf("Surest (UnitedHealthcare)"), "https://www.surest.com/", "a legacy Surest row links to Surest");
assert.equal(websiteOf("Surest"), "https://www.surest.com/");
assert.equal(websiteOf("Gravie"), "https://www.gravie.com/");
assert.equal(websiteOf("Nationwide"), "https://www.nationwide.com/");
assert.equal(websiteOf("Angle Health"), "https://www.anglehealth.com/");
assert.equal(websiteOf("Cobalt"), "https://www.cobaltbenefitsgroup.com/");
assert.equal(websiteOf("HealthEZ"), "https://healthez.com/");
assert.equal(websiteOf("EBPA"), "https://www.ebpabenefits.com/");
assert.equal(websiteOf("BCBS of Alabama"), "https://www.bcbsal.org/");
assert.equal(websiteOf("Blue Cross Blue Shield of Alabama"), "https://www.bcbsal.org/");
assert.equal(websiteOf("Cigna"), "https://www.cigna.com/");
assert.equal(websiteOf("UnitedHealthcare Level Funded"), "https://www.uhc.com/", "a carrier with a qualifier");
assert.equal(websiteOf("Some New Carrier"), null, "not on file: no link");
assert.equal(websiteOf(""), null);
assert.equal(websiteOf(null), null);

console.log("carrier sites: all assertions passed");
