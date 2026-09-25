// The client plan universe, end to end (canned reader and auditors,
// KENNION_FAKE_AI). Runs with `node --experimental-strip-types`.
//  1. A proposal quoting 100 medical plans - PPO, EPO, LocalPlus, HMO, HSA,
//     every deductible - has 100 stored, 100 audited by each model, and 100
//     on the client's Medical Plans grid and in the assistant's figures, with
//     the exact stored values. Nothing is hidden by network or plan type.
//  2. Kennion turns the proposal slot OFF for the group: the client sees none
//     of its plans (grid, payload, assistant), while all 100 stay stored,
//     audited and Verified, and staff still see them.
//  3. The setting is kept apart from the proposal: a re-read of the slot
//     leaves it OFF. Turned back ON, all 100 are shown again.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { proposalPlans, type KennionData, type Group } from "../client/src/lib/model.ts";
import { describeGroup } from "../server/assistant.js";
import { EMPTY_FILTERS, matches, type PlanFilters } from "../client/src/lib/planfilters.ts";

const PORT = 5097;
const CODE = "client-plans-code";
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
const g = staff.groups.find((x: { archived?: boolean; eligible?: boolean }) => !x.archived && x.eligible !== false);
const cookie = ((await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: g.code }) })).headers.get("set-cookie") || "").split(";")[0];
const SLOT = "Nationwide";

// 100 quoted plans across every network and plan type.
const NETS = ["Cigna Open Access Plus (PPO)", "Cigna Open Access Plus (EPO)", "Cigna LocalPlus (PPO)", "Cigna HMO", "Choice Plus"];
const plans = Array.from({ length: 100 }, (_, i) => ({
  name: `Nationwide ${NETS[i % 5].includes("EPO") ? "EPO" : NETS[i % 5].includes("HMO") ? "HMO" : "Plan"} ${1000 + i * 50}${i % 7 === 0 ? " HSA" : ""}`,
  plan_code: `NWP${String(i + 1).padStart(3, "0")}`,
  network: NETS[i % 5],
  plan_type: NETS[i % 5].includes("EPO") ? "EPO" : NETS[i % 5].includes("HMO") ? "HMO" : "PPO",
  deductible: `$${1000 + i * 50}`,
  oop_max: `$${6000 + i * 25}`,
  benefits: { doctor_visit: `$${20 + (i % 5) * 5}`, specialist: "$60", imaging: "", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10 / $40 / $80", coinsurance: "20%", hsa_eligible: i % 7 === 0 ? "yes" : "no" },
  rates: { EE: 400 + i, ES: 900 + i, EC: 800 + i, FAM: 1300 + i },
  monthly_total: null,
}));
const reading = { carrier: "Nationwide", funding: "level funded", quotes_medical: true, matched_group: g.name, confidence: 0.95, effective_date: "2027-01-01", proposal_type: "renewal", enrolled_on_document: g.enrolled, plans, total_monthly: null, summary: "Canned 100-plan quote." };
const up = await fetch(`${base}/api/admin/proposals?filename=nw100.json&group=${encodeURIComponent(g.name)}&slot=${SLOT}`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: JSON.stringify(reading) });
assert.equal(up.status, 200, await up.text());

const cellNow = async () => (await (await fetch(`${base}/api/admin/proposals/verify`, { headers: auth })).json()).groups.find((x: { group: string }) => x.group === g.name).cells.find((c: { slot: string }) => c.slot === SLOT);
const page = async () => (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
const until = async <T>(fn: () => Promise<T>, ok: (x: T) => boolean, what: string): Promise<T> => {
  let x: T;
  for (let i = 0; i < 160; i++) {
    x = await fn();
    if (ok(x)) return x;
    await wait(250);
  }
  throw new Error(`${what} never happened: ${JSON.stringify(x!).slice(0, 400)}`);
};

// 1. 100 in the source = 100 stored = 100 audited = 100 on the grid and in the assistant.
let cell = await until(cellNow, (c) => c && c.state === "verified", "Verified");
const row = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals.find((r: { id: number }) => r.id === cell.proposalId);
assert.equal(row.extracted.plans.length, 100, "100 stored");
assert.ok(row.audit.models.length === 2 && row.audit.models.every((m: { verdict: string; confirmed: number; of: number }) => m.verdict === "pass" && m.confirmed === 100 && m.of === 100), "100 audited by Claude and 100 by OpenAI (4 batches each)");
assert.ok(row.audit.models.every((m: { batches: unknown[] }) => m.batches.length === 4));
assert.deepEqual([cell.counts.document, cell.counts.stored, cell.counts.grid, cell.counts.client], [100, 100, 100, 100], "document = database = grid = client");
assert.equal(cell.clientEnabled, true);

let pg = await page();
const pr = pg.proposals.find((p: { slot: string }) => p.slot === SLOT);
assert.equal(pr.plans.length, 100, "all 100 in the client payload");
// The exact stored values, plan by plan, matched by identity.
const byCode = new Map(row.extracted.plans.map((p: { plan_code: string }) => [p.plan_code, p]));
for (const pl of pr.plans) {
  const st = byCode.get(pl.planCode) as { name: string; network: string; option_id: string; rates: object; deductible: string; oop_max: string };
  assert.ok(st, `${pl.planCode} is a stored plan`);
  assert.deepEqual([pl.name, pl.network, pl.optionId, pl.rates, pl.deductible, pl.oopMax], [st.name, st.network, st.option_id, st.rates, st.deductible, st.oop_max]);
}
assert.equal(new Set(pr.plans.map((p: { identity: string }) => p.identity)).size, 100, "no duplicates");
const epo = pr.plans.filter((p: { network: string }) => /EPO/.test(p.network)).length;
const localPlus = pr.plans.filter((p: { network: string }) => /LocalPlus/.test(p.network)).length;
assert.deepEqual([epo, localPlus], [20, 20], "EPO and LocalPlus plans shown like any other");
// The client's grid (the same function the page renders from) shows all 100.
const grid = proposalPlans(pg as unknown as KennionData, pg.group as unknown as Group).filter((p) => p.quoted?.slot === SLOT);
assert.equal(grid.length, 100, "100 rows on the Medical Plans grid");
assert.equal(grid.filter((p) => p.hsa === true).length, 15, "HSA read through for the grid's HSA filter");
// The grid's filters narrow the 100 without removing any: HSA only, one
// named network, one proposal (the same facets the grid builds per row).
const facets = grid.map((p) => ({ carrier: p.carrier, network: "", netname: p.networkExact || p.network, hsa: p.hsa === true ? "HSA eligible" : p.hsa === false ? "Not HSA eligible" : "Not stated", slot: p.quoted?.slot || "-", funding: "", ded: null, oop: null, bill: p.monthly }));
const f = (over: Partial<PlanFilters>) => facets.filter((x) => matches(x as never, { ...EMPTY_FILTERS, ...over })).length;
assert.equal(f({}), 100, "no filter: all 100");
assert.equal(f({ hsas: ["HSA eligible"] }), 15);
assert.equal(f({ netnames: ["Cigna LocalPlus (PPO)"] }), 20);
assert.equal(f({ slots: [SLOT] }), 100);
assert.equal(f({ hsas: ["HSA eligible"], netnames: ["Choice Plus"] }), grid.filter((p) => p.hsa === true && p.networkExact === "Choice Plus").length);

// The assistant is handed the same 100 records.
const said = describeGroup({ group: pg.group, proposals: pg.proposals } as never);
assert.match(said, /100 plans on this quote - exactly the 100 on the client's Medical Plans grid/);
assert.equal((said.match(/\[NWP\d{3}\]/g) || []).length, 100, "every plan, by its code, in the assistant's figures");

// 2. The slot OFF for this group: none shown to the client; all 100 still stored, audited, Verified.
let r = await fetch(`${base}/api/admin/proposal-slots`, { method: "POST", headers: { ...auth, ...json }, body: JSON.stringify({ group: g.name, slot: SLOT, clientEnabled: false }) });
assert.equal(r.status, 200, await r.text());
cell = await until(cellNow, (c) => c && c.clientEnabled === false, "slot OFF");
assert.equal(cell.state, "verified", "still Verified: turning a slot OFF is a presentation choice");
assert.deepEqual([cell.counts.stored, cell.counts.grid, cell.counts.client], [100, 100, 0]);
pg = await page();
assert.ok(!pg.proposals.some((p: { slot: string }) => p.slot === SLOT), "the client payload carries none of its plans");
assert.equal(proposalPlans(pg as unknown as KennionData, pg.group as unknown as Group).filter((p) => p.quoted?.slot === SLOT).length, 0, "0 rows on the grid");
assert.doesNotMatch(describeGroup({ group: pg.group, proposals: pg.proposals } as never), /NWP001/, "and none in the assistant's figures");
const still = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals.find((x: { id: number }) => x.id === row.id);
assert.equal(still.extracted.plans.length, 100, "all 100 still stored");
assert.equal(still.audit.status, "pass", "and still audited");
const slots = (await (await fetch(`${base}/api/admin/proposal-slots`, { headers: auth })).json()).slots;
assert.deepEqual(slots.map((s: { groupName: string; slot: string; clientEnabled: boolean; updatedBy: string }) => [s.groupName, s.slot, s.clientEnabled, s.updatedBy]), [[g.name, SLOT, false, "hunter@kennion.com"]], "kept per group and slot, with who set it");

// 3. A re-read of the slot leaves the setting alone.
assert.equal((await fetch(`${base}/api/admin/proposals/${row.id}/analyze`, { method: "POST", headers: auth })).status, 200);
await wait(1500);
cell = await until(cellNow, (c) => c && c.state === "verified", "Verified after the re-read");
assert.equal(cell.clientEnabled, false, "a re-read never turns a slot back ON");
assert.ok(!(await page()).proposals.some((p: { slot: string }) => p.slot === SLOT));
// Back ON: all 100 again.
r = await fetch(`${base}/api/admin/proposal-slots`, { method: "POST", headers: { ...auth, ...json }, body: JSON.stringify({ group: g.name, slot: SLOT, clientEnabled: true }) });
assert.equal(r.status, 200);
pg = await until(page, (p) => (p.proposals.find((x: { slot: string }) => x.slot === SLOT)?.plans.length || 0) === 100, "all 100 back");
assert.equal((await fetch(`${base}/api/admin/proposal-slots`, { method: "POST", headers: json, body: JSON.stringify({ group: g.name, slot: SLOT, clientEnabled: false }) })).status, 401, "staff only");

console.log("client plans: 100 quoted = 100 stored = 100 audited = 100 on the grid and in the assistant, EPO and LocalPlus included; a slot OFF shows none while all stay stored, audited and Verified; the setting survives a re-read - ok");
stop();
