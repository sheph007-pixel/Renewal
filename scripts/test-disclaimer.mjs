// The notice is one text in two places (the client bundle and the server's
// files); this keeps them identical and free of the words the site avoids.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RATE_DISCLAIMER, ILLUSTRATIVE_QUOTE } from "../server/disclaimer.js";

const client = readFileSync("client/src/lib/model.ts", "utf8");
const m = client.match(/export const RATE_DISCLAIMER =\s*"([^"]+)";/);
assert.ok(m, "RATE_DISCLAIMER in client/src/lib/model.ts");
assert.equal(m[1], RATE_DISCLAIMER, "client and server notices differ");
assert.match(client, /export const ILLUSTRATIVE_QUOTE = "Illustrative Quote"/);
assert.equal(ILLUSTRATIVE_QUOTE, "Illustrative Quote");
for (const banned of ["Carrier Proposal", "Carrier Quote", "binding"]) {
  assert.ok(!RATE_DISCLAIMER.includes(banned), `notice says "${banned}"`);
}
assert.match(RATE_DISCLAIMER, /not an offer or a guarantee/);
assert.match(RATE_DISCLAIMER, /final only when coverage is offered by the Carrier\/TPA/);
console.log("ok - disclaimer: one text, both sides");
