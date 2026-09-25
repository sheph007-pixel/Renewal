// The four-step check behind the Proposals grid (server/proposal-verify.js),
// and the rule that a newer upload which has not read never replaces one
// that has - the Boss Logistics UHC Level Funded case, where a re-upload that
// failed to read deleted the good reading and emptied the slot.
// Runs with `node --experimental-strip-types`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { gridCounts, verifyProposals } from "../server/proposal-verify.js";
import { proposalPlans, type KennionData, type Group, type GroupProposal } from "../client/src/lib/model.ts";

// --- The check's count is the client's count --------------------------------
const tiers = { EE: 5, ES: 2, EC: 0, FAM: 1 };
const plans = [
  { name: "Choice Plus 1000", rates: { EE: 600, ES: 1200, EC: 1100, FAM: 1700 } },
  { name: "Choice Plus 1000", rates: { EE: 600, ES: 1200, EC: 1100, FAM: 1700 } }, // printed twice on the quote
  { name: "Choice Plus 2000", rates: { EE: 500, ES: null, EC: 900, FAM: 1500 } }, // no ES rate, and ES has people
  { name: "Choice Plus 3000", rates: { EE: 450, ES: 900, EC: null, FAM: 1300 } }, // no EC rate, but EC is empty
  { name: "Unpriced", rates: { EE: null, ES: null, EC: null, FAM: null } },
];
const counts = gridCounts(plans, "UHC Level Funded", tiers);
assert.equal(counts.shown, 2);
assert.equal(counts.repeats, 1);
assert.deepEqual(counts.unpriced, ["Choice Plus 2000", "Unpriced"]);
const pr = { id: 1, slot: "UHC Level Funded", carrier: "UnitedHealthcare", plans: plans.map((p) => ({ ...p, planType: "PPO" })), uploadedAt: "2026-09-01" } as unknown as GroupProposal;
const g = { name: "X", tiers } as unknown as Group;
assert.equal(proposalPlans({ proposals: [pr] } as unknown as KennionData, g).length, counts.shown, "the check counts exactly the plans the client's grid shows");

// --- The four steps, pure ---------------------------------------------------
const isEpoPlan = (pl: { name?: string }) => /\bEPO\b/.test(pl.name || "");
const isBlankPlan = (pl: { name?: string }) => !pl || !pl.name;
const good = {
  id: 10,
  group_name: "Acme",
  slot: "Gravie",
  status: "assigned",
  superseded_by: null,
  filename: "acme gravie.pdf",
  extracted: { plans: [{ name: "Copay 1500 PPO", option_id: "GR1", rates: { EE: 1, ES: 2, EC: 3, FAM: 4 } }, { name: "Copay 1500 EPO", rates: { EE: 1, ES: 2, EC: 3, FAM: 4 } }] },
  audit: { status: "pass", completedAt: "2026-09-25T00:00:00Z", mismatches: [] },
};
const served = (rows: typeof good[]) => () => rows.map((r) => ({ id: r.id, slot: r.slot, plans: r.extracted.plans.filter((p) => !isEpoPlan(p)).map((p) => ({ name: p.name, optionId: p.option_id, rates: p.rates })) }));
const run = (rows: unknown[], srv: () => unknown[]) =>
  verifyProposals({ groups: [{ name: "Acme", slots: ["Gravie", "Nationwide"], tiers: { EE: 1, ES: 1, EC: 1, FAM: 1 } }], rows, served: srv, isEpoPlan, isBlankPlan });

let v = run([good], served([good]));
let cell = v.groups[0].cells.find((c: { slot: string }) => c.slot === "Gravie");
assert.equal(cell.state, "verified", JSON.stringify(cell.steps));
assert.equal(cell.plans, 1, "the EPO twin is never counted");
assert.equal(v.groups[0].cells.find((c: { slot: string }) => c.slot === "Nationwide").state, "missing");
assert.deepEqual(v.totals, { filed: 1, verified: 1, working: 0, failing: 0, byStep: { read: 0, audited: 0, loaded: 0 } });

v = run([{ ...good, audit: null }], served([good]));
cell = v.groups[0].cells[0];
assert.equal(cell.state, "fail");
assert.equal(cell.failedAt, "audited");
assert.equal(cell.fix, "audit");

v = run([{ ...good, audit: { status: "issues", completedAt: "x", mismatches: [{ plan: "Copay 1500 PPO", field: "EE", stored: "1", onDocument: "2", by: "Claude" }] } }], served([good]));
assert.equal(v.groups[0].cells[0].fix, "read", "an audit that found something is fixed by reading again");

// Served to the group short of what is stored: loaded fails.
v = run([good], () => [{ id: 10, slot: "Gravie", plans: [] }]);
assert.equal(v.groups[0].cells[0].failedAt, "loaded");

// A newer upload that failed to read, waiting beside the good one.
const failed = { ...good, id: 11, extracted: null, audit: null, error: "This proposal is longer than one reading can hold", filename: "acme gravie v2.pdf" };
v = run([failed, good], served([good]));
cell = v.groups[0].cells[0];
assert.equal(cell.proposalId, 10, "the good reading stays in force");
assert.equal(cell.state, "fail");
assert.equal(cell.failedAt, "read");
assert.equal(cell.fix, "read-waiting");
assert.equal(cell.fixId, 11);
assert.equal(cell.waiting.length, 1);

// Only a failed upload in the slot: nothing in force.
v = run([failed], () => []);
cell = v.groups[0].cells[0];
assert.equal(cell.proposalId, null);
assert.equal(cell.fix, "read");
assert.equal(cell.fixId, 11);

// --- End to end: the server keeps the good reading --------------------------
const PORT = 5091;
const CODE = "verify-test-code";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" },
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
const mine = staff.groups.find((x: { archived?: boolean; eligible?: boolean }) => !x.archived && x.eligible !== false);

const reading = (ee: number, n = 1) => ({
  carrier: "Nationwide",
  funding: "level funded",
  quotes_medical: true,
  matched_group: mine.name,
  confidence: 0.95,
  effective_date: "2027-01-01",
  proposal_type: "renewal",
  enrolled_on_document: mine.enrolled,
  plans: Array.from({ length: n }, (_, i) => ({ name: `Nationwide PPO ${i + 1}`, plan_code: `NW${i + 1}`, network: "Cigna", plan_type: "PPO", deductible: "$1,000", oop_max: "$5,000", benefits: {}, rates: { EE: ee + i, ES: ee * 2, EC: ee * 2, FAM: ee * 3 }, monthly_total: null })),
  total_monthly: null,
  summary: "Canned Nationwide quote.",
});
const upload = async (filename: string, body: unknown) => {
  const r = await fetch(`${base}/api/admin/proposals?filename=${encodeURIComponent(filename)}&group=${encodeURIComponent(mine.name)}&slot=Nationwide`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, await r.text());
};
const list = async () => ((await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals || []) as { id: number; filename: string; status: string; audit: unknown; extracted: unknown }[];
const settle = async (filename: string, audited = true) => {
  for (let i = 0; i < 80; i++) {
    await wait(250);
    const r = (await list()).find((x) => x.filename === filename);
    if (r && r.status !== "analyzing" && (!audited || r.audit)) return r;
  }
  throw new Error(`${filename} never settled`);
};
const check = async () => {
  const v = await (await fetch(`${base}/api/admin/proposals/verify`, { headers: auth })).json();
  return v.groups.find((x: { group: string }) => x.group === mine.name).cells.find((c: { slot: string }) => c.slot === "Nationwide");
};

await upload("nw v1.json", reading(500, 3));
const first = await settle("nw v1.json");
let c = await check();
assert.equal(c.state, "verified", JSON.stringify(c.steps));
assert.equal(c.proposalId, first.id);

// A re-upload that reads no plans (a failed or cut-off read) does not replace it.
await upload("nw v2.json", { ...reading(600), plans: [] });
await settle("nw v2.json", false);
await wait(300);
const rows = await list();
assert.ok(rows.some((r) => r.id === first.id), "the good reading is not deleted by an upload that did not read");
c = await check();
assert.equal(c.proposalId, first.id, "and it stays the one in force");
assert.equal(c.failedAt, "read");
assert.equal(c.fix, "read-waiting");
assert.equal(c.waiting.length, 1);

// The group's own page still carries the good plans.
const cookie = ((await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: mine.code }) })).headers.get("set-cookie") || "").split(";")[0];
const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
const nw = (page.proposals || []).find((p: { slot: string }) => p.slot === "Nationwide");
assert.equal(nw.id, first.id);
assert.equal(nw.plans.length, 3);

// A newer upload that does read takes over, and both older ones go.
await upload("nw v3.json", reading(700, 2));
const third = await settle("nw v3.json");
await wait(300);
const after = await list();
assert.ok(!after.some((r) => r.id === first.id), "the replaced reading is deleted once the new one reads");
assert.ok(!after.some((r) => r.filename === "nw v2.json"), "and the unread upload with it");
c = await check();
assert.equal(c.proposalId, third.id);
assert.equal(c.state, "verified");
assert.equal(c.plans, 2);

// Fix-all answers even with nothing to fix.
const fix = await (await fetch(`${base}/api/admin/proposals/fix`, { method: "POST", headers: { ...auth, ...json }, body: "{}" })).json();
assert.equal(typeof fix.reading, "number");
assert.equal((await fetch(`${base}/api/admin/proposals/fix`, { method: "POST", headers: { ...auth, ...json }, body: JSON.stringify({ id: third.id, fix: "nope" }) })).status, 400);
assert.equal((await fetch(`${base}/api/admin/proposals/verify`)).status, 401, "staff only");

console.log("proposal verify: four steps per box, counts match the client's grid, an unread upload never replaces a read one - ok");
stop();
