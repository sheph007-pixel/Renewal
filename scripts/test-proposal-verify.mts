// The four-step check behind the Proposals grid (server/proposal-verify.js),
// and the rule that a newer upload which has not read never replaces one
// that has - the Boss Logistics UHC Level Funded case, where a re-upload that
// failed to read deleted the good reading and emptied the slot.
// Runs with `node --experimental-strip-types`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { gridCounts, verifyProposals } from "../server/proposal-verify.js";
import { applyCorrection, offeredCount } from "../server/proposal-audit.js";
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
assert.deepEqual(counts.unpriced.map((p) => p.name), ["Choice Plus 2000", "Unpriced"]);
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
  audit: { status: "pass", completedAt: "2026-09-25T00:00:00Z", mismatches: [], documentPlanCount: 1 },
};
const served = (rows: typeof good[]) => () => rows.map((r) => ({ id: r.id, slot: r.slot, plans: r.extracted.plans.filter((p) => !isEpoPlan(p)).map((p) => ({ name: p.name, optionId: p.option_id, rates: p.rates })) }));
const run = (rows: unknown[], srv: () => unknown[]) =>
  verifyProposals({ groups: [{ name: "Acme", slots: ["Gravie", "Nationwide"], tiers: { EE: 1, ES: 1, EC: 1, FAM: 1 } }], rows, served: srv, isEpoPlan, isBlankPlan });

let v = run([good], served([good]));
let cell = v.groups[0].cells.find((c: { slot: string }) => c.slot === "Gravie");
assert.equal(cell.state, "verified", JSON.stringify(cell.steps));
assert.equal(cell.plans, 1, "the EPO twin is never counted");
assert.equal(v.groups[0].cells.find((c: { slot: string }) => c.slot === "Nationwide").state, "missing");
assert.deepEqual(cell.counts, { document: 1, stored: 1, grid: 1 }, "one number at every step");
assert.deepEqual(v.totals, { filed: 1, verified: 1, working: 0, failing: 0, stuck: 0, byStep: { read: 0, audited: 0, loaded: 0 } });

// Step 2: nobody has counted the plans on the document yet - audit it.
v = run([{ ...good, audit: null }], served([good]));
cell = v.groups[0].cells[0];
assert.equal(cell.state, "fail");
assert.equal(cell.failedAt, "read");
assert.equal(cell.fix, "audit");

// Step 3: a value the document contradicts - correct it against the page.
v = run([{ ...good, audit: { status: "issues", completedAt: "x", documentPlanCount: 1, mismatches: [{ plan: "Copay 1500 PPO", field: "EE", stored: "1", onDocument: "2", by: "Claude" }] } }], served([good]));
assert.equal(v.groups[0].cells[0].failedAt, "audited");
assert.equal(v.groups[0].cells[0].fix, "correct");

// Step 3: the document has more plans than the database - correct (add them).
v = run([{ ...good, audit: { ...good.audit, documentPlanCount: 3 } }], served([good]));
assert.equal(v.groups[0].cells[0].failedAt, "audited");
assert.equal(v.groups[0].cells[0].fix, "correct");
assert.match(v.groups[0].cells[0].steps.audited.note, /document has 3 plans; the database has 1/);

// Step 4: served to the group short of what is stored - rebuild.
v = run([good], () => [{ id: 10, slot: "Gravie", plans: [] }]);
assert.equal(v.groups[0].cells[0].failedAt, "loaded");
assert.equal(v.groups[0].cells[0].fix, "refresh");

// Step 4: a plan missing a tier rate the group needs - correct (read the rate),
// unless the document itself leaves that tier unpriced.
const noEs = { ...good, extracted: { plans: [{ name: "Copay 1500 PPO", option_id: "GR1", rates: { EE: 1, ES: null, EC: 3, FAM: 4 } }] } };
v = run([noEs], served([noEs]));
assert.equal(v.groups[0].cells[0].failedAt, "loaded");
assert.equal(v.groups[0].cells[0].fix, "correct");
const confirmed = { ...good, extracted: { plans: [{ name: "Copay 1500 PPO", option_id: "GR1", rates: { EE: 1, ES: null, EC: 3, FAM: 4 }, unpriced: ["ES"] }] } };
v = run([confirmed], () => [{ id: 10, slot: "Gravie", plans: [{ name: "Copay 1500 PPO", rates: { EE: 1, ES: null, EC: 3, FAM: 4 }, unpriced: ["ES"] }] }]);
assert.equal(v.groups[0].cells[0].state, "verified", "a tier the carrier does not price is not a failure once confirmed");

// The steward has run out of repairs: the box needs a person, and says why.
v = verifyProposals({ groups: [{ name: "Acme", slots: ["Gravie"], tiers: {} }], rows: [{ ...good, audit: null }], served: served([good]), isEpoPlan, isBlankPlan, gaveUp: () => "tried twice" });
assert.equal(v.groups[0].cells[0].state, "stuck");
assert.equal(v.groups[0].cells[0].stuck, "tried twice");

// A newer upload that failed to read, waiting beside the good one.
const failed = { ...good, id: 11, extracted: null, audit: null, error: "This proposal is longer than one reading can hold", filename: "acme gravie v2.pdf" };
v = run([failed, good], served([good]));
cell = v.groups[0].cells[0];
assert.equal(cell.proposalId, 10, "the good reading stays in force");
assert.equal(cell.state, "fail");
assert.equal(cell.failedAt, "read");
assert.equal(cell.fix, "read");
assert.equal(cell.fixId, 11);
assert.equal(cell.waiting.length, 1);

// Only a failed upload in the slot: nothing in force.
v = run([failed], () => []);
cell = v.groups[0].cells[0];
assert.equal(cell.proposalId, null);
assert.equal(cell.fix, "read");
assert.equal(cell.fixId, 11);

// --- Corrections: applied exactly, logged, repeats and EPO kept out ---------
const reading0 = {
  plans: [
    { name: "Choice Plus 1000", option_id: "UH1", rates: { EE: 600, ES: 1200, EC: 1100, FAM: null }, deductible: "$1,000", benefits: { rx: "$10" } },
    { name: "Choice Plus 2000", option_id: "UH2", rates: { EE: 500, ES: 1000, EC: 900, FAM: 1500 } },
    { name: "Not On Paper", option_id: "UH3", rates: { EE: 1, ES: 1, EC: 1, FAM: 1 } },
  ],
};
assert.equal(offeredCount(reading0), 3);
const fixed = applyCorrection(reading0, {
  fixes: [
    { index: 0, field: "EE", verdict: "fix", value: "$612.45" },
    { index: 0, field: "deductible", verdict: "fix", value: "$1,500" },
    { index: 0, field: "rx", verdict: "fix", value: "$15" },
    { index: 1, field: "ES", verdict: "stored_is_correct", value: "" },
  ],
  add: [
    { name: "Choice Plus 3000", rates: { EE: 450, ES: 900, EC: 800, FAM: 1300 } },
    { name: "Choice Plus 3000 EPO", rates: { EE: 400, ES: 800, EC: 700, FAM: 1200 } },
    { name: "Choice Plus 2000", rates: { EE: 500, ES: 1000, EC: 900, FAM: 1500 } },
  ],
  remove: [2],
  unpriced: [{ index: 0, tier: "FAM" }],
});
assert.deepEqual(fixed.extracted.plans.map((p) => p.name), ["Choice Plus 1000", "Choice Plus 2000", "Choice Plus 3000"], "wrong plan out, missing plan in, EPO and repeats never added");
assert.equal(fixed.extracted.plans[0].rates.EE, 612.45);
assert.equal(fixed.extracted.plans[0].deductible, "$1,500");
assert.equal(fixed.extracted.plans[0].benefits.rx, "$15");
assert.deepEqual(fixed.extracted.plans[0].unpriced, ["FAM"]);
assert.equal(fixed.extracted.plans[0].option_id, "UH1", "a plan keeps its number through a correction");
assert.equal(fixed.log.length, 6, "every change logged: 3 values, 1 unpriced tier, 1 removed, 1 added");
assert.equal(reading0.plans[0].rates.EE, 600, "the stored reading is not mutated");

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
assert.equal(c.waiting.length, 1);
// The steward reads the unread upload again, twice, then hands it to a person.
for (let i = 0; i < 80 && c.state !== "stuck"; i++) {
  await wait(250);
  c = await check();
}
assert.equal(c.state, "stuck", JSON.stringify(c));
assert.match(c.stuck, /would not read into plans in 2 tries/);
assert.equal(c.proposalId, first.id, "the good reading is still in force");

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

assert.deepEqual(c.counts, { document: 2, stored: 2, grid: 2 });
assert.ok((await fetch(`${base}/api/admin/proposals/fix`, { method: "POST", headers: auth })).ok, "staff can ask the steward to try again");
assert.equal((await fetch(`${base}/api/admin/proposals/verify`)).status, 401, "staff only");

console.log("proposal verify: four steps per box, one plan count at every step, corrections applied and logged, the steward repairs or hands over, an unread upload never replaces a read one - ok");
stop();
