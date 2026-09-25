// One printed plan name on two different carrier plan codes, end to end:
// validation flags it (never merged, never shown twice silently), the
// steward checks the names against the document once, then hands it to a
// person (NEEDS_REVIEW, naming the name and the codes). Staff confirm the
// carrier really uses one name for both; the two plans stay separate
// records with their own BenSync IDs and the box goes on to Verified.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GROUP = "Johnson Storage & Moving Co. Holdings, LLC";
const SLOT = "UHC Level Funded";
const plan = (code, ee, page) => ({
  name: "Choice Plus 1000",
  plan_code: code,
  network: "Choice Plus",
  plan_type: "PPO",
  deductible: "$1,000",
  oop_max: "$5,000",
  benefits: { doctor_visit: "$30", specialist: "$60", imaging: "", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10 / $40 / $80", coinsurance: "20%", hsa_eligible: "no" },
  rates: { EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 },
  monthly_total: null,
  source: { identity: [page], benefits: [page], rates: [page + 10], sheet: "", rows: "", appearances: 2, codes: [code] },
});
const seed = path.join(mkdtempSync(path.join(tmpdir(), "shared-names-")), "seed.json");
writeFileSync(seed, JSON.stringify([{
  group_name: GROUP,
  slot: SLOT,
  carrier: "UnitedHealthcare",
  size: 1000,
  source_sha: "sha-shared",
  extracted: {
    carrier: "UnitedHealthcare",
    funding: "level funded",
    quotes_medical: true,
    matched_group: GROUP,
    confidence: 0.95,
    plans: [plan("P1000A", 600, 3), plan("P1000B", 600, 4)],
    reconciliation: { plan_appearances: 4, unique_plans: 2, unique_ppo: 2, unique_epo: 0, expected: 2, reader_unique_plans: 2 },
    extraction: { sourceSha: "sha-shared" },
  },
}]));

const PORT = 5095;
const CODE = "shared-names-code";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "", KENNION_SEED_PROPOSALS: seed },
  stdio: ["ignore", "pipe", "pipe"],
});
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
const cellNow = async () => {
  const v = await (await fetch(`${base}/api/admin/proposals/verify`, { headers: auth })).json();
  return v.groups.find((g) => g.group === GROUP).cells.find((c) => c.slot === SLOT);
};
const until = async (ok, what) => {
  let c;
  for (let i = 0; i < 120; i++) {
    c = await cellNow();
    if (ok(c)) return c;
    await wait(250);
  }
  throw new Error(`${what} never happened: ${JSON.stringify(c && { state: c.state, failedAt: c.failedAt, fix: c.fix, stuck: c.stuck, steps: c.steps })}`);
};

// Flagged, one check against the document, then handed to a person.
let c = await until((x) => x.state === "stuck", "handing it to a person");
assert.equal(c.failedAt, "validation");
assert.equal(c.fix, "review");
assert.equal(c.stage, "NEEDS_REVIEW");
assert.match(c.stuck, /"Choice Plus 1000" is on 2 different plan codes \(P1000A, P1000B\)/);
const names = c.steps.validation.checks.find((k) => k.key === "names");
assert.equal(names.ok, false);
assert.equal(c.counts.stored, 2, "both plans stay stored - nothing merged");

// Staff confirm: the plans stay separate, with their own IDs, and the box is Verified.
const r = await fetch(`${base}/api/admin/proposals/${c.proposalId}/confirm-shared-names`, { method: "POST", headers: auth });
const text = await r.text();
assert.equal(r.status, 200, text);
const body = JSON.parse(text);
assert.deepEqual(body.confirmed.map((x) => [x.name, x.codes]), [["Choice Plus 1000", ["P1000A", "P1000B"]]]);
assert.equal(body.confirmed[0].by, "hunter@kennion.com");
c = await until((x) => x.state === "verified", "Verified after the confirmation");
const rows = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals;
const row = rows.find((x) => x.id === c.proposalId);
assert.deepEqual(row.extracted.plans.map((p) => `${p.option_id}:${p.plan_code}`), ["UH1:P1000A", "UH2:P1000B"], "two carrier plans, two canonical records, two BenSync IDs");
assert.equal((await fetch(`${base}/api/admin/proposals/${c.proposalId}/confirm-shared-names`, { method: "POST" })).status, 401, "staff only");

console.log("shared names: one printed name on two plan codes is flagged, checked once against the document, confirmed by a person, and kept as two plans - ok");
stop();
