// A re-read that finds more plans than the reading it replaces: the plans
// that were there before take their old numbers back (previous_plan_ids),
// and the new ones get numbers of their own - never one a surviving plan
// is taking back. (A Gravie workbook re-read on both sheets once handed its
// 67 new EPO plans GR1-GR67 again, on top of the PPO designs holding them.)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GROUP = "Johnson Storage & Moving Co. Holdings, LLC";
const plan = (name, network, ee) => ({ name, plan_code: null, network, plan_type: "PPO", deductible: "$3,000", oop_max: "$6,000", benefits: {}, rates: { EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 }, monthly_total: null });
const seed = path.join(mkdtempSync(path.join(tmpdir(), "ids-reread-")), "seed.json");
writeFileSync(seed, JSON.stringify([{
  group_name: GROUP,
  slot: "Gravie",
  carrier: "Gravie",
  extracted: {
    carrier: "Gravie",
    funding: "level funded",
    quotes_medical: true,
    matched_group: GROUP,
    confidence: 1,
    plans: [
      plan("Gravie Copay 1500 EPO", "Cigna OAP (EPO)", 590),
      plan("Gravie Copay 2500 EPO", "Cigna OAP (EPO)", 560),
      plan("Gravie Copay 1500", "Cigna OAP (PPO)", 610),
      plan("Gravie Copay 2500", "Cigna OAP (PPO)", 580),
    ],
    // The reading this one replaced: the PPO designs only, GR1 and GR2.
    previous_plan_ids: [{ option_id: "GR1", plan_code: null, name: "Gravie Copay 1500" }, { option_id: "GR2", plan_code: null, name: "Gravie Copay 2500" }],
  },
}]));

const PORT = 5093;
const CODE = "ids-reread-code";
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
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
let ids = [];
for (let i = 0; i < 40; i++) {
  const rows = (await (await fetch(`${base}/api/admin/proposals`, { headers: { Authorization: `Bearer ${staff.token}` } })).json()).proposals || [];
  const row = rows.find((r) => r.group_name === GROUP && r.slot === "Gravie");
  ids = row ? row.extracted.plans.map((p) => `${p.option_id}:${p.name}`) : [];
  if (ids.length && ids.every((s) => !s.startsWith("undefined") && !s.startsWith("null"))) break;
  await new Promise((r) => setTimeout(r, 250));
}
assert.deepEqual(
  ids,
  ["GR3:Gravie Copay 1500 EPO", "GR4:Gravie Copay 2500 EPO", "GR1:Gravie Copay 1500", "GR2:Gravie Copay 2500"],
  "the PPO designs keep GR1 and GR2; the new EPO plans get GR3 and GR4, not GR1 and GR2 again",
);
console.log("option ids on a re-read with more plans: surviving plans keep their numbers, new plans never take one of them - ok");
stop();
