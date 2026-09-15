// The 15 current plan designs: the assistant sees each of a group's current
// plans with its benefits and the whole catalogue for comparison; staff can
// read them and correct one, and the correction shows on the next read.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describeGroup } from "../server/assistant.js";

const data = JSON.parse(readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
assert.equal(Object.keys(data.planDesigns).length, 15, "fifteen current plan designs");

// A group on HealthEZ Saver HSA and Classic Silver: both designs come through by name.
const g = data.groups.find((x) => (x.plans || []).some((p) => /Saver HSA/.test(p.plan)));
assert.ok(g, "a group on Saver HSA");
const text = describeGroup({ group: { ...g, rates: {}, planTiers: {} }, proposals: [], funding: null, manager: null, splits: {}, signup: null, renewal: null, planDesigns: data.planDesigns });
assert.match(text, /Plan design \(Saver HSA\): Deductible: \$6,450; Out-of-Pocket Max: \$6,450/);
assert.match(text, /The 15 current plan designs Kennion offers today/);
assert.match(text, /- Deluxe Platinum: deductible \$100, out-of-pocket max \$3,000, PCP \$20/);
assert.match(text, /- Freedom Bronze: deductible \$8,550/);
assert.ok(!/Plan design \(Choice Gold\)/.test(text), "only the group's own plans get the full design line");

// Staff routes: read the catalogue, correct one plan, read it back.
const PORT = 5091;
const CODE = "designs-test-code";
const server = spawn("node", ["server/index.js"], { env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => server.kill();
process.on("exit", stop);
server.stderr.on("data", (d) => process.stderr.write(d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
assert.equal((await fetch(`${base}/api/admin/plan-designs`)).status, 401);
let list = await (await fetch(`${base}/api/admin/plan-designs`, { headers: auth })).json();
assert.equal(list.designs.length, 15);
assert.equal(list.designs.find((d) => d.planName === "Saver HSA").benefits.Deductible, "$6,450");
const fixed = await (await fetch(`${base}/api/admin/plan-designs/${encodeURIComponent("Saver HSA")}`, { method: "POST", headers: { ...json, ...auth }, body: JSON.stringify({ benefits: { ...list.designs.find((d) => d.planName === "Saver HSA").benefits, Deductible: "$6,500" } }) })).json();
assert.equal(fixed.benefits.Deductible, "$6,500");
list = await (await fetch(`${base}/api/admin/plan-designs`, { headers: auth })).json();
assert.equal(list.designs.find((d) => d.planName === "Saver HSA").benefits.Deductible, "$6,500", "the correction is what staff read back");
assert.equal((await fetch(`${base}/api/admin/plan-designs/${encodeURIComponent("Saver HSA")}`, { method: "POST", headers: { ...json, ...auth }, body: "{}" })).status, 400);

console.log("plan designs: 15 current plans, benefits in the assistant's figures, readable and correctable by staff — ok");
stop();
